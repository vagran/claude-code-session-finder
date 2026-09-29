import type { SearchIndex, SessionMeta } from './types.js';
import type { Liveness, AttentionReason } from './state.js';
import { isLocalCommand } from './transcript.js';
import { snippet, type SessionHit } from './query.js';

export interface LiveRow {
  sessionId: string; title: string; project: string; branch: string | null; pr: number | null;
  cwdExists: boolean;
  state: 'running' | 'attention'; reason?: AttentionReason;
  /** running only in its background tasks: the turn ended, and they will wake it (state.ts) */
  background?: true;
  /** surfaces render "quiet 2 m" from this and their own clock */
  lastWriteMs: number;
  /** context the model was last given, and the model — the cost meter */
  contextTokens?: number; model?: string;
  /** quiet past the active window, listed only because its tab is open */
  parked?: true;
  /** the bell (core/looks.ts): the ball is in your court and you have not seen it there */
  ringing?: true;
}
export interface HistoryRow {
  sessionId: string; title: string; project: string; branch: string | null; pr: number | null;
  cwdExists: boolean; lastTs: number; msgCount: number;
}
export type SidebarScope = 'workspace' | 'all';
export interface Snapshot { active: LiveRow[]; history: HistoryRow[]; totalSessions: number; indexing: boolean; scope: SidebarScope }
/** A row of the sidebar's inline filter: a HISTORY-shaped row plus what matched, and its live state if it has one. */
export interface SearchRow extends HistoryRow {
  snippet: string | null; matches: number;
  live?: { state: 'running' | 'attention'; reason?: AttentionReason; background?: true; lastWriteMs: number; contextTokens?: number; model?: string; ringing?: true };
}

/** The derivation quickpick.ts has used since v0.1: last `--` segment of the sanitized dir name. */
export function projectLabel(projectDir: string): string {
  return projectDir.replace(/^-/, '').split('--').pop() ?? '';
}

/** Codicon NAME per state (spec §10 table). Surfaces wrap it: `$(name)` or `codicon-name`. */
export function stateIcon(row: { state: 'running' | 'attention'; reason?: AttentionReason; background?: true }): string {
  if (row.state === 'running') return row.background ? 'sync~spin' : 'loading~spin';
  switch (row.reason) {
    case 'tool-or-permission': return 'bell-dot';
    case 'question': return 'question';
    case 'your-turn': return 'comment-discussion';
    case 'interrupted': return 'circle-slash';
    default: return 'warning';
  }
}

/**
 * Spec §9.2 status bar text: "$(loading~spin) 1  $(bell-dot) 3" — sessions running, and sessions that
 * ring (D13), not every session that waits: one you have seen is quiet. A zero count omits its segment;
 * undefined (hidden) when nothing runs and nothing rings. A dev build (`npm run try`) leads with its marker and always shows.
 */
export function statusText(active: readonly { state: 'running' | 'attention'; ringing?: true }[], dev?: string): string | undefined {
  const running = active.filter(r => r.state === 'running').length;
  const ringing = active.filter(r => r.ringing).length;
  const parts: string[] = [];
  if (dev) parts.push(`$(beaker) ${dev}`);
  if (running) parts.push(`$(loading~spin) ${running}`);
  if (ringing) parts.push(`$(bell-dot) ${ringing}`);
  return parts.length ? parts.join('  ') : undefined;
}

/**
 * The closed Claude Code tabs that really closed a session. VS Code moves a tab to another editor group
 * as an open there and a close here — in separate events — so a closed tab whose label is still on an
 * open tab was moved (or shares its label with one that stays, whose pin would keep the session ACTIVE
 * anyway). Without this, dragging a Claude Code tab aside closed its session and forgot its label.
 */
export function closedForGood<T extends { label: string }>(closed: readonly T[], openLabels: readonly string[]): T[] {
  const open = new Set(openLabels);
  return closed.filter(t => !open.has(t.label));
}

/** The status bar tooltip's order: what rings first, then the rest, each in the list's own order. */
export function ringingFirst<T extends { state: string; ringing?: true }>(rows: readonly T[]): T[] {
  return [...rows.filter(r => r.ringing), ...rows.filter(r => !r.ringing)];
}

