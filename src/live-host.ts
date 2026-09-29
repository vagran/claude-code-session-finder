import * as vscode from 'vscode';
import { join } from 'node:path';
import { LivenessTracker } from './core/live.js';
import { refreshIndex } from './core/cache.js';
import { durationMs } from './core/query.js';
import { buildSnapshot, type Snapshot, type SidebarScope } from './core/rows.js';
import { inScope } from './core/scope.js';
import { applyClosed, type ClosedMarkers } from './core/closed.js';
import { Bell, LooksFile } from './core/looks.js';
import { workspaceRoots } from './scope-roots.js';
import type { SearchIndex, SessionMeta } from './core/types.js';
import type { Liveness, Thresholds } from './core/state.js';

const HOUR = 3_600_000;
/** globalState key: sessions closed from the sidebar, session id → when (core/closed.ts). Machine-wide, like the sessions. */
const CLOSED_KEY = 'closedSessions';

/** The two live-state thresholds, from settings (spec D5). Shared with the Session View. */
export function readThresholds(c: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('sessionOrganizer')): Thresholds {
  return {
    toolQuietMs: Math.max(5, c.get<number>('toolQuietSeconds', 60)) * 1_000,
    stalledMs: Math.max(1, c.get<number>('stalledMinutes', 15)) * 60_000,
  };
}

/**
 * The vscode-aware owner of live state (spec D4, D6). Turns settings into a LivenessTracker,
 * pauses it while the window is unfocused, refreshes the search index only when ACTIVE
 * membership changes (L9), and emits a Snapshot for every surface to render.
 */
export class LiveHost implements vscode.Disposable {
  private tracker: LivenessTracker | undefined;
  private unsubscribe: (() => void) | undefined;
  private index: SearchIndex | null = null;
  private indexing: Promise<void> | null = null;
  private readonly emitter = new vscode.EventEmitter<Snapshot>();
  private readonly disposables: vscode.Disposable[] = [this.emitter];

