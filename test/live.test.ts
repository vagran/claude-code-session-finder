import { describe, it, expect, vi, afterEach } from 'vitest';
import { LivenessTracker, type TrackerDeps, type Change } from '../src/core/live.js';
import type { SourceFile } from '../src/core/discover.js';
import type { TailInfo, TailVerdict } from '../src/core/state.js';

const MIN = 60_000, H = 60 * MIN;

/** An in-memory corpus: the tracker only ever sees it through the injected deps. */
function harness(files: SourceFile[], verdicts: Record<string, TailVerdict | TailInfo>, start = 100 * H, extra: Partial<TrackerDeps> = {}) {
  let clock = start;
  const reads: string[] = [];
  const deps: TrackerDeps = {
    discover: async () => files.map(f => ({ ...f })),
    stat: async p => {
      const f = files.find(x => x.path === p);
      if (!f) throw new Error('ENOENT');
      return { mtimeMs: f.mtimeMs, size: f.size };
    },
    readVerdict: async p => { reads.push(p); return verdicts[p] ?? 'unknown'; },
    now: () => clock,
    ...extra,
  };
  const changes: Change[] = [];
  const tracker = new LivenessTracker({ activeWindowMs: 4 * H }, deps);
  tracker.onChange(c => changes.push(c));
  return { tracker, reads, changes, advance: (ms: number) => { clock += ms; }, now: () => clock, files };
}

const main = (id: string, mtimeMs: number, dir = '-w'): SourceFile =>
  ({ path: `/p/${dir}/${id}.jsonl`, sessionId: id, projectDir: dir, kind: 'session', mtimeMs, size: 10 });
const sub = (id: string, mtimeMs: number, dir = '-w'): SourceFile =>
  ({ path: `/p/${dir}/${id}/subagents/x.jsonl`, sessionId: id, projectDir: dir, kind: 'subagent', mtimeMs, size: 10 });

afterEach(() => { vi.useRealTimers(); });   // block body: useRealTimers() returns VitestUtils, and afterEach wants void

describe('LivenessTracker.sweep', () => {
  it('gates ACTIVE by the window (L6) and resolves state from the tail', async () => {
    const t0 = 100 * H;
    // 30 s quiet, not 60: exactly toolQuietMs is already "attention" (the threshold is ≥, spec §7).
    const h = harness([main('fresh', t0 - 30_000), main('old', t0 - 5 * H)], { '/p/-w/fresh.jsonl': 'awaiting-tool' }, t0);
    await h.tracker.sweep();
    expect([...h.tracker.liveness.keys()]).toEqual(['fresh']);
    expect(h.tracker.liveness.get('fresh')!.state).toEqual({ kind: 'running' });
    expect(h.reads).toEqual(['/p/-w/fresh.jsonl']);            // the old one was never read (L9)
    expect(h.changes).toHaveLength(1);
    expect(h.changes[0]!.membershipChanged).toBe(true);
  });

  it('a newer subagent keeps a session ACTIVE and supplies lastWriteMs, not the verdict (L7, L8)', async () => {
    const t0 = 100 * H;
    const h = harness([main('a', t0 - 6 * H), sub('a', t0 - 2 * MIN)], { '/p/-w/a.jsonl': 'awaiting-tool' }, t0);
    await h.tracker.sweep();
    const l = h.tracker.liveness.get('a')!;
    expect(l.lastWriteMs).toBe(t0 - 2 * MIN);
    expect(l.verdict).toBe('awaiting-tool');
    expect(h.reads).toEqual(['/p/-w/a.jsonl']);                // never the subagent file
  });

  it('reads the tail of the most recently written main copy after a worktree move (L8)', async () => {
    const t0 = 100 * H;
    const h = harness([main('a', t0 - 3 * H, '-w'), main('a', t0 - MIN, '-w2')],
                      { '/p/-w/a.jsonl': 'turn-ended', '/p/-w2/a.jsonl': 'awaiting-model' }, t0);
    await h.tracker.sweep();
    expect(h.reads).toEqual(['/p/-w2/a.jsonl']);
    expect(h.tracker.liveness.get('a')!.verdict).toBe('awaiting-model');
  });

  it('keeps a fresh session whose verdict is unknown (shown as running); drops one with only subagent files left', async () => {
    const t0 = 100 * H;
    const h = harness([main('u', t0), sub('orphan', t0)], {}, t0);
    await h.tracker.sweep();
    expect([...h.tracker.liveness.keys()]).toEqual(['u']);
    expect(h.tracker.liveness.get('u')).toMatchObject({ verdict: 'unknown', state: { kind: 'running' } });
  });
});