/** One sentence per state — the glyph's tooltip everywhere it is drawn. */
export function stateLabel(row: { state: 'running' | 'attention'; reason?: AttentionReason; background?: true }): string {
  if (row.state === 'running') return row.background ? 'Between turns, background tasks running — they will wake Claude' : 'Claude is working';
  switch (row.reason) {
    case 'question': return 'Claude is waiting for your answer — a question, or a plan to approve';
    case 'tool-or-permission': return 'Waiting on a tool call or a permission prompt';
    case 'your-turn': return 'Claude finished — your turn';
    case 'interrupted': return 'Interrupted — waiting for you';
    default: return 'Stalled — nothing written for a while';
  }
}

/**
 * Spec §6 ordering: things that need you, then things that are working, then things probably dead — and
 * below all of them, whatever their state, the sessions parked there by an open tab: a tab left open
 * since yesterday does not need you more than a session working now.
 */
const RANK: Record<string, number> = {
  'attention/question': 0, 'attention/tool-or-permission': 1, 'attention/your-turn': 2, 'attention/interrupted': 3, running: 4, 'attention/stalled': 5,
};
const PARKED = 10;
const rank = (l: Liveness) =>
  l.parked ? PARKED : RANK[l.state.kind === 'attention' ? `attention/${l.state.reason}` : 'running'] ?? 9;

function titleOf(m: SessionMeta | undefined, sessionId: string, firstPrompt: Map<string, string>): string {
  return m?.title ?? firstPrompt.get(sessionId)?.slice(0, 80) ?? sessionId.slice(0, 8);
}

/** First real prompt per session — the title fallback every surface shares. */
export function firstPrompts(index: SearchIndex): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of index.prose) {                       // file order, so the first 'u' per session is the first prompt
    if (p.r !== 'u' || isLocalCommand(p.x)) continue;   // a /clear or /model echo is not what the session is about
    const id = index.sessions[p.s]?.sessionId;
    if (id && !out.has(id)) out.set(id, p.x);
  }
  return out;
}

/** Search hits as sidebar rows: same titles as the list, the best-matching line as a snippet, live state (and the bell) kept. */
export function rowsForHits(hits: SessionHit[], liveness: ReadonlyMap<string, Liveness>, firstPrompt: Map<string, string>,
                            opts: { limit?: number; rings?: (l: Liveness) => boolean } = {}): SearchRow[] {
  return hits.slice(0, opts.limit ?? 50).map(h => {
    const m = h.session; const l = liveness.get(m.sessionId);
    const row: SearchRow = {
      sessionId: m.sessionId, title: titleOf(m, m.sessionId, firstPrompt), project: projectLabel(m.projectDir),
      branch: m.branches.at(-1) ?? null, pr: m.prLinks.at(-1) ?? null, cwdExists: m.cwdExists, lastTs: m.lastTs, msgCount: m.msgCount,
      snippet: h.best ? snippet(h.best.text, h.best.index) : null, matches: h.matchCount,
    };
    if (l) row.live = { state: l.state.kind, lastWriteMs: l.lastWriteMs, ...(l.state.kind === 'attention' ? { reason: l.state.reason } : {}),
                        ...(l.state.kind === 'running' && l.state.background ? { background: true as const } : {}),
                        ...(l.contextTokens !== undefined ? { contextTokens: l.contextTokens } : {}), ...(l.model !== undefined ? { model: l.model } : {}),
                        ...(opts.rings?.(l) ? { ringing: true as const } : {}) };
    return row;
  });
}

const ELLIPSIS = /(?:…|\.\.\.)$/;

/**
 * Could this Claude Code tab label be this session's title? Claude Code cuts a long title to 24
 * characters and an ellipsis, and its own matcher reads that as "a proper prefix of the title";
 * a label without an ellipsis is the whole title. (A label cut without an ellipsis, as older
 * builds did, still matches as a prefix.) Never the reverse: "Fix tests" is not "Fix".
 */
export function labelMatchesTitle(label: string, title: string): boolean {
  const l = label.trim(), t = title.trim();
  if (!l || !t) return false;
  if (l === t) return true;
  if (ELLIPSIS.test(l)) { const cut = l.replace(ELLIPSIS, ''); return cut !== '' && t !== cut && t.startsWith(cut); }
  return t.startsWith(l);
}

