import type { SearchIndex, SessionMeta, Role } from './types.js';

export interface ParsedQuery {
  terms: string[]; phrase: string | null; pr: number | null;
  sinceMs: number | null; deep: boolean; raw: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const UNIT: Record<string, number> = { h: HOUR, d: DAY, w: 7 * DAY, m: 30 * DAY };
const SPEC = /^(\d+)([hdwm])?$/;

/**
 * Duration a window spec denotes ("4h", "2d", "1w", bare digits = days), or `fallbackMs`
 * when the spec is unparseable or "all". Used for sessionOrganizer.activeWindow (spec L6).
 */
export function durationMs(spec: string, fallbackMs: number): number {
  const m = SPEC.exec(spec.trim().toLowerCase());
  if (!m) return fallbackMs;
  return Number(m[1]) * (UNIT[m[2] ?? 'd'] ?? DAY);
}

/** null = explicit "all time"; undefined = unparseable (caller should fall back) */
function windowToMs(spec: string, now: number): number | null | undefined {
  const s = spec.trim().toLowerCase();
  if (!s || s === 'all') return null;
  const m = SPEC.exec(s);
  if (!m) return undefined;
  return now - Number(m[1]) * (UNIT[m[2] ?? 'd'] ?? DAY);
}

/** Resolve a since: spec, falling back to defaultWindow when spec is unparseable. */
function resolveSince(spec: string, defaultWindow: string, now: number): number | null {
  const primary = windowToMs(spec, now);
  if (primary !== undefined) return primary;
  const fallback = windowToMs(defaultWindow, now);
  return fallback === undefined ? null : fallback;
}

/**
 * The one owner of "where is the quoted phrase" — both parseQuery (below) and withWindow
 * need it, and having two independent implementations of this boundary is what let an
 * earlier since: strip in the QuickPick surface reach inside a quoted phrase.
 * `closed: false` means an unterminated quote, treated as running to the end of the string.
 */
function quoteRegion(s: string): { start: number; end: number; closed: boolean } | null {
  const start = s.indexOf('"');
  if (start < 0) return null;
  const close = s.indexOf('"', start + 1);
  return close >= 0 ? { start, end: close + 1, closed: true } : { start, end: s.length, closed: false };
}

export function parseQuery(input: string, defaultWindow: string, now: number): ParsedQuery {
  const raw = input;
  let rest = input.trim();
  const deep = rest.startsWith('!');
  if (deep) rest = rest.slice(1).trim();

  let phrase: string | null = null;
  const region = quoteRegion(rest);
  if (region) {
    if (region.closed) {
      const inner = rest.slice(region.start + 1, region.end - 1);
      phrase = inner.length ? inner.toLowerCase() : null;
      rest = rest.slice(0, region.start) + ' ' + rest.slice(region.end);
    } else {
      // Unterminated quote: treat as a phrase still being typed.
      const inner = rest.slice(region.start + 1).trim();
      phrase = inner.length ? inner.toLowerCase() : null;
      rest = rest.slice(0, region.start);
    }
  }
  // Only the first quote-delimited (or unterminated) region becomes the phrase;
  // any further " characters are noise and must never reach the term tokenizer.
  rest = rest.replace(/"/g, ' ');

  // M6: /g, like withWindow's SINCE_CLAUSE. Non-global left `foo pr:1 pr:2` with a
  // literal "pr:2" in the search terms; last clause wins, and none survives as a term.
  let pr: number | null = null;
  rest = rest.replace(/(?:^|\s)pr:#?(\d+)(?=\s|$)/gi, (_, n: string) => { pr = Number(n); return ' '; });

  let sinceSpec: string | null = null;
  rest = rest.replace(/(?:^|\s)since:(\S+)(?=\s|$)/gi, (_, v: string) => { sinceSpec = v; return ' '; });

  return {
    raw, deep, phrase, pr,
    sinceMs: resolveSince(sinceSpec ?? defaultWindow, defaultWindow, now),
    terms: rest.toLowerCase().split(/\s+/).filter(Boolean),
  };
}

const SINCE_CLAUSE = /(?:^|\s)since:\S+(?=\s|$)/gi;

/**
 * Set the recency window on a raw query string, replacing any existing since: clause(s).
 * The quoted-phrase region is located with the SAME quoteRegion parseQuery uses, and — I1
 * — read with the same semantics: an UNCLOSED region is a phrase that runs to the end of
 * the string, so appending after it would swallow the clause into the phrase
 * (`"paste image` -> `"paste image since:all"`, which matches nothing and grows on every
 * press). For that case the clause goes in FRONT of the region instead. Chosen over
 * closing the quote because it leaves the half-typed phrase byte-identical and keeps the
 * caret at its end, so the user can carry on typing into the phrase.
 * Idempotent in both cases, and never leaves more than one since: clause.
 */
export function withWindow(input: string, spec: string): string {
  const clause = `since:${spec}`;
  const strip = (s: string) => s.replace(SINCE_CLAUSE, ' ').trim();
  const region = quoteRegion(input);
  if (!region) return [strip(input), clause].filter(Boolean).join(' ');

  const before = strip(input.slice(0, region.start));
  const quoted = input.slice(region.start, region.end);      // copied through byte-identical
  if (!region.closed) return [before, clause, quoted].filter(Boolean).join(' ');
  return [before, quoted, strip(input.slice(region.end)), clause].filter(Boolean).join(' ');
}

const ROLE_WEIGHT: Record<Role, number> = { t: 3.0, u: 2.0, a: 1.0, sub: 0.7 };

/** exact phrase 3.0 · all terms within a 40-char span 2.0 · all terms present 1.0 · else 0 */
function matchQuality(lower: string, q: ParsedQuery): { score: number; at: number } {
  if (q.phrase) { const at = lower.indexOf(q.phrase); return { score: at >= 0 ? 3.0 : 0, at: Math.max(at, 0) }; }
  if (!q.terms.length) return { score: 0, at: 0 };
  const positions: number[] = [];
  for (const t of q.terms) { const at = lower.indexOf(t); if (at < 0) return { score: 0, at: 0 }; positions.push(at); }
  const lo = Math.min(...positions), hi = Math.max(...positions);
  return { score: hi - lo <= 40 ? 2.0 : 1.0, at: lo };
}

const recencyBoost = (t: number, now: number) => 1 + 0.5 * Math.exp(-Math.max(0, now - t) / (14 * DAY));

export interface SessionHit {
  session: SessionMeta; score: number; matchCount: number;
  best: { text: string; role: Role; index: number } | null;
}

export function search(index: SearchIndex, q: ParsedQuery, now: number): SessionHit[] {
  const inWindow = (m: SessionMeta) => q.sinceMs === null || m.lastTs >= q.sinceMs;

  if (q.pr !== null) {
    // Deliberately NOT date-filtered. A PR number is a globally unique identifier: if the
    // user types pr:18942 there is exactly one right answer and its age is irrelevant.
    // Applying the recency window here hid 55% of the author's PRs behind the 7-day default.
    return index.sessions
      .filter(m => m.prLinks.includes(q.pr!))
      .map(session => ({ session, score: 1000, matchCount: 1, best: null }));
  }
  if (!q.terms.length && !q.phrase) return [];

  const acc = new Map<number, { score: number; count: number; best: SessionHit['best'] }>();
  for (const p of index.prose) {
    const session = index.sessions[p.s];
    if (!session || !inWindow(session)) continue;
    const { score: quality, at } = matchQuality(p.x.toLowerCase(), q);
    if (!quality) continue;
    const score = quality * ROLE_WEIGHT[p.r] * recencyBoost(p.t, now);
    const cur = acc.get(p.s);
    if (!cur) acc.set(p.s, { score, count: 1, best: { text: p.x, role: p.r, index: at } });
    else {
      cur.count++;
      if (score > cur.score) { cur.score = score; cur.best = { text: p.x, role: p.r, index: at }; }
    }
  }

  return [...acc.entries()]
    .map(([s, v]) => ({
      session: index.sessions[s]!,
      score: v.score + 0.3 * Math.log1p(v.count),
      matchCount: v.count, best: v.best,
    }))
    .sort((a, b) => b.score - a.score || b.session.lastTs - a.session.lastTs);
}

export function snippet(text: string, at: number, pad = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const clampedAt = Math.min(Math.max(at, 0), flat.length);
  const start = Math.max(0, clampedAt - pad), end = Math.min(flat.length, clampedAt + pad);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}
