/// <reference lib="dom" />
// The sidebar browser's DOM glue. Everything with logic is in model.ts (tested); this file only
// turns a ViewModel into elements and user gestures into messages (spec §9.1).
//
// Rendering is a keyed reconciliation, not a rebuild: a snapshot arrives every two seconds while
// anything is running, and rebuilding the list on each one replayed every row's fade-in and dropped
// the hover state under the pointer — the list flickered. Rows are keyed by session id and updated
// in place; only a row that is new fades in; a row that changes position slides (FLIP); and while
// the pointer is over the list the order is held until it leaves.
import { viewModel, resultsModel, stableOrder, noteArrivals, timeLabel, ageTag, type Arrivals, type ViewModel, type ViewOpts, type SectionVM, type RowVM, type LinkVM, type AgeTag } from './model.js';
import type { Snapshot, SearchRow } from '../core/rows.js';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
const api = acquireVsCodeApi();

type Inbound =
  | { type: 'snapshot'; snapshot: Snapshot; now: number; activeWindow: string; activeWindowMs: number; contextBudget: number; active: string | null }
  | { type: 'results'; q: string; deep: boolean; rows: SearchRow[]; now: number; indexing: boolean }
  | { type: 'active'; sessionId: string | null }
  | { type: 'focusFilter'; q?: string };
interface UiState { collapsed: Record<string, boolean>; filter?: string; arrivals?: Arrivals }

let snapshot: Snapshot | null = null;
let results: { q: string; deep: boolean; rows: SearchRow[] } | null = null;
let activeId: string | null = null;
let scrolledTo: string | null = null;       // the selected row we last scrolled into view
let clockOffset = 0;                       // host clock − webview clock; labels use the host's clock
let activeWindow = '4h';
let activeWindowMs = 4 * 3_600_000;
let contextBudget = 1_000_000;
let orderPending = false;                  // a reorder arrived while the pointer was over the list
const ui: UiState = (api.getState() as UiState | undefined) ?? { collapsed: {} };
for (const k of ['seen', 'seenN']) delete (ui as unknown as Record<string, unknown>)[k];   // 0.7.x's first-seen order; 0.8.0 keeps arrivals
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const searchKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘⌥S' : 'Ctrl+Alt+S';
const root = document.getElementById('app') as HTMLElement;

const post = (message: unknown): void => api.postMessage(message);

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) el.append(c);
  return el;
}

/** Tooltips are our own (`.tip[data-tip]`, style.css): native `title` bubbles are slow and easy to miss in a webview. */
function actionButton(icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', { class: 'action tip', 'data-tip': label, 'aria-label': label },
    h('i', { class: `codicon codicon-${icon}`, 'aria-hidden': 'true' }));
  b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return b;
}

// ---------------------------------------------------------------- the filter bar (built once: it holds focus and caret)

const filterInput = h('input', {
  class: 'filter__input', type: 'text', spellcheck: 'false', 'aria-label': 'Filter sessions',
  placeholder: 'Filter sessions — words, "phrase", pr:123, since:all',
});
const filterBar = h('div', { class: 'filter' },
  h('i', { class: 'filter__icon codicon codicon-search', 'aria-hidden': 'true' }),
  filterInput,
  actionButton('close', 'Clear filter', () => setFilter('')));
const sectionsEl = h('div', { class: 'sections' });
root.append(filterBar, sectionsEl);

const filtering = (): boolean => (ui.filter ?? '').trim().length > 0;
const firstRow = (): HTMLElement | null => sectionsEl.querySelector<HTMLElement>('.row');
let filterTimer: number | undefined;

/** The filter runs the host's search (debounced) and swaps the list for RESULTS; empty text restores the list. */
function setFilter(q: string, fromInput = false): void {
  ui.filter = q; api.setState(ui);
  if (!fromInput) filterInput.value = q;
  filterBar.dataset.active = String(q.trim().length > 0);
  window.clearTimeout(filterTimer);
  if (!q.trim()) { results = null; render(true); return; }
  if (results?.q !== q) { results = null; render(true); }     // skeleton until the host answers
  filterTimer = window.setTimeout(() => post({ type: 'filter', q }), 120);
}
filterInput.value = ui.filter ?? '';
filterBar.dataset.active = String(filtering());
filterInput.addEventListener('input', () => setFilter(filterInput.value, true));
// No stopPropagation here: VS Code's webview host listens on the window and performs Cmd+V, Cmd+A, Cmd+Z…
// for a webview, so a keydown that never reaches it does nothing. The list's handler skips the filter's keys.
filterInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); if (filterInput.value) setFilter(''); else firstRow()?.focus(); }
  else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); firstRow()?.focus(); }
});
const focusFilter = (): void => { filterInput.focus(); filterInput.select(); };
const linkAction = (a: LinkVM['action']): void => { if (a === 'search') focusFilter(); else post({ type: 'toggleScope' }); };

