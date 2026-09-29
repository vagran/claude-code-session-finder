import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyTail, readTailInfo, resolveState, pickMainFile, effectiveMtime, DEFAULT_THRESHOLDS } from '../src/core/state.js';
import { readTail, readVerdict, TAIL_WINDOW } from '../src/core/tail-io.js';
import type { SourceFile } from '../src/core/discover.js';

const line = (o: unknown) => JSON.stringify(o);
const assistant = (stop_reason: string | null, extra: object = {}) =>
  line({ type: 'assistant', message: { stop_reason, content: [{ type: 'text', text: 'x' }] }, ...extra });
const user = (extra: object = {}) => line({ type: 'user', message: { content: 'go' }, ...extra });
const system = (subtype: string) => line({ type: 'system', subtype });
// The sidecars Claude Code appends AFTER conversational records (spec L3, §2 table).
const sidecars = [
  line({ type: 'last-prompt', prompt: 'x' }), line({ type: 'atis-latch' }), line({ type: 'mode', mode: 'auto' }),
  line({ type: 'cost-state' }), line({ type: 'pr-link', prNumber: 1 }), line({ type: 'ai-title', aiTitle: 't' }),
  line({ type: 'artifact-comment-monitor' }), line({ type: 'queue-operation', operation: 'x' }),
].join('\n');

describe('classifyTail', () => {
  it('skips sidecars and reads the last conversational record (L3)', () => {
    expect(classifyTail([assistant('end_turn'), sidecars].join('\n'))).toBe('turn-ended');
    expect(classifyTail([assistant('tool_use'), sidecars].join('\n'))).toBe('awaiting-tool');
    expect(classifyTail([user(), sidecars].join('\n'))).toBe('awaiting-model');
  });
  it('maps every verdict (L4, L5)', () => {
    expect(classifyTail(assistant('end_turn'))).toBe('turn-ended');
    expect(classifyTail(assistant('tool_use'))).toBe('awaiting-tool');
    expect(classifyTail(assistant(null))).toBe('awaiting-model');          // still streaming
    expect(classifyTail(assistant('max_tokens'))).toBe('awaiting-model');  // Claude Code continues
    expect(classifyTail(user())).toBe('awaiting-model');                    // prompt
    expect(classifyTail(line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })))
      .toBe('awaiting-model');                                              // tool result
    expect(classifyTail(system('turn_duration'))).toBe('turn-ended');
    expect(classifyTail(system('away_summary'))).toBe('turn-ended');
    expect(classifyTail(system('local_command'))).toBe('turn-ended');
  });
  it('looks past a transcript-only notice — a resume writes stale task notices that start no turn', () => {
    // The shape Claude Code 2.1.283 appends when it resumes a session whose background tasks never finished.
    const notice = user({ message: { role: 'user', content: '<task-notification>\n<status>stopped</status>\n</task-notification>' },
                          origin: { kind: 'task-notification' }, promptSource: 'system', queueTranscriptOnly: true });
    expect(classifyTail([assistant('end_turn'), system('turn_duration'), notice, sidecars].join('\n'))).toBe('turn-ended');
    expect(classifyTail([assistant('tool_use'), notice].join('\n'))).toBe('awaiting-tool');
    // a notice without the flag is delivered to the model, which answers it: that is a running turn
    expect(classifyTail([assistant('end_turn'), user({ message: { content: '<task-notification>done</task-notification>' } })].join('\n')))
      .toBe('awaiting-model');
  });
  it('an interruption is its own verdict — Esc writes a user message, but nothing is generating', () => {
    expect(classifyTail(line({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }))).toBe('interrupted');
    expect(classifyTail(line({ type: 'user', message: { content: '[Request interrupted by user for tool use]' } }))).toBe('interrupted');
    expect(classifyTail([line({ type: 'user', message: { content: '[Request interrupted by user]' } }), sidecars].join('\n'))).toBe('interrupted');
    expect(classifyTail(line({ type: 'user', message: { content: 'please do not [Request interrupted by user] literally' } }))).toBe('awaiting-model');
  });
  it('a pending AskUserQuestion is awaiting-answer, not a slow tool', () => {
    const ask = line({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'AskUserQuestion', input: {} }] } });
    expect(classifyTail(ask)).toBe('awaiting-answer');
    expect(classifyTail([ask, sidecars].join('\n'))).toBe('awaiting-answer');
    expect(classifyTail(line({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }))).toBe('awaiting-tool');
  });
  it('a plan waiting for approval (ExitPlanMode) is a question too: Claude cannot go on without you', () => {
    const plan = line({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Here is the plan.' }, { type: 'tool_use', id: 't', name: 'ExitPlanMode', input: { plan: '1. …' } }] } });
    expect(classifyTail(plan)).toBe('awaiting-answer');
  });
  it('a system record that is not a turn boundary is skipped, not a verdict', () => {
    expect(classifyTail([assistant('tool_use'), system('compact_boundary')].join('\n'))).toBe('awaiting-tool');
  });
  it('skips sidechain records — a subagent finishing is not the main loop finishing', () => {
    expect(classifyTail([assistant('tool_use'), assistant('end_turn', { isSidechain: true })].join('\n')))
      .toBe('awaiting-tool');
  });
  it('skips a truncated last line (a write in progress) and blank lines', () => {
    expect(classifyTail([assistant('end_turn'), '{"type":"assistant","mess', ''].join('\n'))).toBe('turn-ended');
  });
  it('returns unknown when nothing conversational is present', () => {
    expect(classifyTail('')).toBe('unknown');
    expect(classifyTail(sidecars)).toBe('unknown');
  });
});