describe('LivenessTracker.tick', () => {
  it('re-reads only files whose (mtime, size) changed', async () => {
    const t0 = 100 * H;
    const files = [main('a', t0 - MIN), main('b', t0 - MIN)];
    const h = harness(files, { '/p/-w/a.jsonl': 'awaiting-tool', '/p/-w/b.jsonl': 'awaiting-tool' }, t0);
    await h.tracker.sweep();
    expect(h.reads).toHaveLength(2);
    await h.tracker.tick();
    expect(h.reads).toHaveLength(2);                            // nothing changed, nothing read
    files[0]!.mtimeMs = t0; files[0]!.size = 11;               // 'a' appended
    await h.tracker.tick();
    expect(h.reads).toEqual(['/p/-w/a.jsonl', '/p/-w/b.jsonl', '/p/-w/a.jsonl']);
  });

  it('a threshold crossing fires onChange with no I/O (spec §8)', async () => {
    const t0 = 100 * H;
    const h = harness([main('a', t0 - 30_000)], { '/p/-w/a.jsonl': 'awaiting-tool' }, t0);
    await h.tracker.sweep();
    expect(h.tracker.liveness.get('a')!.state).toEqual({ kind: 'running' });
    h.advance(40_000);                                          // quiet is now 70 s
    await h.tracker.tick();
    expect(h.reads).toHaveLength(1);
    expect(h.tracker.liveness.get('a')!.state).toEqual({ kind: 'attention', reason: 'tool-or-permission' });
    expect(h.changes).toHaveLength(2);
    expect(h.changes[1]!.membershipChanged).toBe(false);
  });

  it('does not emit when nothing changed', async () => {
    const t0 = 100 * H;
    const h = harness([main('a', t0 - MIN)], { '/p/-w/a.jsonl': 'turn-ended' }, t0);
    await h.tracker.sweep();
    await h.tracker.tick();
    h.advance(1_000);
    await h.tracker.tick();
    expect(h.changes).toHaveLength(1);
  });

  it('a file that vanished mid-tick is dropped for that cycle, not thrown', async () => {
    const t0 = 100 * H;
    const files = [main('a', t0 - MIN)];
    const h = harness(files, { '/p/-w/a.jsonl': 'turn-ended' }, t0);
    await h.tracker.sweep();
    files.splice(0, 1);                                         // stat now rejects with ENOENT
    await expect(h.tracker.tick()).resolves.toBeUndefined();
    expect(h.tracker.liveness.size).toBe(0);
  });
});

describe('LivenessTracker.start/stop', () => {
  it('runs a sweep+tick immediately, then on its intervals; stop() cancels', async () => {
    vi.useFakeTimers({ now: 100 * H });
    const t0 = 100 * H;
    const h = harness([main('a', t0 - MIN)], { '/p/-w/a.jsonl': 'awaiting-tool' }, t0);
    const sweep = vi.spyOn(h.tracker, 'sweep');
    const tick = vi.spyOn(h.tracker, 'tick');
    h.tracker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);                  // 5 ticks + 1 sweep elapsed
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(5);
    h.tracker.stop();
    const after = tick.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick.mock.calls.length).toBe(after);
  });

  it('routes a throwing phase to onError instead of an unhandled rejection', async () => {
    vi.useFakeTimers({ now: 100 * H });
    const deps: TrackerDeps = {
      discover: async () => { throw new Error('boom'); },
      stat: async () => ({ mtimeMs: 0, size: 0 }), readVerdict: async () => 'unknown', now: () => 100 * H,
    };
    const tracker = new LivenessTracker({ activeWindowMs: H }, deps);
    const errors: unknown[] = [];
    tracker.onError = e => errors.push(e);
    tracker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveLength(1);
    tracker.stop();
  });
});

describe('LivenessTracker pins (a session behind an open tab never ages out)', () => {
  it('keeps a pinned session past the window, with its state; unpinning lets the next sweep drop it', async () => {
    const t0 = 100 * H;
    const h = harness([main('fresh', t0 - MIN), main('tabbed', t0 - 26 * H)], { '/p/-w/fresh.jsonl': 'awaiting-tool', '/p/-w/tabbed.jsonl': 'turn-ended' }, t0);
    h.tracker.setPinned(new Set(['tabbed']));
    await h.tracker.sweep();
    expect([...h.tracker.liveness.keys()].sort()).toEqual(['fresh', 'tabbed']);
    expect(h.tracker.liveness.get('tabbed')).toMatchObject({ state: { kind: 'attention', reason: 'your-turn' }, lastWriteMs: t0 - 26 * H });
    h.tracker.setPinned(new Set());
    await h.tracker.sweep();
    expect([...h.tracker.liveness.keys()]).toEqual(['fresh']);
    expect(h.changes.at(-1)!.membershipChanged).toBe(true);
  });
  it('a pinned session past the window is parked; crossing the window on a tick parks it as a change, a write un-parks it', async () => {
    const t0 = 100 * H;
    const h = harness([main('edge', t0 - MIN), main('old', t0 - 26 * H)],
      { '/p/-w/edge.jsonl': { verdict: 'turn-ended', lastTs: t0 - 4 * H + MIN }, '/p/-w/old.jsonl': 'turn-ended' }, t0);
    h.tracker.setPinned(new Set(['edge', 'old']));
    await h.tracker.sweep();
    expect(h.tracker.liveness.get('old')!.parked).toBe(true);
    expect(h.tracker.liveness.get('edge')!.parked).toBeUndefined();
    const before = h.changes.length;
    h.advance(2 * MIN);
    await h.tracker.tick();
    expect(h.tracker.liveness.get('edge')!.parked).toBe(true);
    expect(h.changes.length).toBe(before + 1);
    expect(h.changes.at(-1)!.membershipChanged).toBe(false);
    h.files[1]!.mtimeMs = h.now(); h.files[1]!.size = 20;
    await h.tracker.tick();
    expect(h.tracker.liveness.get('old')!.parked).toBeUndefined();
  });
  it('a pin for a session with no transcript is harmless', async () => {
    const h = harness([main('fresh', 100 * H - MIN)], {}, 100 * H);
    h.tracker.setPinned(new Set(['ghost']));
    await h.tracker.sweep();
    expect([...h.tracker.liveness.keys()]).toEqual(['fresh']);
  });
});