// ---------------------------------------------------------------- rows

const keyOf = (r: RowVM | LinkVM): string => r.kind === 'link' ? `link:${r.action}` : r.sessionId;

/** Bring an existing row's attributes and text in line with its model. Structure never changes, so no rebuild. */
function updateRow(li: HTMLLIElement, r: RowVM | LinkVM): void {
  const text = (sel: string, value: string): void => {
    const el = li.querySelector<HTMLElement>(sel);
    if (el && el.textContent !== value) el.textContent = value;
  };
  if (r.kind === 'link') { text('.row__title', r.title); text('.row__time', r.meta); li.querySelector('.row__icon')!.className = `row__icon ${r.iconClass}`; return; }
  li.className = `row${r.snippet ? ' row--snippet' : ''}`;
  li.dataset.state = r.state;
  if (r.reason) li.dataset.reason = r.reason; else delete li.dataset.reason;
  if (r.ringing) li.dataset.ringing = 'true'; else delete li.dataset.ringing;
  // The full title, natively, on the title only: on the whole row it came up a second after any of our own
  // tooltips (state glyph, age tag, meter, buttons) and covered them.
  li.removeAttribute('title');
  li.querySelector<HTMLElement>('.row__title')!.title = r.title;
  li.setAttribute('aria-selected', String(r.selected));
  li.querySelector<HTMLElement>('.action--close')!.hidden = r.state === 'history';   // nothing to close on a closed row
  const icon = li.querySelector<HTMLElement>('.row__icon')!;
  icon.className = `row__icon tip tip--left ${r.iconClass}`; icon.dataset.tip = r.stateLabel; icon.setAttribute('aria-label', r.stateLabel);
  text('.row__title', r.title); text('.row__time', r.age ? '' : r.time);   // the age tag stands in for the time
  const meta = li.querySelector<HTMLElement>('.row__meta')!;
  const metaText = r.meta + (r.missing ? '⚠ folder missing' : '');
  if (meta.textContent !== metaText) {
    meta.replaceChildren(r.meta);
    if (r.missing) meta.append(h('span', { class: 'row__missing' }, '⚠ folder missing'));
  }
  const heat = li.querySelector<HTMLElement>('.row__heat')!;
  if (r.heat) {
    li.dataset.heat = r.heat.tier;
    if (!heat.firstChild) heat.append(h('span', { class: 'heat__track' }, h('span', { class: 'heat__fill' })), h('span', { class: 'heat__label' }));
    heat.dataset.tip = r.heat.title; heat.setAttribute('aria-label', r.heat.title);
    heat.querySelector<HTMLElement>('.heat__fill')!.style.width = `${r.heat.pct}%`;
    const label = heat.querySelector<HTMLElement>('.heat__label')!;
    if (label.textContent !== r.heat.label) label.textContent = r.heat.label;
  } else if (heat.firstChild) { heat.replaceChildren(); delete heat.dataset.tip; heat.removeAttribute('aria-label'); delete li.dataset.heat; }
  setAge(li.querySelector<HTMLElement>('.row__age')!, r.age);
  const snippet = li.querySelector<HTMLElement>('.row__snippet');
  if (r.snippet && !snippet) li.querySelector('.row__lines')!.append(h('span', { class: 'row__snippet' }, r.snippet));
  else if (r.snippet && snippet) { if (snippet.textContent !== r.snippet) snippet.textContent = r.snippet; }
  else snippet?.remove();
}

/** The age tag: text when the session is past the window, empty (and hidden by CSS) otherwise. */
function setAge(el: HTMLElement, age: AgeTag | undefined): void {
  if (!age) { if (el.textContent) { el.textContent = ''; delete el.dataset.tip; delete el.dataset.tier; el.removeAttribute('aria-label'); } return; }
  if (el.textContent !== age.label) el.textContent = age.label;
  el.dataset.tier = age.tier; el.dataset.tip = age.title; el.setAttribute('aria-label', age.title);
}

