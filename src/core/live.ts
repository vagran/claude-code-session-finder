import { stat as fsStat } from 'node:fs/promises';
import { discover as fsDiscover, defaultRoot, type SourceFile } from './discover.js';
import { effectiveMtime, pickMainFile, resolveState, DEFAULT_THRESHOLDS, type Liveness, type ProcFacts, type TailInfo, type TailVerdict, type Thresholds } from './state.js';
import { readTailInfoFrom as fsReadTailInfo } from './tail-io.js';
import { readProcSnapshot, type ProcSnapshot } from './processes.js';

export interface TrackerDeps {
  discover: (root: string) => Promise<SourceFile[]>;
  stat: (path: string) => Promise<{ mtimeMs: number; size: number }>;
  /** a bare verdict is accepted (tests); the real reader also returns the context size */
  readVerdict: (path: string, size: number) => Promise<TailVerdict | TailInfo>;
  now: () => number;
  /** the process table, read once per refresh (processes.ts); absent or null → the transcript alone decides */
  processes?: () => Promise<ProcSnapshot | null>;
}

export interface TrackerOptions {
  root?: string;
  /** L6: sessions written within this window are ACTIVE and carry a state. */
  activeWindowMs: number;
  thresholds?: Thresholds;
  sweepMs?: number;
  tickMs?: number;
}

export type LivenessMap = ReadonlyMap<string, Liveness>;
export interface Change { liveness: LivenessMap; membershipChanged: boolean }

interface Tracked {
  sessionId: string;
  files: SourceFile[];
  main: SourceFile;
  /** `${mtimeMs}:${size}` of `main` when its tail was last read — the same key cache.ts uses. */
  key: string;
  info: TailInfo;
  /** set by refreshTools() while the verdict is awaiting-tool or turn-ended: what the process table says */
  proc?: ProcFacts;
}

const toInfo = (v: TailVerdict | TailInfo): TailInfo => typeof v === 'string' ? { verdict: v } : v;
const keyOf = (f: { mtimeMs: number; size: number }) => `${f.mtimeMs}:${f.size}`;

/**
 * Spec §8. Two phases over an in-memory picture of the ACTIVE set:
 *   sweep  — discover() everything (readdir + stat), recompute membership, read tails of NEW members
 *   tick   — re-stat ACTIVE files, re-read only tails whose (mtime, size) changed, re-resolve all
 * Publishes only when the resulting map differs (membership, verdict, state, reason, lastWriteMs).
 * No `vscode`, no real clock: everything comes through `deps`, so tests drive it deterministically.
 */
export class LivenessTracker {
  private tracked = new Map<string, Tracked>();
  private current = new Map<string, Liveness>();
  private readonly listeners = new Set<(c: Change) => void>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  /** Sessions kept ACTIVE whatever their age: the ones behind an open Claude Code tab (the sidebar supplies them). */
  private pinned: ReadonlySet<string> = new Set();
  private readonly root: string;
  private readonly thresholds: Thresholds;
  private readonly sweepMs: number;
  private readonly tickMs: number;

  /** Spec §12: a timer callback never throws. Whatever a phase throws lands here (or is dropped). */
  onError: ((err: unknown) => void) | undefined;

  constructor(private readonly opts: TrackerOptions, private readonly deps: TrackerDeps = defaultDeps()) {
    this.root = opts.root ?? defaultRoot();
    this.thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
    this.sweepMs = opts.sweepMs ?? 10_000;
    this.tickMs = opts.tickMs ?? 2_000;
  }

  get liveness(): LivenessMap { return this.current; }

  /** Replace the pinned set. A change is swept at once while the tracker runs, so the list follows the tabs. */
  setPinned(ids: ReadonlySet<string>): void {
    if (ids.size === this.pinned.size && [...ids].every(id => this.pinned.has(id))) return;
    this.pinned = new Set(ids);
    if (this.sweepTimer) void this.run(() => this.sweep());
  }

