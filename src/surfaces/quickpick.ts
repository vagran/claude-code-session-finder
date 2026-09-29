import * as vscode from 'vscode';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { refreshIndex } from '../core/cache.js';
import { deepSearch } from '../core/deep.js';
import { parseQuery, search, snippet, withWindow, type SessionHit } from '../core/query.js';
import { planOpen } from '../core/resolve.js';
import type { SearchIndex } from '../core/types.js';
import { executePlan, folderUri, openTranscript } from '../open.js';
import { projectLabel, stateIcon } from '../core/rows.js';
import type { Liveness } from '../core/state.js';

interface Row extends vscode.QuickPickItem { hit?: SessionHit; action?: 'all' | 'deep' }

const OPEN_VIEW = 'Open session view';
const COPY_LINK = 'Copy deep link';
const REVEAL_FOLDER = 'Reveal folder';
const OPEN_TRANSCRIPT = 'Open transcript';

/** Idle time before a deep scan starts. Long enough that typing never queues scans. */
const DEEP_DEBOUNCE_MS = 275;

const ago = (ts: number) => {
  const d = Math.floor((Date.now() - ts) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? '1d ago' : `${d}d ago`;
};

function toRow(hit: SessionHit, liveness: ReadonlyMap<string, Liveness>): Row {
  const m = hit.session;
  const bits = [projectLabel(m.projectDir), m.branches.at(-1) ?? '', ago(m.lastTs)];
  if (m.prLinks.length) bits.push(`PR #${m.prLinks.at(-1)}`);
  if (!m.cwdExists) bits.push('⚠ folder missing');
  // Stage 1 (spec §9.3): the glyph is the session's live state; history keeps the sparkle.
  const live = liveness.get(m.sessionId);
  const glyph = live ? stateIcon({ state: live.state.kind, ...(live.state.kind === 'attention' ? { reason: live.state.reason } : {}),
                                   ...(live.state.kind === 'running' && live.state.background ? { background: true as const } : {}) }) : 'sparkle';
  return {
    label: `$(${glyph}) ${m.title ?? hit.best?.text.slice(0, 60) ?? m.sessionId}`,
    description: bits.filter(Boolean).join(' · '),
    detail: hit.best ? `${snippet(hit.best.text, hit.best.index)}   (${hit.matchCount} matches)` : undefined,
    alwaysShow: true,                    // F7 — MUST be set or VS Code re-filters on label
    // I5: VS Code's QuickPick has no modifier-accept API, so spec §9's Cmd/Ctrl+Enter
    // "open the raw transcript" action is a third item button instead.
    buttons: [
      { iconPath: new vscode.ThemeIcon('type-hierarchy'), tooltip: OPEN_VIEW },
      { iconPath: new vscode.ThemeIcon('link'), tooltip: COPY_LINK },
      { iconPath: new vscode.ThemeIcon('folder'), tooltip: REVEAL_FOLDER },
      { iconPath: new vscode.ThemeIcon('file-code'), tooltip: OPEN_TRANSCRIPT },
    ],
    hit,
  };
}

export async function showSearchQuickPick(
  ctx: vscode.ExtensionContext,
  liveness: ReadonlyMap<string, Liveness> = new Map(),
): Promise<void> {
  const cacheFile = join(ctx.globalStorageUri.fsPath, 'index.json');
  const defaultWindow = vscode.workspace.getConfiguration('sessionOrganizer').get<string>('defaultWindow', '60d');

  // Monotonic token: a slow deep scan that resolves after a newer keystroke's render must
  // neither clobber the newer items NOR keep running. Declared before qp.show() so the
  // onDidHide handler below can bump it — disposal must cancel in-flight work too.
  let renderToken = 0;

  const qp = vscode.window.createQuickPick<Row>();
  qp.placeholder = `Search Claude sessions (last ${defaultWindow}) — "phrase", pr:123, since:all, !tools`;
  qp.matchOnDescription = false;
  qp.matchOnDetail = false;
  qp.busy = true;
  qp.show();
  // C1: register the hide->dispose listener BEFORE the first await. Escape during the
  // cold refreshIndex() below still fires onDidHide, and with no listener attached yet
  // the QuickPick (and the SearchIndex it closes over) would leak for the extension's life.
  qp.onDidHide(() => { renderToken++; qp.dispose(); });   // bump FIRST: cancels any live deep scan

  // The cold build below takes ~1.6 s over a large corpus, and the picker is already
  // visible and accepting input. Register the change listener BEFORE that await, or
  // everything typed while it runs lands in qp.value with no listener attached — and
  // once the listener is finally added it only fires on FUTURE changes, so the text
  // already in the box never renders. The user sees "no results" from a healthy index.
  // `pending` records those keystrokes; the post-build render below replays them.
  let ready = false;
  let pending = '';

  qp.onDidChangeValue(v => {
    if (!ready) { pending = v; return; }               // buffered; replayed once the index lands
    render(v).catch(err => vscode.window.showErrorMessage(`Search failed: ${String(err)}`));
  });

  const removedIds = new Set<string>();         // sessions confirmed gone from disk; filtered at render time
  let index: SearchIndex;
  try {
    ({ index } = await refreshIndex({ cacheFile }));
  } catch (err) {
    qp.hide();
    vscode.window.showErrorMessage(`Could not index Claude sessions: ${String(err)}`);
    return;
  }
  qp.busy = false;

  const render = async (value: string) => {
    const token = ++renderToken;
    qp.busy = false;                                 // cancel any spinner left by a superseded deep scan
    if (!value.trim()) { qp.items = []; return; }
    const q = parseQuery(value, defaultWindow, Date.now());

    if (q.deep) {
      qp.busy = true;
      // C1: the deep path is a full-corpus live scan (~0.7 s, hundreds of MB). Firing one
      // per keystroke overlapped 29 scans and 3+ GB of RSS in the shared extension host.
      // Debounce the DEEP path only — the prose path below stays synchronous and
      // undebounced, because its 1-30 ms responsiveness is a design property (spec §8).
      await new Promise<void>(r => setTimeout(r, DEEP_DEBOUNCE_MS));
      if (token !== renderToken) return;             // superseded while idle — no scan starts
      const hits = await deepSearch(index, q, Date.now(),
        { cancelled: () => token !== renderToken }); // superseded mid-scan, or picker disposed
      if (token !== renderToken) return;             // a newer render has already taken over
      qp.busy = false;
      qp.items = hits.slice(0, 50).map(h => toRow(h, liveness));
      return;
    }

    const hits = search(index, q, Date.now()).filter(h => !removedIds.has(h.session.sessionId));
    const rows: Row[] = hits.slice(0, 50).map(h => toRow(h, liveness));
    if (hits.length <= 2 && q.sinceMs !== null) {
      rows.push({ label: `$(history) Search all time — ${index.sessions.length} sessions`,
                  alwaysShow: true, action: 'all' });
    }
    if (hits.length === 0 && !q.deep) {
      rows.push({ label: '$(search) Search tool calls & results (slower)', alwaysShow: true, action: 'deep' });
    }
    qp.items = rows;
  };

  // Open the gate and replay anything typed during the cold build. Use qp.value rather
  // than `pending` alone so a value set programmatically before this point is honoured too.
  ready = true;
  const typedDuringBuild = qp.value || pending;
  if (typedDuringBuild.trim()) {
    render(typedDuringBuild).catch(err => vscode.window.showErrorMessage(`Search failed: ${String(err)}`));
  }

  qp.onDidTriggerItemButton(async e => {
    const m = (e.item as Row).hit?.session;
    if (!m) return;
    try {
      const tooltip = e.button.tooltip ?? '';
      if (tooltip === OPEN_VIEW) {
        qp.hide();
        await vscode.commands.executeCommand('sessionOrganizer.openSessionView', m.sessionId);
      } else if (tooltip === COPY_LINK) {
        await vscode.env.clipboard.writeText(`vscode://anthropic.claude-code/open?session=${m.sessionId}`);
        vscode.window.setStatusBarMessage('Deep link copied', 3000);
      } else if (tooltip === OPEN_TRANSCRIPT) {
        await openTranscript(m.file);
      } else if (m.cwd) {
        // Same authority-preserving derivation as open.ts — revealInExplorer is a
        // workbench-level command like openFolder, not a plain file read.
        await vscode.commands.executeCommand('revealInExplorer', folderUri(m.cwd, ctx));
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Action failed: ${String(err)}`);
    }
  });

  qp.onDidAccept(async () => {
    const picked = qp.selectedItems[0];
    if (!picked) return;
    if (picked.action === 'all') {
      // I3: withWindow owns quote-aware since: replacement — a local regex here previously
      // reached inside quoted phrases and corrupted them.
      qp.value = withWindow(qp.value, 'all');
      await render(qp.value);
      return;
    }
    if (picked.action === 'deep') {
      // I3: never produce "!!" — this action row only appears while !q.deep, but guard anyway.
      const trimmed = qp.value.trim();
      qp.value = trimmed.startsWith('!') ? trimmed : `!${trimmed}`;
      await render(qp.value);
      return;
    }
    if (!picked.hit) return;

    // Spec §10: the transcript may have been deleted between indexing and now.
    // C2: `prose[].s` is a POSITIONAL index into `index.sessions` — filtering the sessions
    // array would shift every later position out from under it and cross-wire results with
    // the wrong session. Never mutate `index`; just remember the id and filter hits by it.
    if (!existsSync(picked.hit.session.file)) {
      removedIds.add(picked.hit.session.sessionId);
      vscode.window.showWarningMessage('That session transcript no longer exists on disk.');
      await render(qp.value);
      return;
    }

    qp.hide();
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.path);
    await executePlan(planOpen(picked.hit.session, folders), ctx);
  });
}
