import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { LiveHost } from '../live-host.js';
import { firstPrompts, resolveTabSession, rowsForHits, knownTitles, labelMatchesTitle, tabsToClose, trustedLearned, candidateSessions, pinnedSessions, closedForGood, sessionsOnScreen, type Snapshot, type TabRef, type Titled } from '../core/rows.js';
import { durationMs, parseQuery, search } from '../core/query.js';
import type { SearchIndex } from '../core/types.js';
import { VIEW_TYPE as SESSION_VIEW_TYPE } from './session-view.js';
import { planOpen } from '../core/resolve.js';
import type { OpenWhere } from '../core/open-args.js';
import { executePlan, folderUri, openTranscript } from '../open.js';

export const VIEW_ID = 'sessionOrganizer.live';
/** The webview type of a Claude Code session tab (`vscode.TabInputWebview.viewType` contains it). */
const CLAUDE_TAB = 'claudeVSCodePanel';

// One member per `type`, not `'transcript' | 'copyLink' | 'reveal'` in one member: the early
// returns in onMessage narrow by discriminant, and a shared member would leave `raw` un-narrowed
// at the `open` step (TS2339 on `raw.where`).
type Inbound =
  | { type: 'ready' }
  | { type: 'search' }
  | { type: 'filter'; q: string }
  | { type: 'toggleScope' }
  | { type: 'open'; sessionId: string; where: OpenWhere }
  | { type: 'view'; sessionId: string }
  | { type: 'transcript'; sessionId: string }
  | { type: 'copyLink'; sessionId: string }
  | { type: 'reveal'; sessionId: string }
  | { type: 'close'; sessionId: string };

/** Spec §12: every field read from a webview message is checked first; unknown shapes are ignored. */
function isInbound(m: unknown): m is Inbound {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case 'ready': case 'search': case 'toggleScope': return true;
    case 'filter': return typeof o.q === 'string';
    case 'open': return typeof o.sessionId === 'string' && (o.where === 'tab' || o.where === 'right');
    case 'view': case 'transcript': case 'copyLink': case 'reveal': case 'close': return typeof o.sessionId === 'string';
    default: return false;
  }
}

/**
 * Spec §9.1. The host owns the state (D4); this class only ships Snapshots to the webview and
 * turns its messages into the same actions the Quick Pick offers. retainContextWhenHidden is
 * deliberately not set: the webview re-renders from the next snapshot after `ready`.
 */