describe('readTailInfo — context size alongside the verdict', () => {
  const withUsage = (stop: string | null, usage: object, model = 'claude-opus-5') =>
    line({ type: 'assistant', message: { stop_reason: stop, model, content: [{ type: 'text', text: 'x' }], usage } });
  it('sums input + cache-read + cache-creation of the newest assistant record, even when the tail is a user record', () => {
    const t = readTailInfo([withUsage('tool_use', { input_tokens: 32, cache_creation_input_tokens: 2_023, cache_read_input_tokens: 558_189, output_tokens: 859 }, 'claude-fable-5-1'),
                            user(), sidecars].join('\n'));
    expect(t).toEqual({ verdict: 'awaiting-model', contextTokens: 560_244, model: 'claude-fable-5-1' });
  });
  it('prefers the newest usage, and a record without usage adds nothing', () => {
    const t = readTailInfo([withUsage('tool_use', { cache_read_input_tokens: 100_000 }), withUsage('end_turn', { input_tokens: 5, cache_read_input_tokens: 120_000 })].join('\n'));
    expect(t).toMatchObject({ verdict: 'turn-ended', contextTokens: 120_005 });
    expect(readTailInfo(assistant('end_turn'))).toEqual({ verdict: 'turn-ended' });
  });
});

describe('resolveState (spec §7 table)', () => {
  const t = DEFAULT_THRESHOLDS;
  it('turn-ended is your turn regardless of quiet time', () => {
    expect(resolveState('turn-ended', 0, t)).toEqual({ kind: 'attention', reason: 'your-turn' });
    expect(resolveState('turn-ended', 10 * 3_600_000, t)).toEqual({ kind: 'attention', reason: 'your-turn' });
  });
  it('a question and an interruption need you at once, however fresh', () => {
    expect(resolveState('awaiting-answer', 0, t)).toEqual({ kind: 'attention', reason: 'question' });
    expect(resolveState('interrupted', 0, t)).toEqual({ kind: 'attention', reason: 'interrupted' });
  });
  it('awaiting-tool flips at toolQuietMs', () => {
    expect(resolveState('awaiting-tool', t.toolQuietMs - 1, t)).toEqual({ kind: 'running' });
    expect(resolveState('awaiting-tool', t.toolQuietMs, t)).toEqual({ kind: 'attention', reason: 'tool-or-permission' });
  });
  it('a command still running keeps awaiting-tool running past toolQuietMs — work, not a permission prompt', () => {
    expect(resolveState('awaiting-tool', 10 * t.toolQuietMs, t, { toolRunning: true })).toEqual({ kind: 'running' });
    expect(resolveState('awaiting-tool', 10 * t.toolQuietMs, t, { toolRunning: false })).toEqual({ kind: 'attention', reason: 'tool-or-permission' });
    expect(resolveState('turn-ended', 0, t, { toolRunning: true })).toEqual({ kind: 'attention', reason: 'your-turn' });   // only awaiting-tool listens
  });
  it('a finished turn with background tasks running is running in the background, however long ago', () => {
    expect(resolveState('turn-ended', 3_600_000, t, { background: true })).toEqual({ kind: 'running', background: true });
    expect(resolveState('interrupted', 0, t, { background: true })).toEqual({ kind: 'attention', reason: 'interrupted' });   // Esc still needs you
  });
  it("the registry's status settles a pending tool call: waiting rings at once, busy keeps the spinner", () => {
    expect(resolveState('awaiting-tool', 1_000, t, { status: 'waiting' })).toEqual({ kind: 'attention', reason: 'tool-or-permission' });
    expect(resolveState('awaiting-tool', 1_000, t, { status: 'waiting', toolRunning: true })).toEqual({ kind: 'attention', reason: 'tool-or-permission' });
    expect(resolveState('awaiting-tool', 10 * t.toolQuietMs, t, { status: 'busy' })).toEqual({ kind: 'running' });   // an MCP call, a web fetch
    expect(resolveState('awaiting-tool', 10 * t.toolQuietMs, t, { status: 'idle' })).toEqual({ kind: 'attention', reason: 'tool-or-permission' });
  });
  it('awaiting-model stays running through a long generation and flips at stalledMs (L5)', () => {
    expect(resolveState('awaiting-model', 130_000, t)).toEqual({ kind: 'running' });   // the proof case
    expect(resolveState('awaiting-model', t.stalledMs - 1, t)).toEqual({ kind: 'running' });
    expect(resolveState('awaiting-model', t.stalledMs, t)).toEqual({ kind: 'attention', reason: 'stalled' });
  });
  it('unknown reads like awaiting-model: recency put the session in ACTIVE, the verdict only refines it', () => {
    expect(resolveState('unknown', 0, t)).toEqual({ kind: 'running' });
    expect(resolveState('unknown', t.stalledMs, t)).toEqual({ kind: 'attention', reason: 'stalled' });
  });
  it('honours custom thresholds', () => {
    expect(resolveState('awaiting-tool', 5_000, { toolQuietMs: 4_000, stalledMs: 1 }))
      .toEqual({ kind: 'attention', reason: 'tool-or-permission' });
  });
});

