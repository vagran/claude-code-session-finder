import { stateIcon, stateLabel, type Snapshot, type LiveRow, type HistoryRow, type SearchRow } from '../core/rows.js';

export interface RowVM {
  kind: 'session'; sessionId: string; title: string; meta: string; time: string; iconClass: string;
  state: 'running' | 'attention' | 'history'; reason?: string; missing: boolean;
  /** the best-matching line, on a filter result */
  snippet?: string;
  /** the session behind the active editor tab */
  selected: boolean;
  /** one sentence for the glyph's tooltip */
  stateLabel: string;
  /** how expensive the next turn is: context size against the model's window */
  heat?: Heat;
  /** written longer ago than the active window — here only because its tab is open */
  age?: AgeTag;
  /** the host's word for the same thing: the row sorts in the parked group, below everything live */
  parked?: true;
  /** the bell (D13): the ball is in your court and you have not seen it there — the needs-you look */
  ringing?: true;
}
export interface AgeTag { label: string; title: string; tier: 'old' | 'stale' }
export type HeatTier = 'low' | 'mid' | 'warm' | 'high' | 'full';
export interface Heat { tokens: number; budget: number; pct: number; tier: HeatTier; label: string; title: string }
export interface LinkVM { kind: 'link'; title: string; meta: string; iconClass: string; action: 'search' | 'scope' }
export interface SectionVM {
  id: 'active' | 'history' | 'results'; label: string; count: number; rows: Array<RowVM | LinkVM>;
  empty: string | null; skeleton: boolean;
}
export interface ViewModel { sections: SectionVM[] }
export interface ViewOpts { activeWindowLabel: string; activeWindowMs?: number; searchKey: string; reducedMotion?: boolean; activeId?: string | null; contextBudget?: number }

/** `loading~spin` → `codicon codicon-loading codicon-modifier-spin` (the IDE's own spinner). */
export function iconClass(name: string): string {
  const [base, mod] = name.split('~');
  return `codicon codicon-${base}${mod ? ` codicon-modifier-${mod}` : ''}`;
}

/** The two largest units, no space inside a unit: "40s", "3m", "2h 6m", "2d 1h". Rounded to the minute, then split. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return pair(Math.floor(m / 60), 'h', m % 60, 'm');
  const h = Math.floor(m / 60);
  return pair(Math.floor(h / 24), 'd', h % 24, 'h');
}
const pair = (a: number, au: string, b: number, bu: string): string => b ? `${a}${au} ${b}${bu}` : `${a}${au}`;

/** Spec §10 table, "Time label" column. */
export function timeLabel(row: Pick<LiveRow, 'state' | 'reason' | 'lastWriteMs' | 'background'>, now: number): string {
  const quiet = now - row.lastWriteMs;
  if (row.state === 'running' && row.background) return `background · ${fmtDuration(quiet)}`;
  if (row.state === 'running') return quiet < 45_000 ? 'just now' : `quiet ${fmtDuration(quiet)}`;
  switch (row.reason) {
    case 'tool-or-permission': return `quiet ${fmtDuration(quiet)}`;
    case 'question': return `asks you · ${fmtDuration(quiet)}`;
    case 'your-turn': return `done · ${fmtDuration(quiet)} ago`;
    case 'interrupted': return `interrupted · ${fmtDuration(quiet)}`;
    default: return fmtDuration(quiet);
  }
}

