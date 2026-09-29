import * as vscode from 'vscode';
import { readFile, unlink } from 'node:fs/promises';
import { showSearchQuickPick } from './surfaces/quickpick.js';
import { LiveHost } from './live-host.js';
import { createStatusBar, SHOW_SESSIONS } from './surfaces/statusbar.js';
import { claimPendingOpen } from './baton.js';
import { BATON_FILE, batonPath, runOpen, executePlan, openHooks, openGuard, confirmNotRunningElsewhere } from './open.js';
import { LiveViewProvider, VIEW_ID } from './surfaces/live-view.js';
import { SessionViewManager } from './surfaces/session-view.js';
import { stateIcon } from './core/rows.js';
import { planOpen } from './core/resolve.js';
import type { OpenWhere } from './core/open-args.js';

async function tryClaimPendingOpen(ctx: vscode.ExtensionContext): Promise<void> {
  const path = batonPath(ctx);
  await claimPendingOpen({
    read: () => readFile(path, 'utf8').catch(() => null),
    remove: () => unlink(path).catch(() => {}),
    myFolder: vscode.workspace.workspaceFolders?.[0]?.uri.path,
    // M3: the only executeCommand that was not wrapped. A missing Claude Code command
    // here must not become an unhandled rejection during activation.
    openSession: async (id, where) => {
      // The source window did not check: only this window can tell its own tabs' processes.
      if (!await confirmNotRunningElsewhere(id, where)) return;
      try {
        await runOpen(id, where);
      } catch {
        vscode.window.showErrorMessage('Claude Code did not accept the handed-off session.');
      }
    },
  });
}

const claim = (ctx: vscode.ExtensionContext) =>
  tryClaimPendingOpen(ctx).catch(err =>
    vscode.window.showErrorMessage(`Could not open the handed-off session: ${String(err)}`));

export function activate(ctx: vscode.ExtensionContext): void {
  // Stage 1 (spec §9.2): the status bar is the glanceable answer to "which sessions are running?".
  const log = vscode.window.createOutputChannel('Claude Code Sessions', { log: true });
  log.info(`activated ${ctx.extension.packageJSON.version}`);     // which build this window runs
  openGuard.channel = log;
  log.info(`extension host pid ${process.pid}: Claude Code processes with this parent are this window's tabs`);
  const host = new LiveHost(ctx, log);
  const status = createStatusBar(ctx);
  ctx.subscriptions.push(log, host, host.onSnapshot(s => status.update(s)));
  // Stage 3: the Session View — agent tree, timeline and a readable transcript for ANY session,
  // read from disk without resuming it. Created first: the sidebar asks it which panel is the active tab.
  const sessions = new SessionViewManager(ctx, host, log);
  const live = new LiveViewProvider(ctx, host, () => sessions.activeSessionId(), log, () => sessions.visibleSessionIds());
  openGuard.hasTabHere = id => live.hasOwnTab(id);
  ctx.subscriptions.push(
    sessions,
    vscode.window.registerWebviewViewProvider(VIEW_ID, live),
    // The sidebar follows the active editor tab: a Claude Code session tab or one of our Session Views.
    // A Claude Code tab that closes takes its session under CLOSED (noteClosedTabs runs first: it reads
    // which tab WAS active).
    vscode.window.tabGroups.onDidChangeTabs(e => { live.noteClosedTabs(e.closed); live.noteActiveTab(); }),
    vscode.window.tabGroups.onDidChangeTabGroups(() => live.noteActiveTab()),
    vscode.commands.registerCommand('sessionOrganizer.showAllProjects', () => host.toggleScope()),
    vscode.commands.registerCommand('sessionOrganizer.showThisWorkspace', () => host.toggleScope()),
    vscode.commands.registerCommand('sessionOrganizer.filterSessions', async (q?: string) => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      live.focusFilter(typeof q === 'string' ? q : undefined);
    }),
    vscode.commands.registerCommand(SHOW_SESSIONS, () => vscode.commands.executeCommand(`${VIEW_ID}.focus`)),
    vscode.commands.registerCommand('sessionOrganizer.refresh', () => Promise.all([host.sweepNow(), host.refreshIndex()])),
    vscode.commands.registerCommand('sessionOrganizer.openInTab', (id?: string) => openFromPalette(ctx, host, id, 'tab')),
    vscode.commands.registerCommand('sessionOrganizer.openInRightPanel', (id?: string) => openFromPalette(ctx, host, id, 'right')),
    vscode.commands.registerCommand('sessionOrganizer.closeSession', async (id?: string) => {
      const sessionId = id ?? await pickActive(host, 'Close which session?');
      if (sessionId) await live.closeSession(sessionId);
    }),
  );
  ctx.subscriptions.push(
    vscode.commands.registerCommand('sessionOrganizer.search', () => showSearchQuickPick(ctx, host.liveness)),
  );

  // Opened from a Sessions row, a Quick Pick button, or the palette.
  ctx.subscriptions.push(vscode.commands.registerCommand('sessionOrganizer.openSessionView', async (id?: string) => {
    const sessionId = id ?? await pickSessionId(host);
    if (sessionId) await sessions.open(sessionId);
  }));
  // A session opened from here is active again whatever its closed marker said (live-host.ts reopen).
  openHooks.onOpening = (id, where) => live.noteOpening(id, where);
  openHooks.onOpened = (id, where) => { void host.reopen(id); live.noteOpened(id, where); };
  live.noteActiveTab();

  // I2: openFolder focusing an ALREADY-OPEN window is the outcome spec §9 assumes, and
  // that window's extension host is already activated — activate() never runs again. Watch
  // the baton file so a running window claims too. Both paths go through claimPendingOpen,
  // which deletes before opening, so whichever fires first wins and the other finds nothing.
  // VS Code creates globalStorageUri lazily. A non-recursive watcher whose base directory
  // does not exist is not reliably re-armed when it appears, which would silently degrade
  // the hand-off back to activate-only — the exact failure this watcher was added to fix.
  // activate() stays synchronous (VS Code should not wait on us), so the directory is
  // ensured on a detached promise and the watcher is registered once it exists.
  void (async () => {
    try {
      await vscode.workspace.fs.createDirectory(ctx.globalStorageUri);
    } catch { /* already exists, or unwritable — createFileSystemWatcher still worth trying */ }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(ctx.globalStorageUri, BATON_FILE));   // F8: not Uri.file()
    watcher.onDidCreate(() => void claim(ctx));
    watcher.onDidChange(() => void claim(ctx));
    ctx.subscriptions.push(watcher);
  })();

  void claim(ctx);
}