function rowEl(r: RowVM | LinkVM): HTMLLIElement {
  if (r.kind === 'link') {
    const li = h('li', { class: 'row row--link', role: 'option', tabindex: '-1', 'data-action': r.action, 'data-key': keyOf(r) },
      h('i', { class: `row__icon ${r.iconClass}`, 'aria-hidden': 'true' }),
      h('span', { class: 'row__lines' }, h('span', { class: 'row__line' },
        h('span', { class: 'row__title' }, r.title),
        h('span', { class: 'row__time' }, r.meta))));
    li.addEventListener('click', () => linkAction(r.action));
    return li;
  }
  const id = r.sessionId;
  const li = h('li', { class: 'row', role: 'option', tabindex: '-1', 'data-id': id, 'data-key': keyOf(r) });
  // Click resumes in the right panel, so no button repeats that; one opens it in a tab instead. Then three that
  // look, each saying what, and the one that closes.
  const close = actionButton('close', 'Close: move to Closed and close its tab (Delete)', () => post({ type: 'close', sessionId: id }));
  close.classList.add('action--close');
  const actions = h('span', { class: 'row__actions' },
    actionButton('window', 'Resume in a tab (Shift+Enter)', () => post({ type: 'open', sessionId: id, where: 'tab' })),
    actionButton('type-hierarchy', 'Read it here: agents, timeline, transcript (V)', () => post({ type: 'view', sessionId: id })),
    actionButton('link', 'Copy a link that reopens this session', () => post({ type: 'copyLink', sessionId: id })),
    actionButton('file-code', 'Open the raw transcript file (T)', () => post({ type: 'transcript', sessionId: id })),
    close,
  );
  // Two lines that size on their own. Line 1: title, then the time, then the actions in a spot that is
  // theirs whether or not they show — the × in the top-right corner. Line 2: project · branch, then the
  // age tag (which stands in for the time on an old row), then the cost meter. Nothing moves on hover.
  li.append(
    h('i', { class: 'row__icon', role: 'img' }),
    h('span', { class: 'row__lines' },
      h('span', { class: 'row__line' },
        h('span', { class: 'row__title' }),
        h('span', { class: 'row__end' }, h('span', { class: 'row__time' })),
        actions),
      h('span', { class: 'row__line' },
        h('span', { class: 'row__meta' }),
        h('span', { class: 'row__age tip' }),
        h('span', { class: 'row__heat tip', role: 'img' }))),
  );
  li.addEventListener('click', () => post({ type: 'open', sessionId: id, where: 'right' }));
  updateRow(li, r);
  return li;
}

/**
 * Make `ul` show `rows`, touching as little as possible. Existing rows are updated in place; new ones
 * are created (and fade in); gone ones are removed. If the order changed and the pointer is over the
 * list, existing rows stay where they are (`hold`) and the caller is told; otherwise rows move with a
 * FLIP slide. Returns whether a reorder was deferred.
 */
function reconcileList(ul: HTMLUListElement, rows: Array<RowVM | LinkVM>, hold: boolean): boolean {
  const existing = new Map<string, HTMLLIElement>();
  const before = new Map<string, number>();
  for (const li of Array.from(ul.children) as HTMLLIElement[]) {
    const k = li.dataset.key ?? '';
    existing.set(k, li);
    before.set(k, li.getBoundingClientRect().top);
  }
  const desired = rows.map(r => {
    const k = keyOf(r);
    const li = existing.get(k);
    if (li) { updateRow(li, r); existing.delete(k); return li; }
    const fresh = rowEl(r);
    fresh.classList.add('row--new');
    fresh.addEventListener('animationend', () => fresh.classList.remove('row--new'), { once: true });
    return fresh;
  });
  for (const li of existing.values()) li.remove();
  const current = Array.from(ul.children);
  const sameOrder = current.length === desired.length && current.every((li, i) => li === desired[i]);
  if (sameOrder) return false;
  if (hold) {
    // keep what is on screen where it is; only new rows join, at the end of their section
    for (const li of desired) if (!li.isConnected) ul.append(li);
    return true;
  }
  for (const li of desired) ul.append(li);                     // appending a connected node moves it
  if (!reducedMotion) {
    for (const li of desired) {
      const from = before.get(li.dataset.key ?? '');
      if (from === undefined) continue;
      const dy = from - li.getBoundingClientRect().top;
      if (!dy) continue;
      li.style.transition = 'none'; li.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        li.style.transition = 'transform 220ms var(--ease)'; li.style.transform = '';
        li.addEventListener('transitionend', () => { li.style.transition = ''; }, { once: true });
      });
    }
  }
  return false;
}

