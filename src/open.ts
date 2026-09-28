import * as vscode from 'vscode';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenPlan } from './core/resolve.js';
import { openCommands, type OpenWhere } from './core/open-args.js';
import { readLiveProcesses, openConflict, describeProcess } from './core/processes.js';

export const BATON_TTL_MS = 60_000;
export const BATON_FILE = 'pending-open.json';
export const batonPath = (ctx: vscode.ExtensionContext) => join(ctx.globalStorageUri.fsPath, BATON_FILE);

const TRANSCRIPT_ACTION = 'Open transcript';

/** Spec §9/§10: a session you cannot resume must still be inspectable. */
export async function openTranscript(file: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc, { preview: true });
}

/**
 * Set by activate(): the sidebar learns which tab a session opens as, so its highlight follows exactly.
 * `onOpening` runs BEFORE Claude Code is asked — the sidebar notes which tabs exist, so the one that
 * appears afterwards is the session's; by the time the command resolves the new tab can already be there.
 */
export const openHooks: {
  onOpening: (sessionId: string, where: OpenWhere) => void;
  onOpened: (sessionId: string, where: OpenWhere) => void;
} = { onOpening: () => {}, onOpened: () => {} };

/** The only place that calls into Claude Code to open a session. L10: never call editor.open directly. */
export async function runOpen(sessionId: string, where: OpenWhere): Promise<void> {
  openHooks.onOpening(sessionId, where);
  for (const c of openCommands(sessionId, where)) await vscode.commands.executeCommand(c.command, ...c.args);
  openHooks.onOpened(sessionId, where);
}

/**
 * F8: never Uri.file() — derive from a URI that already carries the right remote authority.
 * I3: with no folder open there is no workspaceFolders[0], and throwing here made EVERY
 * open fail in a folderless window (measured 100/100 sessions plan as `handoff` there).
 * globalStorageUri is always present and carries the same authority; ctx.extensionUri
 * would do equally well.
 */
export function folderUri(path: string, ctx: vscode.ExtensionContext): vscode.Uri {
  const base = vscode.workspace.workspaceFolders?.[0]?.uri ?? ctx.globalStorageUri;
  return base.with({ path });
}

/**
 * Set by activate(), like openHooks: the output channel the open check reports to, and whether this
 * window certainly has a Claude Code tab of a session (the sidebar's tab tracking) — the one case
 * where Claude Code focuses what is there instead of starting a process.
 */
export const openGuard: { channel?: vscode.LogOutputChannel; hasTabHere?: (sessionId: string) => boolean } = {};

const VIEW_ACTION = 'Open Session View';
const ANYWAY_ACTION = 'Open Anyway';

/**
 * Before Claude Code is asked to resume a session: is it already running in another process?
 * A second process on one session forks its transcript, and the next resume keeps only the
 * branch written last — hours of work can drop out of the conversation. So ask first, and
 * offer the Session View, which reads the transcript and starts nothing.
 * Returns true when the open should go ahead. Runs in the window that will open the session:
 * only that window can tell its own tabs' processes from everyone else's.
 */
export async function confirmNotRunningElsewhere(sessionId: string, where: OpenWhere): Promise<boolean> {
  const log = openGuard.channel;
  const conflict = openConflict(await readLiveProcesses(), sessionId, process.pid, where, openGuard.hasTabHere?.(sessionId) ?? false);
  if (conflict.kind === 'unknown') {
    log?.info(`open ${sessionId}: Claude Code process registry unreadable — opening without the check`);
    return true;
  }
  if (conflict.kind === 'none') return true;
  const running = conflict.processes.map(p => describeProcess(p, process.pid)).join('; ');
  log?.warn(`open ${sessionId}: already running in ${running}` + (where === 'right' ? ' (opening in the side panel)' : ''));
  const choice = await vscode.window.showWarningMessage(
    'This session is already running in another Claude Code process.',
    { modal: true, detail:
      `It is open in ${running}.\n\n` +
      'Opening it here starts a second process on the same transcript. The two fork it, and the next ' +
      'resume keeps only one branch: the other one\'s work disappears from the conversation.\n\n' +
      'Switch to where it runs instead, or read it in the Session View, which starts nothing.' },
    VIEW_ACTION, ANYWAY_ACTION);
  if (choice === VIEW_ACTION) await vscode.commands.executeCommand('sessionFinder.openSessionView', sessionId);
  if (choice === ANYWAY_ACTION) log?.warn(`open ${sessionId}: opened anyway`);
  return choice === ANYWAY_ACTION;
}

const RIGHT_PANEL_NOTICE = 'sessionFinder.rightPanelNoticeShown';

/** Spec §11: opening in the right panel also changes Claude Code's default location. Say so once. */
async function noticeRightPanelOnce(ctx: vscode.ExtensionContext): Promise<void> {
  if (ctx.globalState.get<boolean>(RIGHT_PANEL_NOTICE)) return;
  await ctx.globalState.update(RIGHT_PANEL_NOTICE, true);
  void vscode.window.showInformationMessage(
    'Opening in the right panel also makes it Claude Code\'s default location for new sessions. ' +
    'Run "Claude Code: Open in New Tab" once to switch back.');
}

export async function executePlan(plan: OpenPlan, ctx: vscode.ExtensionContext, where: OpenWhere = 'tab'): Promise<void> {
  if (plan.kind === 'transcript') {
    await openTranscript(plan.file);
    vscode.window.showInformationMessage(`Cannot resume this session: ${plan.reason}. Showing the transcript.`);
    return;
  }

  if (plan.kind === 'here') {
    if (plan.note) vscode.window.setStatusBarMessage(`Claude session: ${plan.note}`, 4000);
    // F3: reveal-if-open / new-tab-otherwise is Claude Code's own behaviour.
    // L10: openCommands() passes the programmatic flag; without it every open here silently
    // reset the user's Claude Code preferred location to "panel".
    if (!await confirmNotRunningElsewhere(plan.sessionId, where)) return;
    try {
      if (where === 'right') await noticeRightPanelOnce(ctx);
      await runOpen(plan.sessionId, where);
    } catch {
      // Spec §10: offer the transcript rather than surfacing a bare error.
      const choice = await vscode.window.showErrorMessage(
        'Claude Code did not accept the session. Is the extension enabled?', TRANSCRIPT_ACTION);
      if (choice === TRANSCRIPT_ACTION) await openTranscript(plan.file);
    }
    return;
  }

  // handoff — the target window checks before it opens (tryClaimPendingOpen): only it can tell
  // which live process is its own tab's.
  try {
    // I3: derive the target BEFORE writing the baton — a failure here used to leave a
    // stale baton on disk for its full 60 s TTL.
    const target = folderUri(plan.targetCwd, ctx);
    await vscode.workspace.fs.createDirectory(ctx.globalStorageUri);
    await writeFile(batonPath(ctx), JSON.stringify({
      sessionId: plan.sessionId, targetCwd: plan.targetCwd, expiresAt: Date.now() + BATON_TTL_MS, where,
    }));
    await vscode.commands.executeCommand('vscode.openFolder', target, { forceNewWindow: true });
  } catch (err) {
    vscode.window.showErrorMessage(`Could not open the session's folder: ${String(err)}`);
  }
}