  onChange(cb: (c: Change) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  async sweep(): Promise<void> {
    const files = await this.deps.discover(this.root);
    const bySession = new Map<string, SourceFile[]>();
    for (const f of files) {
      const group = bySession.get(f.sessionId) ?? [];
      group.push(f);
      bySession.set(f.sessionId, group);
    }
    const now = this.deps.now();
    const next = new Map<string, Tracked>();
    for (const [sessionId, group] of bySession) {
      if (now - effectiveMtime(group) > this.opts.activeWindowMs && !this.pinned.has(sessionId)) continue;   // L6, L7; a pinned session never ages out
      const main = pickMainFile(group);                                              // L8
      if (!main) continue;                                                           // parent transcript gone
      const key = keyOf(main);
      const prev = this.tracked.get(sessionId);
      const info = prev && prev.key === key && prev.main.path === main.path
        ? prev.info
        : toInfo(await this.deps.readVerdict(main.path, main.size));
      next.set(sessionId, { sessionId, files: group, main, key, info });
    }
    this.tracked = next;
    await this.refreshTools();
    this.publish();
  }

  async tick(): Promise<void> {
    for (const [sessionId, t] of this.tracked) {
      const fresh: SourceFile[] = [];
      for (const f of t.files) {
        const s = await this.deps.stat(f.path).catch(() => null);                    // §12: vanished → skip
        if (s) fresh.push({ ...f, mtimeMs: s.mtimeMs, size: s.size });
      }
      const main = pickMainFile(fresh);
      if (!main) { this.tracked.delete(sessionId); continue; }
      t.files = fresh;
      const key = keyOf(main);
      if (key !== t.key || main.path !== t.main.path) {                              // changed → one tail read
        t.info = toInfo(await this.deps.readVerdict(main.path, main.size));
        t.key = key;
        t.main = main;
      }
    }
    await this.refreshTools();
    this.publish();
  }

  /**
   * Two verdicts need the process table, because the transcript reads the same either way: a tool call
   * with no result (running, or a permission prompt?) and a finished turn (your turn, or a pause while
   * background tasks run?). The table is read once, only when some session has one of them.
   */
  private async refreshTools(): Promise<void> {
    const asks = (t: Tracked) => t.info.verdict === 'awaiting-tool' || t.info.verdict === 'turn-ended';
    const any = [...this.tracked.values()].some(asks);
    const snap = any && this.deps.processes ? await this.deps.processes().catch(() => null) : null;
    for (const t of this.tracked.values()) {
      if (!snap || !asks(t)) { t.proc = undefined; continue; }
      const status = snap.status(t.sessionId);
      t.proc = t.info.verdict === 'awaiting-tool'
        ? { ...(status ? { status } : {}), toolRunning: snap.toolRunning(t.sessionId, t.info.lastTs ?? t.main.mtimeMs) }
        : { background: snap.backgroundTasks(t.sessionId) > 0 };
    }
  }

  start(): void {
    this.stop();
    void this.run(async () => { await this.sweep(); await this.tick(); });
    this.sweepTimer = setInterval(() => void this.run(() => this.sweep()), this.sweepMs);
    this.tickTimer = setInterval(() => void this.run(() => this.tick()), this.tickMs);
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.sweepTimer = this.tickTimer = undefined;
  }

  /**
   * The ACTIVE set is judged twice: the sweep by file mtime (cheap, before any tail is read), and here
   * by when the conversation last moved — a resume appends sidecars and touches the file, and that is
   * not activity. A pinned session (its tab is open) is ACTIVE whatever its age, and parked once past the
   * window. Membership change is read off the emitted set, so a session aging out on a tick is one too;
   * a pinned one crossing the window on a tick is a change, not a membership change.
   */
  private publish(): void {
    const now = this.deps.now();
    const next = new Map<string, Liveness>();
    for (const t of this.tracked.values()) {
      const lastWriteMs = activityMs(t);
      const pastWindow = now - lastWriteMs > this.opts.activeWindowMs;
      if (pastWindow && !this.pinned.has(t.sessionId)) continue;
      const state = resolveState(t.info.verdict, now - lastWriteMs, this.thresholds, t.proc);
      const l: Liveness = { sessionId: t.sessionId, verdict: t.info.verdict, state, lastWriteMs };
      if (pastWindow) l.parked = true;
      if (t.info.contextTokens !== undefined) l.contextTokens = t.info.contextTokens;
      if (t.info.model !== undefined) l.model = t.info.model;
      next.set(t.sessionId, l);
    }
    const membershipChanged = next.size !== this.current.size || [...next.keys()].some(k => !this.current.has(k));
    const changed = membershipChanged || !sameLiveness(this.current, next);
    this.current = next;
    if (changed) for (const cb of this.listeners) cb({ liveness: next, membershipChanged });
  }

  /** Phases never overlap (a slow sweep skips the ticks under it) and never throw out of a timer. */
  private async run(phase: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { await phase(); } catch (err) { this.onError?.(err); } finally { this.busy = false; }
  }
}

/** When something last happened: the verdict record's timestamp (else the main file's mtime), or a newer subagent write (L7). */
function activityMs(t: Tracked): number {
  let m = t.info.lastTs ?? t.main.mtimeMs;
  for (const f of t.files) if (f.kind === 'subagent' && f.mtimeMs > m) m = f.mtimeMs;
  return m;
}

function sameLiveness(a: ReadonlyMap<string, Liveness>, b: ReadonlyMap<string, Liveness>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, x] of a) {
    const y = b.get(k);
    if (!y || x.verdict !== y.verdict || x.lastWriteMs !== y.lastWriteMs || x.state.kind !== y.state.kind || x.contextTokens !== y.contextTokens || x.parked !== y.parked) return false;
    if (x.state.kind === 'attention' && y.state.kind === 'attention' && x.state.reason !== y.state.reason) return false;
    if (x.state.kind === 'running' && y.state.kind === 'running' && x.state.background !== y.state.background) return false;
  }
  return true;
}

function defaultDeps(): TrackerDeps {
  return {
    discover: fsDiscover,
    stat: async p => { const s = await fsStat(p); return { mtimeMs: s.mtimeMs, size: s.size }; },
    readVerdict: fsReadTailInfo,
    now: () => Date.now(),
    processes: () => readProcSnapshot(),
  };
}