export function deactivate(): void { /* nothing to tear down */ }

/** A Quick Pick over the ACTIVE sessions, for the palette commands. */
async function pickActive(host: LiveHost, placeHolder: string): Promise<string | undefined> {
  const rows = host.snapshot.active;
  const picked = await vscode.window.showQuickPick(
    rows.map(r => ({ label: `$(${stateIcon(r)}) ${r.title}`, description: [r.project, r.branch].filter(Boolean).join(' · '),
                     id: r.sessionId, alwaysShow: true })),                                     // F7
    { placeHolder: rows.length ? placeHolder : 'No active sessions' });
  return picked?.id;
}

/** Palette entry points: pick an ACTIVE session (or take an id) and open it where asked. */
async function openFromPalette(ctx: vscode.ExtensionContext, host: LiveHost, sessionId: string | undefined, where: OpenWhere): Promise<void> {
  const id = sessionId ?? await pickActive(host, 'Open which session?');
  if (!id) return;
  const m = host.session(id);
  if (!m) { vscode.window.showWarningMessage('That session is not in the index yet — try again in a moment.'); return; }
  const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.path);
  await executePlan(planOpen(m, folders), ctx, where);
}

/** Palette entry for the Session View: any ACTIVE or recent session. */
async function pickSessionId(host: LiveHost): Promise<string | undefined> {
  const { active, history } = host.snapshot;
  const rows = [
    ...active.map(r => ({ label: `$(${stateIcon(r)}) ${r.title}`, description: [r.project, r.branch].filter(Boolean).join(' · '), id: r.sessionId, alwaysShow: true })),
    ...history.map(r => ({ label: `$(history) ${r.title}`, description: [r.project, r.branch].filter(Boolean).join(' · '), id: r.sessionId, alwaysShow: true })),
  ];
  const picked = await vscode.window.showQuickPick(rows, { placeHolder: rows.length ? 'Open the Session View for…' : 'No sessions indexed yet' });
  return picked?.id;
}
