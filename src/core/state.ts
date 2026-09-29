import type { SourceFile } from './discover.js';

/** What the last conversational record says, independent of time (spec §6). */
export type TailVerdict =
  | 'turn-ended'      // assistant end_turn, or system turn_duration | away_summary | local_command
  | 'awaiting-tool'   // assistant tool_use — a tool is running OR a permission prompt is showing
  | 'awaiting-answer' // assistant tool_use of AskUserQuestion — Claude asked you something
  | 'awaiting-model'  // user (prompt or tool_result), or an assistant record that is still streaming
  | 'interrupted'     // user "[Request interrupted by user]" — you stopped it; nothing runs
  | 'unknown';        // nothing conversational in the window

export type AttentionReason = 'tool-or-permission' | 'question' | 'your-turn' | 'interrupted' | 'stalled';
/** `background`: the turn ended, but the session's background tasks run on and will wake it (processes.ts). */
export type LiveState = { kind: 'running'; background?: true } | { kind: 'attention'; reason: AttentionReason };

export interface Thresholds { toolQuietMs: number; stalledMs: number }
export const DEFAULT_THRESHOLDS: Thresholds = { toolQuietMs: 60_000, stalledMs: 900_000 };

export interface Liveness {
  sessionId: string;
  verdict: TailVerdict;
  state: LiveState;
  /**
   * When something last HAPPENED: the timestamp of the last conversational record (a prompt, a reply,
   * a turn boundary), or a subagent file's mtime if newer (L7). Not the main file's mtime — merely
   * opening a session appends sidecars (cost-state, mode, last-prompt…) and that is not activity.
   */
  lastWriteMs: number;
  /** context the model was last given: input + cache-read + cache-creation tokens of the newest assistant record */
  contextTokens?: number;
  model?: string;
  /** quiet for longer than the active window — ACTIVE only because its tab is open (D12); it sorts below everything live */
  parked?: true;
}

/** Everything the tail of a transcript tells us in one read. `lastTs`: when the verdict record was written. */
export interface TailInfo { verdict: TailVerdict; contextTokens?: number; model?: string; lastTs?: number }

const CONVERSATIONAL = new Set(['user', 'assistant', 'system']);
/** system subtypes that end a turn. Others (e.g. compact_boundary) are not boundaries and are skipped. */
const TURN_BOUNDARY = new Set(['turn_duration', 'away_summary', 'local_command']);

interface Usage { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
interface Rec { type?: string; subtype?: string; isSidechain?: boolean; queueTranscriptOnly?: boolean; timestamp?: string; message?: { stop_reason?: string | null; content?: unknown; usage?: Usage; model?: string } }

/** Esc in Claude Code writes this as a user message; the loop is over until you type again. */
const INTERRUPTED = /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b): b is { type: 'text'; text: string } => isObj(b) && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
}
/** AskUserQuestion, or ExitPlanMode — a plan waiting for approval: either way Claude cannot go on without you. */
const asksQuestion = (content: unknown): boolean =>
  Array.isArray(content) && content.some(b => isObj(b) && b.type === 'tool_use' && (b.name === 'AskUserQuestion' || b.name === 'ExitPlanMode'));

function parse(line: string): Rec | null {
  try { return JSON.parse(line) as Rec; } catch { return null; }   // a write in progress is normal
}

const contextOf = (u: Usage | undefined): number =>
  u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : 0;

/**
 * L3: walk backwards past the sidecars to the last conversational record; L4/L5: read its verdict.
 * On the way, the newest assistant record with usage gives the context size — what every further
 * turn costs — so the walk continues past the verdict record until it has both.
 */