const sf = (o: Partial<SourceFile>): SourceFile =>
  ({ path: '/p/-w/a.jsonl', sessionId: 'a', projectDir: '-w', kind: 'session', mtimeMs: 1, size: 1, ...o });

describe('pickMainFile / effectiveMtime', () => {
  it('picks the newest MAIN copy; subagents never supply the verdict (L8)', () => {
    const files = [
      sf({ path: '/p/-w/a.jsonl', mtimeMs: 100 }),
      sf({ path: '/p/-w2/a.jsonl', mtimeMs: 300 }),                    // moved worktree: newer copy
      sf({ path: '/p/-w2/a/subagents/x.jsonl', kind: 'subagent', mtimeMs: 900 }),
    ];
    expect(pickMainFile(files)?.path).toBe('/p/-w2/a.jsonl');
  });
  it('returns undefined when only subagent files remain', () => {
    expect(pickMainFile([sf({ kind: 'subagent' })])).toBeUndefined();
  });
  it('effective mtime includes subagent activity (L7)', () => {
    expect(effectiveMtime([sf({ mtimeMs: 100 }), sf({ kind: 'subagent', mtimeMs: 900 })])).toBe(900);
    expect(effectiveMtime([])).toBe(0);
  });
});

describe('readTail / readVerdict', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'ccsf-state-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('returns the whole file when it fits the window', async () => {
    const f = join(dir, 'small.jsonl');
    const text = [assistant('end_turn'), sidecars].join('\n') + '\n';
    writeFileSync(f, text);
    expect(await readTail(f, statSync(f).size)).toBe(text);
  });
  it('drops the partial first line when the file is longer than the window (L9)', async () => {
    const f = join(dir, 'big.jsonl');
    const filler = line({ type: 'user', message: { content: 'z'.repeat(1000) } });
    const text = Array.from({ length: 80 }, () => filler).join('\n') + '\n' + assistant('tool_use') + '\n';
    writeFileSync(f, text);
    const size = statSync(f).size;
    expect(size).toBeGreaterThan(TAIL_WINDOW);
    const tail = await readTail(f, size);
    expect(tail.length).toBeLessThan(TAIL_WINDOW);
    expect(tail.startsWith('{')).toBe(true);                    // no half line at the top
    expect(classifyTail(tail)).toBe('awaiting-tool');
  });
  it('readVerdict widens once when the 64 KB window holds no conversational record', async () => {
    const f = join(dir, 'sidecar-heavy.jsonl');
    const sidecar = line({ type: 'artifact-autoreact-ledger', blob: 'y'.repeat(2000) });
    writeFileSync(f, assistant('end_turn') + '\n' + Array.from({ length: 40 }, () => sidecar).join('\n') + '\n');
    const size = statSync(f).size;
    expect(size).toBeGreaterThan(TAIL_WINDOW);
    const reads: number[] = [];
    const spy = (p: string, s: number, w?: number) => { reads.push(w ?? TAIL_WINDOW); return readTail(p, s, w); };
    expect(await readVerdict(f, size, spy)).toBe('turn-ended');
    expect(reads).toEqual([65_536, 524_288]);
  });
  it('readVerdict keeps widening — to the whole file — when one huge record hides the last conversational one', async () => {
    // A 700 KB tool_result (one screenshot read as an image) followed by sidecars: the 64 KB and 512 KB
    // windows both start inside that record, drop it as a partial line, and see only sidecars.
    const f = join(dir, 'image-heavy.jsonl');
    const huge = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(700_000) }] } });
    const sidecar = line({ type: 'attachment', blob: 'y'.repeat(200) });
    writeFileSync(f, assistant('tool_use') + '\n' + huge + '\n' + sidecar + '\n' + sidecar + '\n');
    const size = statSync(f).size;
    const reads: number[] = [];
    const spy = (p: string, s: number, w?: number) => { reads.push(w ?? TAIL_WINDOW); return readTail(p, s, w); };
    expect(await readVerdict(f, size, spy)).toBe('awaiting-model');
    expect(reads).toEqual([65_536, 524_288, 2_097_152]);           // 2 MB covers the 700 KB file: stop there
  });
  it('an empty file is unknown without opening a read of zero bytes', async () => {
    const f = join(dir, 'empty.jsonl');
    writeFileSync(f, '');
    expect(await readVerdict(f, 0)).toBe('unknown');
  });
});

describe('readTailInfo — when the conversation last moved', () => {
  it('takes the timestamp of the verdict record; the sidecars a mere resume appends do not count', () => {
    const t = readTailInfo([assistant('end_turn', { timestamp: '2026-09-23T01:00:00.000Z' }),
      line({ type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-09-23T01:00:05.000Z' }), sidecars].join('\n'));
    expect(t).toMatchObject({ verdict: 'turn-ended', lastTs: Date.parse('2026-09-23T01:00:00.000Z') });
    expect(readTailInfo(assistant('end_turn'))).toEqual({ verdict: 'turn-ended' });                 // no timestamp: nothing claimed
    expect(readTailInfo([user({ timestamp: 'garbage' }), sidecars].join('\n')).lastTs).toBeUndefined();
  });
});