/**
 * Which row a Claude Code editor tab points at, for the highlight: an exact title match wins,
 * ACTIVE before HISTORY, then the ellipsis rule. Nothing matches → undefined, and the sidebar
 * highlights nothing rather than guessing.
 */
export function resolveTabSession(label: string, s: Snapshot): string | undefined {
  const l = label.trim(); if (!l) return undefined;
  // Several sessions can share one AI title; the one written most recently is the likeliest tab.
  const rows = [...[...s.active].sort((a, b) => b.lastWriteMs - a.lastWriteMs), ...s.history];
  return (rows.find(r => r.title === l) ?? rows.find(r => labelMatchesTitle(l, r.title)))?.sessionId;
}

export interface Titled { sessionId: string; title: string; lastTs?: number }
export interface TabRef { key: string; label: string }

/** Every session a tab label could be: a trusted learned label names one; otherwise every known session it fits. */
export function candidateSessions(label: string, learned: ReadonlyMap<string, string>, known: readonly Titled[]): string[] {
  const byLearned = trustedLearned(label, learned, known);
  return byLearned !== undefined ? [byLearned] : tabMatches(label, known);
}

/** Every session the sidebar knows a title for: the whole index, plus live rows the index has not seen yet. */
export function knownTitles(index: SearchIndex | null, s: Snapshot, firstPrompt: Map<string, string>): Titled[] {
  const out: Titled[] = (index?.sessions ?? []).map(m => ({ sessionId: m.sessionId, title: titleOf(m, m.sessionId, firstPrompt), lastTs: m.lastTs }));
  const seen = new Set(out.map(t => t.sessionId));
  for (const r of s.active) if (!seen.has(r.sessionId)) out.push({ sessionId: r.sessionId, title: r.title, lastTs: r.lastWriteMs });
  return out;
}

/** Every known session a tab label could belong to (24 characters of title are often shared). */
export function tabMatches(label: string, known: readonly Titled[]): string[] {
  const out: string[] = [];
  for (const k of known) if (labelMatchesTitle(label, k.title) && !out.includes(k.sessionId)) out.push(k.sessionId);
  return out;
}

/**
 * A label learned from one of our own opens names a session exactly — unless that session has a
 * title the label cannot be, in which case the tab that was active a moment after the open was
 * somebody else's (it happens: the tab event fires before the new tab is active) and the entry is
 * ignored. A session with no known title cannot be checked and is taken at its word.
 */
export function trustedLearned(label: string, learned: ReadonlyMap<string, string>, known: readonly Titled[]): string | undefined {
  const id = learned.get(label);
  if (id === undefined) return undefined;
  const title = known.find(k => k.sessionId === id)?.title;
  return title === undefined || labelMatchesTitle(label, title) ? id : undefined;
}

/**
 * The sessions the open Claude Code tabs stand for — kept ACTIVE whatever their age, so that a session
 * with a tab is never listed as closed. An ambiguous label goes to the most recently written candidate,
 * as the highlight does; a label no known session fits pins nothing.
 */
export function pinnedSessions(tabs: readonly TabRef[], learned: ReadonlyMap<string, string>, known: readonly Titled[]): string[] {
  const lastOf = (id: string): number => known.find(k => k.sessionId === id)?.lastTs ?? 0;
  const out: string[] = [];
  for (const t of tabs) {
    const ids = candidateSessions(t.label, learned, known);
    if (!ids.length) continue;
    const pick = ids.reduce((best, id) => lastOf(id) > lastOf(best) ? id : best);
    if (!out.includes(pick)) out.push(pick);
  }
  return out;
}

/** An editor group as the on-screen rule sees it: whether it is the active group, and the label of its visible tab if that is a Claude Code tab. */
export interface GroupTab { isActive: boolean; claudeLabel: string | null }

/**
 * The sessions the visible Claude Code tabs show — one per editor group — for the bell's looks (D13).
 * The active group's tab resolves as the highlight does when it is the highlighted tab (the highlight
 * may know which of two same-titled sessions it is); any other by the pin rules.
 */