export function readTailInfo(text: string): TailInfo {
  const lines = text.split('\n');
  const info: TailInfo = { verdict: 'unknown' };
  let verdict: TailVerdict | null = null;
  for (let i = lines.length - 1; i >= 0 && !(verdict !== null && info.contextTokens !== undefined); i--) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    const d = parse(raw);
    if (!d || !d.type || !CONVERSATIONAL.has(d.type) || d.isSidechain === true) continue;
    // Written for the record only, never sent to the model: a resume delivers stale background-task
    // notices this way ("2 background shell command tasks didn't finish before the previous session
    // ended"). No turn starts, so it is not a prompt the model is working on — look past it.
    if (d.queueTranscriptOnly === true) continue;
    if (d.type === 'assistant') {
      if (info.contextTokens === undefined) {
        const n = contextOf(d.message?.usage);
        if (n > 0) { info.contextTokens = n; if (typeof d.message?.model === 'string') info.model = d.message.model; }
      }
      if (verdict !== null) continue;
      stamp(d);
      const stop = d.message?.stop_reason;
      if (stop === 'end_turn') verdict = 'turn-ended';
      else if (stop === 'tool_use') verdict = asksQuestion(d.message?.content) ? 'awaiting-answer' : 'awaiting-tool';
      else verdict = 'awaiting-model';       // null (streaming), max_tokens, stop_sequence: the loop continues
      continue;
    }
    if (verdict !== null) continue;
    if (d.type === 'system') {
      if (d.subtype && TURN_BOUNDARY.has(d.subtype)) { verdict = 'turn-ended'; stamp(d); }
      continue;
    }
    stamp(d);
    verdict = INTERRUPTED.test(textOf(d.message?.content)) ? 'interrupted' : 'awaiting-model';   // user: prompt, tool_result, or Esc
  }
  info.verdict = verdict ?? 'unknown';
  return info;

  /** The verdict record's own timestamp — when the conversation last moved. Sidecars never get here. */
  function stamp(d: Rec): void {
    if (info.lastTs !== undefined || typeof d.timestamp !== 'string') return;
    const t = Date.parse(d.timestamp);
    if (Number.isFinite(t)) info.lastTs = t;
  }
}

export const classifyTail = (text: string): TailVerdict => readTailInfo(text).verdict;

/**
 * Spec §7 table. `turn-ended` ignores quiet time on purpose. `unknown` — a tail with nothing
 * conversational, which a written-moments-ago file can still have — is read like `awaiting-model`:
 * recency decided the session is ACTIVE, and the verdict only refines how it shows.
 * `toolRunning`: the pending tool call's command is running (processes.ts toolRunning). A long
 * command is work, not a permission prompt, so it keeps the spinner past the quiet threshold.
 * `background`: the session's background tasks are running. A finished turn is then a pause in work
 * that goes on — each task event starts a turn of its own — so it is not your turn: it shows as
 * running, in the background, and does not ring.
 */
export function resolveState(
  verdict: TailVerdict, quietMs: number, t: Thresholds = DEFAULT_THRESHOLDS, toolRunning = false, background = false,
): LiveState {
  switch (verdict) {
    case 'turn-ended':     return background ? { kind: 'running', background: true } : { kind: 'attention', reason: 'your-turn' };
    case 'awaiting-answer': return { kind: 'attention', reason: 'question' };
    case 'interrupted':    return { kind: 'attention', reason: 'interrupted' };
    case 'awaiting-tool':  return quietMs < t.toolQuietMs || toolRunning ? { kind: 'running' } : { kind: 'attention', reason: 'tool-or-permission' };
    case 'awaiting-model':
    case 'unknown':        return quietMs < t.stalledMs   ? { kind: 'running' } : { kind: 'attention', reason: 'stalled' };
  }
}

/** L8: the verdict comes from the most recently written MAIN copy; subagents never supply it. */
export function pickMainFile(files: readonly SourceFile[]): SourceFile | undefined {
  let best: SourceFile | undefined;
  for (const f of files) if (f.kind === 'session' && (!best || f.mtimeMs > best.mtimeMs)) best = f;
  return best;
}

/** L7: a running subagent keeps its parent alive even though the main file is untouched. */
export function effectiveMtime(files: readonly SourceFile[]): number {
  let m = 0;
  for (const f of files) if (f.mtimeMs > m) m = f.mtimeMs;
  return m;
}