// ---------------------------------------------------------------- sections

function skeletonEl(): HTMLElement[] {
  return [0, 1, 2].map(i => h('div', { class: 'skeleton' }, h('span', {}),
    h('span', { class: `skeleton__bar${i % 2 ? ' skeleton__bar--short' : ''}` })));
}

/** Find or create the section, update its header, then reconcile its body. */
function reconcileSection(s: SectionVM, hold: boolean): { el: HTMLElement; deferred: boolean } {
  const collapsed = s.id !== 'results' && ui.collapsed[s.id] === true;
  let el = sectionsEl.querySelector<HTMLElement>(`section[data-id="${s.id}"]`);
  if (!el) {
    const header = h('button', { class: 'section__header' },
      h('i', { class: 'section__chevron codicon codicon-chevron-down', 'aria-hidden': 'true' }),
      h('span', { class: 'section__label' }, s.label),
      h('span', { class: 'section__count' }, String(s.count)));
    header.addEventListener('click', () => { ui.collapsed[s.id] = !(ui.collapsed[s.id] === true); api.setState(ui); render(true); });
    el = h('section', { class: 'section', 'data-id': s.id }, header, h('div', { class: 'section__body' }));
  }
  el.dataset.collapsed = String(collapsed);
  el.querySelector('.section__header')!.setAttribute('aria-expanded', String(!collapsed));
  const count = el.querySelector<HTMLElement>('.section__count')!;
  if (count.textContent !== String(s.count)) count.textContent = String(s.count);
  const body = el.querySelector<HTMLElement>('.section__body')!;
  if (s.skeleton) { if (!body.querySelector('.skeleton')) body.replaceChildren(...skeletonEl()); return { el, deferred: false }; }
  if (s.empty) { const cur = body.querySelector('.empty'); if (!cur || cur.textContent !== s.empty) body.replaceChildren(h('div', { class: 'empty' }, s.empty)); return { el, deferred: false }; }
  let ul = body.querySelector<HTMLUListElement>('ul.list');
  if (!ul) { ul = h('ul', { class: 'list', role: 'listbox', 'aria-label': s.label }); body.replaceChildren(ul); }
  return { el, deferred: reconcileList(ul, s.rows, hold) };
}

const hostNow = (): number => Date.now() + clockOffset;
const viewOpts = (): ViewOpts => ({ activeWindowLabel: activeWindow, activeWindowMs, searchKey, reducedMotion, activeId, contextBudget });

/** Arrival order of ACTIVE sessions (noteArrivals), persisted with the webview so a reload keeps the list as it was. */
function stampArrivals(s: Snapshot): Arrivals {
  ui.arrivals = noteArrivals(ui.arrivals, s.active);
  api.setState(ui);
  return ui.arrivals;
}

/** `force`: a user action (filter, collapse, mode switch) — never hold the order for those. */
function render(force = false): void {
  if (!snapshot) return;
  const focusedId = (document.activeElement as HTMLElement | null)?.dataset.id;
  const opts = viewOpts();
  const q = ui.filter ?? '';
  const vm: ViewModel = filtering()
    ? resultsModel(results && results.q === q ? results.rows : null, q, results?.deep ?? false, hostNow(), opts)
    : viewModel(snapshot, hostNow(), opts);
  if (!filtering()) {
    const arrivals = stampArrivals(snapshot);
    for (const s of vm.sections) if (s.id === 'active') s.rows = stableOrder(s.rows, arrivals);
  }
  const hold = !force && sectionsEl.matches(':hover');
  let deferred = false;
  const els = vm.sections.map(s => { const r = reconcileSection(s, hold); deferred = deferred || r.deferred; return r.el; });
  const wanted = new Set(vm.sections.map(s => s.id));
  for (const el of Array.from(sectionsEl.querySelectorAll<HTMLElement>('section[data-id]'))) if (!wanted.has(el.dataset.id as SectionVM['id'])) el.remove();
  els.forEach((el, i) => { if (sectionsEl.children[i] !== el) sectionsEl.insertBefore(el, sectionsEl.children[i] ?? null); });
  orderPending = deferred;
  if (focusedId) sectionsEl.querySelector<HTMLElement>(`[data-id="${focusedId}"]`)?.focus();
  // Follow the active tab into view once per change — not on every snapshot, which would fight the user's scrolling.
  if (activeId && activeId !== scrolledTo) {
    const sel = sectionsEl.querySelector<HTMLElement>('.row[aria-selected="true"]');
    if (sel) { sel.scrollIntoView({ block: 'nearest' }); scrolledTo = activeId; }
  }
}
sectionsEl.addEventListener('mouseleave', () => { if (orderPending) render(true); });