export class LiveViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private indexTimer: ReturnType<typeof setInterval> | undefined;
  /** What the active editor tab is: a Claude Code session tab (known by its label) or one of our Session Views. */
  private activeTab: { kind: 'claude'; label: string } | { kind: 'own' | 'opened'; sessionId: string } | null = null;
  /** The Claude Code tab labels present just before this extension asked Claude Code to open a session. */
  private opening: { sessionId: string; before: Set<string> } | null = null;
  /** A session this extension just opened; a Claude Code tab that was not there before and activates next is its tab. */
  private opened: { sessionId: string; at: number; before: Set<string> } | null = null;
  /** Claude Code tab label → session id, learned from our own opens. Exact where titles are ambiguous. */
  private readonly learned: Map<string, string>;
  private pendingFilter: { q: string } | null = null;
  private titlesFor: SearchIndex | null = null;
  private titles = new Map<string, string>();

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly host: LiveHost,
              private readonly ownActiveSession: () => string | undefined = () => undefined,
              private readonly log?: vscode.LogOutputChannel,
              private readonly ownVisibleSessions: () => string[] = () => []) {
    this.learned = new Map(Object.entries(ctx.workspaceState.get<Record<string, string>>('tabLabels') ?? {}));
    ctx.subscriptions.push(host.onSnapshot(s => this.post(s)));
  }

  /**
   * Called from runOpen(): highlight the session at once (the user just chose it), and remember the
   * Claude Code tab that appears for it, so later switches to that tab resolve by id rather than by
   * title — three sessions can share one AI title. A right-panel open is not a tab; nothing to learn.
   */
  /** Called from runOpen() BEFORE Claude Code is asked: remember which tabs exist, so the new one can be told from them. */
  noteOpening(sessionId: string, where: OpenWhere): void {
    this.opening = where === 'tab' ? { sessionId, before: new Set(this.claudeTabs().map(t => t.ref.label)) } : null;
  }

  noteOpened(sessionId: string, where: OpenWhere): void {
    this.activeTab = { kind: 'opened', sessionId };
    this.postActive();
    const before = this.opening?.sessionId === sessionId ? this.opening.before : new Set(this.claudeTabs().map(t => t.ref.label));
    this.opening = null;
    if (where !== 'tab') return;
    this.opened = { sessionId, at: Date.now(), before };
    // Re-activating an already-active tab fires no tab event; one late look covers that path.
    setTimeout(() => { if (this.opened?.sessionId === sessionId) this.noteActiveTab(); }, 1_500);
  }

  private learn(label: string, sessionId: string): void {
    if (this.learned.get(label) === sessionId) return;
    this.learned.set(label, sessionId);
    void this.ctx.workspaceState.update('tabLabels', Object.fromEntries(this.learned));
    this.log?.info(`learned tab label "${label}" → ${sessionId}`);
  }

  /**
   * Called on every tab change. A Claude Code tab is recognised by its webview type and named by
   * its label; one of our Session Views by its panel. Any other tab (a file, a terminal) leaves the
   * highlight where it was — you are still working in that session.
   */
  noteActiveTab(): void {
    try { this.trackActiveTab(); } finally { this.updatePins(); this.updateOnScreen(); }
  }

  /**
   * The sessions the open Claude Code tabs stand for are pinned: the tracker keeps them ACTIVE past the
   * window (the row then wears an age tag), so a session with a tab is never listed as closed. Recomputed
   * on every tab change and every snapshot — titles the index has just learned can change the answer.
   */
  private updatePins(): void {
    this.host.setPinned(new Set(pinnedSessions(this.claudeTabs().map(t => t.ref), this.learned, this.known())));
  }

  /**
   * The sessions on screen (D13): the visible tab of every editor group that is a Claude Code tab
   * (rows.ts sessionsOnScreen), and every visible Session View. The host records a look at the ones
   * waiting on you.
   */
  private updateOnScreen(): void {
    const groups = vscode.window.tabGroups.all.map(g => {
      const tab = g.activeTab; const input = tab?.input;
      return { isActive: g.isActive, claudeLabel: tab && input instanceof vscode.TabInputWebview && input.viewType.includes(CLAUDE_TAB) ? tab.label : null };
    });
    const highlight = this.activeTab?.kind === 'claude' ? { label: this.activeTab.label, id: this.activeId() } : null;
    this.host.setOnScreen(new Set([...this.ownVisibleSessions(), ...sessionsOnScreen(groups, highlight, this.learned, this.known())]));
  }

  private trackActiveTab(): void {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab?.input;
    if (!tab || !(input instanceof vscode.TabInputWebview)) {
      this.log?.debug(`active tab: not a webview (${input?.constructor.name ?? 'none'}) — highlight kept`);
      return;
    }
    if (input.viewType.includes(CLAUDE_TAB)) {
      // The tab event fires before the new tab is active, so the first Claude tab seen after an open is
      // usually the OLD one: learn only a label that was not there before the open, and only if it can
      // be the opened session's title (a placeholder label is renamed later and matches by title then).
      const o = this.opened;
      if (o && Date.now() - o.at < 5_000) {
        if (o.before.has(tab.label)) this.log?.debug(`tab "${tab.label}" was open before ${o.sessionId} was opened — not its tab`);
        else {
          const title = this.known().find(k => k.sessionId === o.sessionId)?.title;
          if (title === undefined || labelMatchesTitle(tab.label, title)) { this.learn(tab.label, o.sessionId); this.opened = null; }
          else this.log?.info(`not learning "${tab.label}" for ${o.sessionId}: its title is "${title}"`);
        }
      }
      this.activeTab = { kind: 'claude', label: tab.label };
    }
    else if (input.viewType.includes(SESSION_VIEW_TYPE)) { const id = this.ownActiveSession(); if (id) this.activeTab = { kind: 'own', sessionId: id }; }
    else { this.log?.debug(`active tab: webview ${input.viewType} — not a session`); return; }
    this.log?.info(`active tab: ${input.viewType} "${tab.label}" → session ${this.activeId() ?? 'not found in the list'}`);
    this.postActive();
  }

  /**
   * The × on an ACTIVE row, Delete on a focused one, and `Claude: Close Session`. Closing a Claude Code
   * tab shuts its session down, so one Claude is still working in asks first; the rest close at once.
   * The tabs are resolved BEFORE the marker is set — afterwards the session may be in no list at all —
   * and closed before it, because a session whose tab is open is pinned and cannot be closed. A tab is
   * closed only when it can be nobody else's (rows.ts tabsToClose); one that cannot be told apart from
   * another session's is left open, and a message says so.
   */
  async closeSession(sessionId: string): Promise<void> {
    const row = this.host.snapshot.active.find(r => r.sessionId === sessionId);
    if (!row) return;                                                   // already closed, or gone
    if (row.state === 'running') {
      const choice = await vscode.window.showWarningMessage(`Close “${row.title}”?`,
        { modal: true, detail: 'Claude is still working in this session. Closing its tab stops it; you can resume it from Closed later.' }, 'Close');
      if (choice !== 'Close') return;
    }
    const all = this.claudeTabs();
    const { close, ambiguous } = tabsToClose(sessionId, all.map(t => t.ref), this.learned, this.known());
    const tabs = all.filter(t => close.includes(t.ref)).map(t => t.tab);
    // Tabs first: a session whose tab is still open stays pinned, and a pinned session's marker is dropped.
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
    this.updatePins();
    await this.host.close(sessionId);
    // The highlight follows the active tab and is kept over files; if it pointed at this session, nothing is behind it now.
    if (this.activeId() === sessionId) { this.activeTab = null; this.postActive(); }
    const labels = (refs: TabRef[]) => refs.map(r => `"${r.label}"`).join(', ');
    this.log?.info(`closed session ${sessionId} ("${row.title}"): closed ${tabs.length} tab(s) [${labels(close)}], left ${ambiguous.length} ambiguous [${labels(ambiguous)}]`);
    if (ambiguous.length) {
      void vscode.window.showWarningMessage(`“${row.title}” stays open: its tab “${ambiguous[0]!.label}” could also be another session's, and closing a tab stops the session in it. Close the tab by hand and the session moves under Closed.`);
    } else {
      vscode.window.setStatusBarMessage(`Closed “${row.title}”${tabs.length ? '' : ' — no tab of its own was open in this window'}`, 4000);
    }
  }

  /**
   * This window has a Claude Code tab that can be nobody else's but this session's (the same rule as
   * closing: rows.ts tabsToClose). The open check trusts Claude Code to focus such a tab; an ambiguous
   * label does not count, so a doubtful case warns rather than forks.
   */
  hasOwnTab(sessionId: string): boolean {
    return tabsToClose(sessionId, this.claudeTabs().map(t => t.ref), this.learned, this.known()).close.length > 0;
  }
  /** Every Claude Code session tab in this window, with the label-and-position reference the pure rules work on. */
  private claudeTabs(): Array<{ tab: vscode.Tab; ref: TabRef }> {
    const out: Array<{ tab: vscode.Tab; ref: TabRef }> = [];
    vscode.window.tabGroups.all.forEach((group, gi) => group.tabs.forEach((tab, ti) => {
      const input = tab.input;
      if (input instanceof vscode.TabInputWebview && input.viewType.includes(CLAUDE_TAB)) out.push({ tab, ref: { key: `${gi}:${ti}`, label: tab.label } });
    }));
    return out;
  }

  /** Every session with a known title — the whole index plus unindexed live rows — for checking labels against. */
  private known(): Titled[] {
    return knownTitles(this.host.searchIndex, this.host.snapshot, this.firstPromptsCached());
  }

  private firstPromptsCached(): Map<string, string> {
    const index = this.host.searchIndex;
    if (index && this.titlesFor !== index) { this.titles = firstPrompts(index); this.titlesFor = index; }
    return this.titles;
  }

  /**
   * Called on every tab change with the tabs that closed, BEFORE noteActiveTab. A tab moved to another
   * editor group is not a close: its label is still open (closedForGood). A Claude Code tab closed
   * by hand is its session's end for now, so the session moves under CLOSED — the other direction of the ×.
   * The label must be tellable: a trusted learned label or a unique title match; an ambiguous label on the
   * tab that was active takes the resolution the highlight showed; an ambiguous background tab changes
   * nothing. A learned label goes with its tab. Our own Session View panels are not session tabs.
   */
  noteClosedTabs(closed: readonly vscode.Tab[]): void {
    const claude = closed.filter(t => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes(CLAUDE_TAB));
    const open = this.claudeTabs().map(t => t.ref.label);
    const gone = closedForGood(claude, open);
    for (const tab of claude) if (!gone.includes(tab)) this.log?.info(`tab "${tab.label}" left a group but is still open (moved) — nothing changes`);
    for (const tab of gone) {
      const ids = candidateSessions(tab.label, this.learned, this.known());
      const wasActive = this.activeTab?.kind === 'claude' && this.activeTab.label === tab.label;
      const id = ids.length === 1 ? ids[0] : ids.length > 1 && wasActive ? resolveTabSession(tab.label, this.host.snapshot) : undefined;
      if (this.learned.delete(tab.label)) void this.ctx.workspaceState.update('tabLabels', Object.fromEntries(this.learned));
      // The tab behind the highlight is gone; noteActiveTab (next) sets a new one if another session tab took over.
      if (wasActive) { this.activeTab = null; this.postActive(); }
      if (id !== undefined && this.host.snapshot.active.some(r => r.sessionId === id)) {
        this.log?.info(`tab "${tab.label}" closed → session ${id} moves under Closed`);
        void this.host.close(id);
      } else {
        this.log?.info(`tab "${tab.label}" closed → ${ids.length > 1 ? `ambiguous (${ids.join(', ')})` : ids.length ? 'session not active' : 'no known session'}; nothing changes`);
      }
    }
  }

  private postActive(): void {
    if (this.view) void this.view.webview.postMessage({ type: 'active', sessionId: this.activeId() });
  }

  private activeId(): string | null {
    const a = this.activeTab;
    if (!a) return null;
    if (a.kind !== 'claude') return a.sessionId;
    return trustedLearned(a.label, this.learned, this.known()) ?? resolveTabSession(a.label, this.host.snapshot) ?? null;
  }

  /** The title-bar search button and `Claude: Filter Sessions`: focus the inline filter, optionally with a query. */
  focusFilter(q?: string): void {
    const msg = { type: 'focusFilter', ...(q !== undefined ? { q } : {}) };
    if (this.view) void this.view.webview.postMessage(msg); else this.pendingFilter = { q: q ?? '' };
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = this.html(view.webview, dist);
    view.webview.onDidReceiveMessage(m => void this.onMessage(m));
    // D6: whole-file index work only while someone is looking.
    view.onDidChangeVisibility(() => this.onVisibility(view.visible));
    view.onDidDispose(() => { this.onVisibility(false); this.view = undefined; });
    this.onVisibility(view.visible);
  }

  private onVisibility(visible: boolean): void {
    if (this.indexTimer) clearInterval(this.indexTimer);
    this.indexTimer = undefined;
    if (!visible) return;
    void this.host.refreshIndex();
    this.indexTimer = setInterval(() => void this.host.refreshIndex(), 60_000);
  }

  private post(snapshot: Snapshot): void {
    if (!this.view) return;
    const cfg = vscode.workspace.getConfiguration('sessionOrganizer');
    const activeWindow = cfg.get<string>('activeWindow', '4h');
    const contextBudget = Math.max(1_000, cfg.get<number>('contextBudget', 1_000_000));
    this.updatePins();
    void this.view.webview.postMessage({ type: 'snapshot', snapshot, now: Date.now(), activeWindow, activeWindowMs: durationMs(activeWindow, 4 * 3_600_000), contextBudget, active: this.activeId() });
    // Titles the index just learned can resolve a tab; a changed set republishes, after this snapshot.
    this.updateOnScreen();
  }

  /** The inline filter: the Quick Pick's prose search, as rows that stay on screen. Deep (!) stays in the picker. */
  private postResults(q: string): void {
    if (!this.view) return;
    const index = this.host.searchIndex;
    const defaultWindow = vscode.workspace.getConfiguration('sessionOrganizer').get<string>('defaultWindow', '60d');
    const parsed = parseQuery(q, defaultWindow, Date.now());
    const titles = this.firstPromptsCached();
    const rows = index && !parsed.deep && q.trim()
      ? rowsForHits(search(index, parsed, Date.now()).filter(h => this.host.inScope(h.session)), this.host.liveness, titles, { rings: this.host.rings }) : [];
    void this.view.webview.postMessage({ type: 'results', q, deep: parsed.deep, rows, now: Date.now(), indexing: !index });
  }

  private async onMessage(raw: unknown): Promise<void> {    if (!isInbound(raw)) return;
    try {
      if (raw.type === 'ready') {
        this.post(this.host.snapshot);
        if (this.pendingFilter) { this.focusFilter(this.pendingFilter.q); this.pendingFilter = null; }
        return;
      }
      if (raw.type === 'filter') { this.postResults(raw.q); return; }
      if (raw.type === 'toggleScope') { await this.host.toggleScope(); return; }
      if (raw.type === 'search') { await vscode.commands.executeCommand('sessionOrganizer.search'); return; }
      if (raw.type === 'copyLink') {
        await vscode.env.clipboard.writeText(`vscode://anthropic.claude-code/open?session=${raw.sessionId}`);
        vscode.window.setStatusBarMessage('Deep link copied', 3000);
        return;
      }
      if (raw.type === 'view') { await vscode.commands.executeCommand('sessionOrganizer.openSessionView', raw.sessionId); return; }
      if (raw.type === 'close') { await this.closeSession(raw.sessionId); return; }
      const m = this.host.session(raw.sessionId);
      if (!m) { vscode.window.showWarningMessage('That session is not in the index yet — try again in a moment.'); return; }
      if (raw.type === 'transcript') { await openTranscript(m.file); return; }
      if (raw.type === 'reveal') {
        if (m.cwd) await vscode.commands.executeCommand('revealInExplorer', folderUri(m.cwd, this.ctx));   // F8
        return;
      }
      // open — v0.1 §10: the transcript may have gone between indexing and the click.
      if (!existsSync(m.file)) {
        vscode.window.showWarningMessage('That session transcript no longer exists on disk.');
        void this.host.refreshIndex();
        return;
      }
      const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.path);
      await executePlan(planOpen(m, folders), this.ctx, raw.where);
    } catch (err) {
      vscode.window.showErrorMessage(`Action failed: ${String(err)}`);
    }
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = randomBytes(16).toString('hex');
    const uri = (p: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, p)).toString();
    const csp = `default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('codicons/codicon.css')}">
<link rel="stylesheet" href="${uri('tokens.css')}">
<link rel="stylesheet" href="${uri('style.css')}">
<title>Claude Code Sessions</title>
</head><body>
<main id="app" tabindex="0" aria-label="Claude Code sessions"></main>
<script nonce="${nonce}" src="${uri('webview.js')}"></script>
</body></html>`;
  }
}