export function sessionsOnScreen(groups: readonly GroupTab[], highlight: { label: string; id: string | null } | null,
                                 learned: ReadonlyMap<string, string>, known: readonly Titled[]): string[] {
  const out: string[] = [];
  groups.forEach((g, gi) => {
    if (g.claudeLabel === null) return;
    const id = (g.isActive && highlight?.label === g.claudeLabel ? highlight.id : null)
      ?? pinnedSessions([{ key: String(gi), label: g.claudeLabel }], learned, known)[0];
    if (id !== undefined && !out.includes(id)) out.push(id);
  });
  return out;
}

/**
 * Which Claude Code tabs to close for a session. Closing a tab stops the session in it, so a tab
 * is closed only when it can be nobody else's: its label is on no other open tab, and either a
 * trusted learned label names the session or exactly one known session fits the label. A tab that
 * might be the session's but cannot be told apart is returned as `ambiguous` — left open, and said so.
 */
export function tabsToClose(sessionId: string, tabs: readonly TabRef[], learned: ReadonlyMap<string, string>, known: readonly Titled[]): { close: TabRef[]; ambiguous: TabRef[] } {
  const count = new Map<string, number>();
  for (const t of tabs) count.set(t.label, (count.get(t.label) ?? 0) + 1);
  const close: TabRef[] = [], ambiguous: TabRef[] = [];
  for (const t of tabs) {
    const ids = candidateSessions(t.label, learned, known);
    if (!ids.includes(sessionId)) continue;
    if (ids.length === 1 && count.get(t.label) === 1) close.push(t); else ambiguous.push(t);
  }
  return { close, ambiguous };
}

export function buildSnapshot(
  index: SearchIndex | null,
  liveness: ReadonlyMap<string, Liveness>,
  opts: { historyLimit?: number; indexing?: boolean; scope?: SidebarScope; inScope?: (m: SessionMeta) => boolean; rings?: (l: Liveness) => boolean } = {},
): Snapshot {
  const limit = opts.historyLimit ?? 50;
  const byId = new Map<string, SessionMeta>();
  const firstPrompt = index ? firstPrompts(index) : new Map<string, string>();
  if (index) for (const s of index.sessions) byId.set(s.sessionId, s);

  // Scope: a session the index knows and the predicate rejects is another project's. A live session
  // the index has not seen yet stays — it is probably this window's newest, and hiding it would be worse.
  const keep = (m: SessionMeta | undefined): boolean => !m || !opts.inScope || opts.inScope(m);
  const scoped = (index?.sessions ?? []).filter(keep);

  const active: LiveRow[] = [...liveness.values()]
    .filter(l => keep(byId.get(l.sessionId)))
    .sort((a, b) => rank(a) - rank(b) || b.lastWriteMs - a.lastWriteMs)
    .map(l => {
      const m = byId.get(l.sessionId);
      const row: LiveRow = {
        sessionId: l.sessionId, title: titleOf(m, l.sessionId, firstPrompt),
        project: m ? projectLabel(m.projectDir) : '',
        branch: m?.branches.at(-1) ?? null, pr: m?.prLinks.at(-1) ?? null, cwdExists: m?.cwdExists ?? true,
        state: l.state.kind, lastWriteMs: l.lastWriteMs,
      };
      if (l.state.kind === 'attention') row.reason = l.state.reason;
      if (l.state.kind === 'running' && l.state.background) row.background = true;
      if (l.contextTokens !== undefined) row.contextTokens = l.contextTokens;
      if (l.model !== undefined) row.model = l.model;
      if (l.parked) row.parked = true;
      if (opts.rings?.(l)) row.ringing = true;
      return row;
    });

  const history: HistoryRow[] = scoped
    .filter(s => !liveness.has(s.sessionId))
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, limit)
    .map(m => ({
      sessionId: m.sessionId, title: titleOf(m, m.sessionId, firstPrompt), project: projectLabel(m.projectDir),
      branch: m.branches.at(-1) ?? null, pr: m.prLinks.at(-1) ?? null, cwdExists: m.cwdExists,
      lastTs: m.lastTs, msgCount: m.msgCount,
    }));

  return { active, history, totalSessions: scoped.length, indexing: opts.indexing ?? false, scope: opts.scope ?? 'all' };
}