/** Between snapshots only the relative-time labels change (spec §8) — update those, and the age tag a session may just have earned, not the tree. */
function refreshTimes(): void {
  if (!snapshot) return;
  const now = hostNow(); const opts = viewOpts();
  const rows = filtering() ? (results?.rows ?? []).flatMap(r => r.live ? [{ sessionId: r.sessionId, ...r.live }] : []) : snapshot.active;
  for (const r of rows) {
    const li = sectionsEl.querySelector<HTMLElement>(`.row[data-id="${r.sessionId}"]`);
    if (!li) continue;
    const age = ageTag(r, now, opts);
    const el = li.querySelector<HTMLElement>('.row__time');
    const label = age ? '' : timeLabel(r, now);
    if (el && el.textContent !== label) el.textContent = label;
    const ageEl = li.querySelector<HTMLElement>('.row__age');
    if (ageEl) setAge(ageEl, age);
  }
}

/** Roving focus: ↑/↓ move, Enter opens in the right panel, Shift+Enter in a tab, T transcript, V view, Delete closes, / filter. */
root.addEventListener('keydown', e => {
  if (e.target === filterInput || e.metaKey || e.ctrlKey || e.altKey) return;   // typing, or a chord for VS Code (Cmd+V is not V)
  const rows = Array.from(sectionsEl.querySelectorAll<HTMLElement>('.row'));   // not [...], which needs lib dom.iterable
  const current = document.activeElement as HTMLElement | null;
  const i = current ? rows.indexOf(current) : -1;
  const focus = (j: number) => rows[Math.max(0, Math.min(rows.length - 1, j))]?.focus();
  const id = current?.dataset.id;
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); focus(i + 1); break;
    case 'ArrowUp':   e.preventDefault(); if (i <= 0) focusFilter(); else focus(i - 1); break;
    case 'Home':      e.preventDefault(); focus(0); break;
    case 'End':       e.preventDefault(); focus(rows.length - 1); break;
    case 'Enter':
      e.preventDefault();
      if (id) post({ type: 'open', sessionId: id, where: e.shiftKey ? 'tab' : 'right' });
      else if (current?.dataset.action) linkAction(current.dataset.action as LinkVM['action']);
      break;
    case 't': case 'T': if (id) post({ type: 'transcript', sessionId: id }); break;
    case 'v': case 'V': if (id) post({ type: 'view', sessionId: id }); break;
    case 'Delete': case 'Backspace': if (id) { e.preventDefault(); post({ type: 'close', sessionId: id }); } break;   // the host ignores a closed row
    case '/': e.preventDefault(); focusFilter(); break;
    case 'Escape': if (filtering()) setFilter(''); else current?.blur(); break;
  }
});
// Tab lands on <main>; hand focus to the first row so the roving list takes over.
root.addEventListener('focus', () => firstRow()?.focus());

window.addEventListener('message', (e: MessageEvent<Inbound>) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'snapshot': {
      const scopeChanged = snapshot !== null && snapshot.scope !== m.snapshot.scope;
      snapshot = m.snapshot; activeWindow = m.activeWindow; activeWindowMs = m.activeWindowMs; contextBudget = m.contextBudget; clockOffset = m.now - Date.now(); activeId = m.active;
      render(scopeChanged);
      if (filtering()) post({ type: 'filter', q: ui.filter ?? '' });   // the index moved; re-ask so results stay current
      return;
    }
    case 'results':
      if (m.q !== (ui.filter ?? '')) return;                           // a stale answer for text we left behind
      results = { q: m.q, deep: m.deep, rows: m.rows }; clockOffset = m.now - Date.now();
      render(true);
      return;
    case 'active':
      if (m.sessionId === activeId) return;
      activeId = m.sessionId; render();
      return;
    case 'focusFilter':
      if (typeof m.q === 'string') setFilter(m.q);
      focusFilter();
      return;
  }
});
setInterval(refreshTimes, 1_000);
post({ type: 'ready' });