  readonly onSnapshot: vscode.Event<Snapshot> = this.emitter.event;
  snapshot: Snapshot = { active: [], history: [], totalSessions: 0, indexing: true, scope: 'all' };
  /** The override that keeps a recently written session under CLOSED: the × on a row put it there. */
  private closed: ClosedMarkers = {};
  private activeWindowMs = 4 * HOUR;
  /** The tracker's liveness minus the closed sessions — what every surface reads as "live". */
  private live: ReadonlyMap<string, Liveness> = new Map();
  /** Sessions behind an open Claude Code tab (the sidebar tells us): ACTIVE whatever their age. */
  private pinned: ReadonlySet<string> = new Set();
  /** This workspace's folders, main checkouts and worktrees — what "this project" means for the sidebar. */
  private roots: string[] = [];
  /** D13: which sessions ring — the looks, shared by every window through a file in global storage. */
  private readonly bell: Bell;
  /** The rule of the last snapshot, for surfaces that build rows of their own (the inline filter). */
  rings: (l: Liveness) => boolean = () => false;
  private ringingKey = '';

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly log: vscode.LogOutputChannel) {
    this.closed = ctx.globalState.get<ClosedMarkers>(CLOSED_KEY) ?? {};
    this.bell = new Bell(new LooksFile(join(ctx.globalStorageUri.fsPath, 'looks.json')));
    this.rebuildTracker();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('sessionOrganizer')) this.rebuildTracker();
      }),
      // D6: nothing runs while the window is unfocused; the first focus event sweeps at once. Another
      // window may have looked at a session meanwhile: the snapshot published now re-reads the looks.
      vscode.window.onDidChangeWindowState(s => {
        if (!s.focused) { this.tracker?.stop(); return; }
        this.publish();
        this.tracker?.start();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refreshIndex()),
    );
    void this.syncScopeContext();
    void this.refreshIndex();
  }

  /** Sidebar scope: a per-workspace choice (the toggle) over the setting's default. */
  get scope(): SidebarScope {
    return this.ctx.workspaceState.get<SidebarScope>('sidebarScope')
      ?? vscode.workspace.getConfiguration('sessionOrganizer').get<SidebarScope>('sidebarScope', 'workspace');
  }

  async toggleScope(): Promise<void> {
    await this.ctx.workspaceState.update('sidebarScope', this.scope === 'workspace' ? 'all' : 'workspace');
    await this.syncScopeContext();
    this.publish();
  }

  /** The view-title toggle shows one of two icons; the `when` clause reads this context key. */
  private syncScopeContext(): Thenable<unknown> {
    return vscode.commands.executeCommand('setContext', 'sessionOrganizer.scope', this.scope);
  }

  /** Whether the sidebar shows this session. Global surfaces (status bar, picker) never ask. */
  readonly inScope = (m: SessionMeta): boolean => this.scope === 'all' || inScope(m, this.roots);

  get liveness(): ReadonlyMap<string, Liveness> { return this.live; }

  /** The sessions the open Claude Code tabs stand for — the tracker keeps them ACTIVE past the window. */
  setPinned(ids: ReadonlySet<string>): void { this.pinned = ids; this.tracker?.setPinned(ids); }

  /** The sessions on screen in this window (the sidebar tells us): looking at one that waits on you quiets its bell. */
  setOnScreen(ids: ReadonlySet<string>): void {
    if (!this.bell.setOnScreen(ids)) return;
    this.log.info(`on screen: ${ids.size ? [...ids].join(', ') : 'no session'}`);
    // The sidebar also calls this while a snapshot is being delivered: publish after it, never inside it.
    queueMicrotask(() => this.publish());
  }

  /**
   * Close a session: it moves under CLOSED at once and stays there until its transcript is written
   * again after the close (core/closed.ts). The tab, if any, is the view's business.
   */
  async close(sessionId: string): Promise<void> {
    this.closed = { ...this.closed, [sessionId]: Date.now() };
    this.publish();
    await this.ctx.globalState.update(CLOSED_KEY, this.closed);
  }

  /** Opening a closed session from here is the user's word that it is active again — the marker goes now, not after the first write. */
  async reopen(sessionId: string): Promise<void> {
    if (!(sessionId in this.closed)) return;
    const rest: Record<string, number> = { ...this.closed };
    delete rest[sessionId];
    this.closed = rest;
    this.publish();
    await this.ctx.globalState.update(CLOSED_KEY, this.closed);
  }
  /** The search index, or null before the first refresh lands. Read-only for surfaces. */
  get searchIndex(): SearchIndex | null { return this.index; }

  private rebuildTracker(): void {
    this.tracker?.stop();
    this.unsubscribe?.();
    const c = vscode.workspace.getConfiguration('sessionOrganizer');
    this.activeWindowMs = durationMs(c.get<string>('activeWindow', '4h'), 4 * HOUR);
    const tracker = new LivenessTracker({ activeWindowMs: this.activeWindowMs, thresholds: readThresholds(c) });
    tracker.setPinned(this.pinned);
    tracker.onError = err => this.log.warn(`live tracker: ${String(err)}`);
    this.unsubscribe = tracker.onChange(({ membershipChanged }) => {
      if (membershipChanged) void this.refreshIndex();          // a session appeared or left (D6)
      this.publish();
    });
    this.tracker = tracker;
    if (vscode.window.state.focused) tracker.start();
  }

  /** Whole-file work (L9) — never from a tick. Concurrent callers share one run. */
  refreshIndex(): Promise<void> {
    if (this.indexing) return this.indexing;
    this.indexing = (async () => {
      try {
        // Worktrees come and go, so the roots are re-read with every index refresh (two git calls).
        this.roots = await workspaceRoots((vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath));
        ({ index: this.index } = await refreshIndex({ cacheFile: join(this.ctx.globalStorageUri.fsPath, 'index.json') }));
      } catch (err) {
        this.log.warn(`index refresh failed: ${String(err)}`);
      } finally {
        this.indexing = null;
        this.publish();
      }
    })();
    return this.indexing;
  }

  private publish(): void {
    const raw = this.tracker?.liveness ?? new Map<string, Liveness>();
    const r = applyClosed(raw, this.closed, { now: Date.now(), activeWindowMs: this.activeWindowMs, pinned: this.pinned });
    if (r.changed) { this.closed = r.markers; void this.ctx.globalState.update(CLOSED_KEY, r.markers); }
    this.live = r.liveness;
    this.rings = this.bell.update(this.live, vscode.window.state.focused);
    this.snapshot = buildSnapshot(this.index, this.live, { indexing: this.indexing !== null, scope: this.scope, inScope: this.inScope, rings: this.rings });
    this.logRinging();
    this.emitter.fire(this.snapshot);
  }

  /** One line whenever the set of ringing sessions changes — what to read when the bell seems wrong. */
  private logRinging(): void {
    const ringing = [...this.live.values()].filter(this.rings);
    const key = ringing.map(l => l.sessionId).sort().join(',');
    if (key === this.ringingKey) return;
    this.ringingKey = key;
    this.log.info(`bell: ${ringing.length} ringing${ringing.length ? ` — ${ringing.map(l => `${l.sessionId} (${l.state.kind === 'attention' ? l.state.reason : l.state.kind})`).join(', ')}` : ''}`);
  }

  /** Index metadata for a session id, or undefined until the next refresh indexes it. */
  session(sessionId: string): SessionMeta | undefined {
    return this.index?.sessions.find(s => s.sessionId === sessionId);
  }

  /** The Refresh button: re-enumerate now instead of waiting for the 10 s sweep. */
  sweepNow(): Promise<void> {
    return this.tracker?.sweep() ?? Promise.resolve();
  }

  dispose(): void {
    this.tracker?.stop();
    this.unsubscribe?.();
    for (const d of this.disposables) d.dispose();
  }
}