describe('activity is the last conversational record, not the file (a resume only appends sidecars)', () => {
  it('lastWriteMs comes from the tail timestamp when the file is newer; a newer subagent write still wins (L7)', async () => {
    const t0 = 100 * H;
    const h = harness([main('a', t0 - MIN), main('b', t0 - MIN), sub('b', t0 - 30_000)],
      { '/p/-w/a.jsonl': { verdict: 'turn-ended', lastTs: t0 - 2 * H }, '/p/-w/b.jsonl': { verdict: 'awaiting-tool', lastTs: t0 - 2 * H } }, t0);
    await h.tracker.sweep();
    expect(h.tracker.liveness.get('a')!.lastWriteMs).toBe(t0 - 2 * H);
    expect(h.tracker.liveness.get('b')!.lastWriteMs).toBe(t0 - 30_000);
  });
  it('a file touched within the window whose conversation is older than the window is not ACTIVE — unless a tab pins it', async () => {
    const t0 = 100 * H;
    const h = harness([main('viewed', t0 - MIN)], { '/p/-w/viewed.jsonl': { verdict: 'turn-ended', lastTs: t0 - 30 * H } }, t0);
    await h.tracker.sweep();
    expect([...h.tracker.liveness.keys()]).toEqual([]);
    h.tracker.setPinned(new Set(['viewed']));
    await h.tracker.sweep();
    expect(h.tracker.liveness.get('viewed')).toMatchObject({ lastWriteMs: t0 - 30 * H, state: { kind: 'attention', reason: 'your-turn' } });
    expect(h.changes.at(-1)!.membershipChanged).toBe(true);
  });
  it('crossing the window between sweeps drops the session on a tick, as a membership change', async () => {
    const t0 = 100 * H;
    const h = harness([main('edge', t0 - MIN)], { '/p/-w/edge.jsonl': { verdict: 'turn-ended', lastTs: t0 - 4 * H + MIN } }, t0);
    await h.tracker.sweep();
    expect([...h.tracker.liveness.keys()]).toEqual(['edge']);
    h.advance(2 * MIN);
    await h.tracker.tick();
    expect([...h.tracker.liveness.keys()]).toEqual([]);
    expect(h.changes.at(-1)!.membershipChanged).toBe(true);
  });
});

describe('LivenessTracker — a long tool call', () => {
  it('asks the process table only past the quiet threshold, and a running command keeps the spinner', async () => {
    const t0 = 100 * H;
    const asked: Array<[string, number]> = [];
    let running = true;
    const h = harness([main('a', t0 - 5 * MIN), main('b', t0 - 5 * MIN), main('c', t0 - 10_000)], {
      '/p/-w/a.jsonl': { verdict: 'awaiting-tool', lastTs: t0 - 5 * MIN },
      '/p/-w/b.jsonl': { verdict: 'turn-ended', lastTs: t0 - 5 * MIN },
      '/p/-w/c.jsonl': { verdict: 'awaiting-tool', lastTs: t0 - 10_000 },
    }, t0, { toolRunning: async (id, since) => { asked.push([id, since]); return running; } });
    await h.tracker.sweep();
    expect(asked).toEqual([['a', t0 - 5 * MIN]]);          // since the tool_use; b is done, c is not quiet yet
    expect(h.tracker.liveness.get('a')!.state).toEqual({ kind: 'running' });
    running = false;                                        // the command ended, or it was a permission prompt
    await h.tracker.tick();
    expect(h.tracker.liveness.get('a')!.state).toEqual({ kind: 'attention', reason: 'tool-or-permission' });
  });
  it('a failing check reads as "no command": the quiet rule stands', async () => {
    const t0 = 100 * H;
    const h = harness([main('a', t0 - 5 * MIN)], { '/p/-w/a.jsonl': { verdict: 'awaiting-tool', lastTs: t0 - 5 * MIN } }, t0,
      { toolRunning: async () => { throw new Error('no /proc'); } });
    await h.tracker.sweep();
    expect(h.tracker.liveness.get('a')!.state).toEqual({ kind: 'attention', reason: 'tool-or-permission' });
  });
});