const WINDOW_UNITS: Record<string, string> = { h: 'hour', d: 'day', w: 'week', m: 'month' };
/** "4h" → "4 hours": the activeWindow setting spelled out, for the age tag. Anything unparseable is shown as typed. */
export function fmtWindow(spec: string): string {
  const m = /^(\d+)\s*([hdwm])?$/.exec(spec.trim().toLowerCase());
  if (!m) return spec;
  const n = Number(m[1]); const unit = WINDOW_UNITS[m[2] ?? 'd'] ?? 'day';
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * An ACTIVE session quiet for longer than the window is there only because its tab is open. A standing
 * tag says how long — whole hours, then days and hours ("> 19h", "> 2d 1h") — in place of the corner
 * time it would duplicate (the tooltip keeps that label), orange, and red once it is a day old. The user
 * closes it on purpose.
 */
export function ageTag(row: Pick<LiveRow, 'state' | 'reason' | 'lastWriteMs'>, now: number, opts: ViewOpts): AgeTag | undefined {
  const quiet = now - row.lastWriteMs;
  if (!opts.activeWindowMs || quiet <= opts.activeWindowMs) return undefined;
  const hours = Math.floor(quiet / 3_600_000);
  return { label: `> ${hours >= 24 ? pair(Math.floor(hours / 24), 'd', hours % 24, 'h') : `${hours}h`}`, tier: hours >= 24 ? 'stale' : 'old',
           title: `${timeLabel(row, now)} — more than ${fmtWindow(opts.activeWindowLabel)} since anything happened here; it is listed because its tab is open. Press × or close the tab to move it under Closed.` };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function historyLabel(row: HistoryRow): string {
  const d = new Date(row.lastTs);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} · ${row.msgCount} msgs`;
}

export function metaLabel(r: { project: string; branch: string | null; pr: number | null }): string {
  return [r.project, r.branch ?? '', r.pr ? `PR #${r.pr}` : ''].filter(Boolean).join(' · ');
}

export const fmtTokens = (n: number): string => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

export const DEFAULT_CONTEXT_BUDGET = 1_000_000;

/**
 * Cost meter for a row, on ONE absolute scale for every session: a 420k context is a 420k context
 * whichever model holds it. `budget` is where compaction lands (a setting; 1M by default). The ramp
 * is green → yellow → orange → red, and past the budget the bar is pinned full in deep red: the
 * message is "compact or start a new session", and it stays on until you do.
 */
export function heatOf(tokens: number, budget = DEFAULT_CONTEXT_BUDGET): Heat {
  const b = Math.max(1, budget);
  const ratio = tokens / b;
  const pct = Math.min(100, Math.round(ratio * 100));
  const tier: HeatTier = ratio >= 1 ? 'full' : ratio >= 0.8 ? 'high' : ratio >= 0.6 ? 'warm' : ratio >= 0.35 ? 'mid' : 'low';
  const advice = tier === 'full' ? ' — past the budget: compact or start a new session'
    : tier === 'high' ? ' — compaction is near; consider compacting or starting fresh'
    : tier === 'warm' ? ' — getting heavy' : '';
  return { tokens, budget: b, pct, tier, label: fmtTokens(tokens),
           title: `Context ${fmtTokens(tokens)} of a ${fmtTokens(b)} budget (${pct}%): the tokens re-sent on every turn${advice}` };
}

// Under reduced motion the spinner becomes a static dot in the running colour (spec §10).
const runningIcon = (reducedMotion?: boolean, background?: true): string =>
  reducedMotion ? (background ? 'circle-large' : 'circle-large-filled') : background ? 'sync~spin' : 'loading~spin';

function liveRow(r: LiveRow, now: number, opts: ViewOpts): RowVM {
  const vm: RowVM = {
    kind: 'session', sessionId: r.sessionId, title: r.title, meta: metaLabel(r), time: timeLabel(r, now),
    iconClass: iconClass(r.state === 'running' ? runningIcon(opts.reducedMotion, r.background) : stateIcon(r)), state: r.state,
    missing: !r.cwdExists, selected: r.sessionId === opts.activeId, stateLabel: stateLabel(r),
  };
  if (r.reason) vm.reason = r.reason;
  if (r.contextTokens) vm.heat = heatOf(r.contextTokens, opts.contextBudget);
  const age = ageTag(r, now, opts);
  if (age) vm.age = age;
  if (r.parked) vm.parked = true;
  if (r.ringing) vm.ringing = true;
  return vm;
}

function historyRow(r: HistoryRow, opts: ViewOpts): RowVM {
  return {
    kind: 'session', sessionId: r.sessionId, title: r.title, meta: metaLabel(r), time: historyLabel(r),
    iconClass: iconClass('history'), state: 'history', missing: !r.cwdExists, selected: r.sessionId === opts.activeId,
    stateLabel: 'Closed · click to resume',
  };
}

export function viewModel(s: Snapshot, now: number, opts: ViewOpts): ViewModel {
  const active: RowVM[] = s.active.map(r => liveRow(r, now, opts));
  const history: Array<RowVM | LinkVM> = s.history.map(r => historyRow(r, opts));
  if (!s.indexing) {
    history.push({ kind: 'link', title: `Search all ${s.totalSessions} sessions…`, meta: opts.searchKey,
                   iconClass: iconClass('search'), action: 'search' });
    history.push(s.scope === 'workspace'
      ? { kind: 'link', title: 'This workspace only · show all projects', meta: '', iconClass: iconClass('filter-filled'), action: 'scope' }
      : { kind: 'link', title: 'All projects · show this workspace only', meta: '', iconClass: iconClass('filter'), action: 'scope' });
  }

  // HISTORY in the data model (spec §6: everything not ACTIVE) is labelled Closed in the view: the × on an
  // active row puts a session here by closing its tab, and clicking a row here resumes it.
  const historyCount = Math.max(0, s.totalSessions - s.active.length);
  return {
    sections: [
      { id: 'active', label: 'Active', count: active.length, rows: active, skeleton: false,
        empty: active.length ? null : `Nothing running${s.scope === 'workspace' ? ' in this workspace' : ''}. Sessions touched in the last ${opts.activeWindowLabel}, or open in a tab, appear here.` },
      { id: 'history', label: 'Closed', count: historyCount, rows: history,
        skeleton: s.indexing && history.length === 0, empty: null },
    ],
  };
}

/** The group an ACTIVE row is ordered within: its state and reason, or parked whatever its state. */
export const orderGroup = (r: { state: string; reason?: string; parked?: true }): string =>
  r.parked ? 'parked' : `${r.state}/${r.reason ?? ''}`;

/** When each ACTIVE row arrived in its group — a stamp, higher = later — persisted with the webview. */
export interface Arrivals { n: number; at: Record<string, { n: number; group: string }> }

/**
 * Stamp the rows that arrived in a group since the last snapshot — new to ACTIVE, back in it, or in a new
 * state — with the next numbers (host order top→bottom becoming high→low), so each enters its group at
 * the top: a session you just started, resumed or that just finished is the first of its kind. A row that
 * stays in its group keeps its stamp however often it writes; a row gone from ACTIVE is forgotten.
 */
export function noteArrivals(prev: Arrivals | undefined, active: readonly LiveRow[]): Arrivals {
  let n = prev?.n ?? 0;
  const at: Arrivals['at'] = {};
  const arrived: LiveRow[] = [];
  for (const r of active) {
    const was = prev?.at[r.sessionId];
    if (was && was.group === orderGroup(r)) at[r.sessionId] = was; else arrived.push(r);
  }
  for (const r of arrived.reverse()) at[r.sessionId] = { n: ++n, group: orderGroup(r) };
  return { n, at };
}

/**
 * Keep rows where they are. The host orders each urgency group by last write, so two running sessions
 * swap every time one of them writes. Within each contiguous group the rows are ordered by arrival
 * instead (noteArrivals: newest on top); a row moves only when its state changes. Parked rows keep the
 * host's order — youngest first, and nothing in there writes. Link rows stay put.
 */
export function stableOrder(rows: Array<RowVM | LinkVM>, arrivals: Arrivals): Array<RowVM | LinkVM> {
  const out: Array<RowVM | LinkVM> = [];
  let group: RowVM[] = []; let key: string | null = null;
  const stamp = (r: RowVM): number => arrivals.at[r.sessionId]?.n ?? 0;
  const flush = (): void => {
    out.push(...(key === 'parked' ? group : group.sort((a, b) => stamp(b) - stamp(a))));
    group = [];
  };
  for (const r of rows) {
    if (r.kind === 'link') { flush(); key = null; out.push(r); continue; }
    const k = orderGroup(r);
    if (k !== key) { flush(); key = k; }
    group.push(r);
  }
  flush();
  return out;
}

/**
 * The list while the inline filter has text: one RESULTS section in place of ACTIVE and HISTORY.
 * Rows keep their live glyph and time so a running match still reads as running; each carries the
 * matching line. `rows === null` means the host has not answered yet (skeleton).
 */
export function resultsModel(
  rows: SearchRow[] | null, q: string, deep: boolean, now: number, opts: ViewOpts,
): ViewModel {
  const vms: RowVM[] = (rows ?? []).map(r => {
    const vm: RowVM = r.live
      ? liveRow({ ...r, state: r.live.state, lastWriteMs: r.live.lastWriteMs, ...(r.live.reason ? { reason: r.live.reason } : {}), ...(r.live.background ? { background: true as const } : {}), ...(r.live.ringing ? { ringing: true as const } : {}) }, now, opts)
      : historyRow(r, opts);
    if (r.snippet) vm.snippet = r.snippet;
    return vm;
  });
  const empty = rows === null ? null
    : deep ? `Deep (!) searches read whole transcripts — run them in the picker (${opts.searchKey}).`
    : vms.length ? null : `No sessions match “${q.trim()}”.`;
  return { sections: [{ id: 'results', label: 'Results', count: vms.length, rows: vms, skeleton: rows === null && !deep, empty }] };
}
