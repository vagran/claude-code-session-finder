import * as vscode from 'vscode';
import { ringingFirst, stateIcon, statusText, type Snapshot } from '../core/rows.js';
import { devBuildLabel } from '../core/dev-build.js';
import { mdEscape } from './statusbar-escape.js';

export const SHOW_SESSIONS = 'sessionOrganizer.showSessions';

/**
 * Spec §9.2: running count, and the bell — the sessions whose ball is in your court and that you have
 * not seen there (D13, core/rows.ts statusText); hidden when nothing runs and nothing rings, except on a
 * dev build, which names itself in every window. Click runs SHOW_SESSIONS.
 */
export function createStatusBar(ctx: vscode.ExtensionContext): { update(s: Snapshot): void } {
  const item = vscode.window.createStatusBarItem('sessionOrganizer.live', vscode.StatusBarAlignment.Left, 50);
  item.name = 'Claude Code Sessions';
  item.command = SHOW_SESSIONS;
  ctx.subscriptions.push(item);
  const version: string = ctx.extension.packageJSON.version;
  const dev = devBuildLabel(version);

  return {
    update(s: Snapshot) {
      const text = statusText(s.active, dev);
      if (!text) { item.hide(); return; }
      const running = s.active.filter(r => r.state === 'running').length;
      const ringing = s.active.filter(r => r.ringing).length;
      item.text = text;

      const md = new vscode.MarkdownString(undefined, true);       // supportThemeIcons for the $(…) glyphs
      md.isTrusted = false;
      if (dev) md.appendMarkdown(`$(beaker) Dev build ${mdEscape(version)}; \`npm run try\` installs the next one\n\n`);
      md.appendMarkdown('**Claude Code sessions**\n\n');
      for (const r of ringingFirst(s.active)) {
        const meta = [r.project, r.branch].filter(Boolean).join(' · ');
        const title = r.ringing ? `**${mdEscape(r.title)}** $(bell-dot)` : mdEscape(r.title);
        md.appendMarkdown(`- $(${stateIcon(r)}) ${title}${meta ? `  —  ${mdEscape(meta)}` : ''}\n`);
      }
      md.appendMarkdown(`\n_${running} running · ${ringing} need you · click to open the session list_`);
      item.tooltip = md;
      item.show();
    },
  };
}
