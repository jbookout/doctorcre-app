// The Control Room Queue list (V2 step 3, slice C2). Rows are grouped by status
// group under sticky headers; one roving highlight moves with j/k or the arrow
// keys (no multi-select, Linear study #0); Enter or a click opens the detail
// pane, Space toggles it. Display only.
import { escapeText as escapeHtml } from './change-receipts.mjs';
import { groupItems } from './control-room-queue-model.js';

// A glyph for each kind, always beside its word, so kind never rides on colour.
const KIND_GLYPH = Object.freeze({ work_request: '□', incident: '△', defect: '✕', loop: '↻', work_shape: '◇',
  builder_brief: '▭', slice_plan: '▤', capability_session: '◎', retrieval_proposal: '❝' });
const STATE_GLYPH = Object.freeze({ triage: '◇', in_progress: '◑', review: '◔', blocked: '■', ready: '●', backlog: '○', other: '·' });
const humanize = (value) => { const words = String(value || '').replace(/_/g, ' ').trim(); return words ? words[0].toUpperCase() + words.slice(1) : 'Unknown'; };
const count = (n) => n.toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;
const date = (value) => { const at = Date.parse(value); return Number.isFinite(at) ? new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : null; };
const optionId = (id) => `cr-opt-${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}`;

/** Short age in tabular figures: days, or weeks and months once it is long. */
export function ageLabel(days) {
  if (!Number.isFinite(days) || days < 0) return '—';
  if (days < 1) return 'today';
  if (days < 14) return `${Math.floor(days)}d`;
  if (days < 90) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}
function ageTitle(item) {
  const parts = [Number.isFinite(item.age) ? `Open ${plural(item.age, 'day')}` : 'Age not recorded'];
  if (date(item.openedAt)) parts.push(`opened ${date(item.openedAt)}`);
  if (date(item.lastActivityAt)) parts.push(`last activity ${date(item.lastActivityAt)}`);
  return parts.join(' · ');
}

function rowHtml(item, { highlightId, openId }) {
  const owner = item.holder || item.owner;
  return `<li class="cr-row" role="option" id="${optionId(item.id)}" data-issue="${escapeHtml(item.id)}" data-group="${escapeHtml(item.statusGroup)}" data-kind="${escapeHtml(item.kind)}" aria-selected="${item.id === highlightId}"${item.id === openId ? ' data-open="true"' : ''}>`
    + `<span class="cr-cell-kind"><span class="cr-kind-glyph" aria-hidden="true">${KIND_GLYPH[item.kind] || '·'}</span>${escapeHtml(item.kindLabel)}</span>`
    + `<span class="cr-row-ref">${escapeHtml(item.ref)}</span>`
    + `<span class="cr-cell-state"><span class="cr-row-glyph" aria-hidden="true">${STATE_GLYPH[item.statusGroup] || '·'}</span>${escapeHtml(humanize(item.state))}</span>`
    + `<span class="cr-row-title">${escapeHtml(item.title)}</span>`
    + `<span class="cr-cell-owner${owner ? '' : ' is-empty'}">${escapeHtml(owner || 'Unassigned')}</span>`
    + `<span class="cr-cell-age" title="${escapeHtml(ageTitle(item))}"><span class="sr-only">Age </span>${escapeHtml(ageLabel(item.age))}</span>`
    + `</li>`;
}

/** The grouped rows. Empty groups never render (groupItems drops them). */
export function listHtml(items, { highlightId = null, openId = null } = {}) {
  return groupItems(items).map((group) => `<section class="cr-group" role="group" data-group="${group.key}" aria-labelledby="cr-group-${group.key}">`
    + `<h3 class="cr-group-head" id="cr-group-${group.key}"><span>${escapeHtml(group.label)}</span><span class="cr-group-count">${count(group.items.length)}</span></h3>`
    + `<ul class="cr-rows" role="presentation">${group.items.map((item) => rowHtml(item, { highlightId, openId })).join('')}</ul></section>`).join('');
}

export const LIST_SKELETON_HTML = `<div class="cr-list-skeleton" aria-hidden="true">${'<div class="cr-skeleton-row"><span class="skeleton-line short"></span><span class="skeleton-line"></span></div>'.repeat(6)}</div>`;

export function emptyHtml({ triage = 0 } = {}) {
  const lead = triage ? `${plural(triage, 'item')} ${triage === 1 ? 'waits' : 'wait'} in Triage. Accepted items join the queue.` : 'New work arrives through Triage and joins the queue once it is accepted.';
  return `<div class="state-block cr-empty" data-state="empty"><h3>Nothing open in the queue</h3><p>${escapeHtml(lead)}</p></div>`;
}
export function errorHtml(reason) {
  return `<div class="state-block" data-state="offline"><h3>The queue could not be read</h3><p>${escapeHtml(reason)}. Nothing is listed rather than a partial guess.</p><button class="btn" type="button" data-queue-retry>Try again</button></div>`;
}

/** Keys typed into a field, or mid IME composition, are never shortcuts. */
export function isTypingTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
export const ignoreKey = (event) => event.isComposing === true || event.keyCode === 229 || isTypingTarget(event.target);

/** The list key a keydown means, or null. Space only counts on the list itself. */
export function listKey(event) {
  if (ignoreKey(event) || event.altKey || event.ctrlKey || event.metaKey) return null;
  switch (event.key) {
    case 'j': case 'ArrowDown': return 'next';
    case 'k': case 'ArrowUp': return 'previous';
    case 'Home': return 'first';
    case 'End': return 'last';
    case 'Enter': return 'open';
    case ' ': case 'Spacebar': return 'toggle';
    case 'Escape': return 'escape';
    default: return null;
  }
}
/** Cmd+I (Ctrl+I off a Mac) toggles the pane from anywhere outside a field. */
export const paneShortcut = (event) => !ignoreKey(event) && Boolean(event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
  && (event.code === 'KeyI' || String(event.key).toLowerCase() === 'i');

/**
 * Mount the list on its container. The container becomes the listbox and keeps
 * focus; rows are options reached through aria-activedescendant, so a refresh
 * that rewrites the rows never drops focus.
 */
export function mountQueueList({ node, onOpen, onToggle, onEscape }) {
  let items = [], highlightId = null, openId = null, mode = 'loading';
  const ordered = () => groupItems(items).flatMap((group) => group.items);
  const sync = () => {
    for (const row of node.querySelectorAll('[role="option"]')) {
      row.setAttribute('aria-selected', String(row.dataset.issue === highlightId));
      if (row.dataset.issue === openId) row.dataset.open = 'true'; else delete row.dataset.open;
    }
    const active = highlightId ? node.querySelector(`#${optionId(highlightId)}`) : null;
    if (active) { node.setAttribute('aria-activedescendant', active.id); active.scrollIntoView?.({ block: 'nearest' }); }
    else node.removeAttribute('aria-activedescendant');
  };
  const asListbox = (on) => {
    if (on) { node.setAttribute('role', 'listbox'); node.tabIndex = 0; }
    else { node.removeAttribute('role'); node.removeAttribute('tabindex'); node.removeAttribute('aria-activedescendant'); }
  };
  const move = (step) => {
    const list = ordered(); if (!list.length) return;
    const index = list.findIndex((item) => item.id === highlightId);
    const next = step === 'first' ? 0 : step === 'last' ? list.length - 1
      : index < 0 ? 0 : Math.min(list.length - 1, Math.max(0, index + step));
    highlightId = list[next].id; sync();
  };
  const highlighted = () => items.find((item) => item.id === highlightId) || null;
  node.addEventListener('keydown', (event) => {
    if (mode !== 'rows' || event.target !== node) return;
    const key = listKey(event); if (!key) return;
    if (key === 'next' || key === 'previous') { event.preventDefault(); move(key === 'next' ? 1 : -1); }
    else if (key === 'first' || key === 'last') { event.preventDefault(); move(key); }
    else if (key === 'open') { const item = highlighted(); if (item) { event.preventDefault(); onOpen(item); } }
    else if (key === 'toggle') { event.preventDefault(); if (!highlightId) move(1); onToggle(highlighted()); }
    else if (key === 'escape') { if (onEscape()) event.preventDefault(); else if (highlightId) { event.preventDefault(); highlightId = null; sync(); } }
  });
  // eslint-disable-next-line no-restricted-syntax -- Row-list focus selects one existing highlight; zero HTTP reads.
  node.addEventListener('focus', () => {
    if (mode !== 'rows' || highlightId) return;
    if (openId) { highlightId = openId; sync(); } else move('first');
  });
  node.addEventListener('click', (event) => {
    const row = event.target instanceof Element ? event.target.closest('[role="option"]') : null;
    if (!row || !node.contains(row)) return;
    highlightId = row.dataset.issue; sync();
    const item = highlighted(); if (item) onOpen(item);
  });
  const paint = (html, nextMode) => { mode = nextMode; asListbox(nextMode === 'rows'); if (node.innerHTML !== html) node.innerHTML = html; sync(); };
  return {
    rows(next, { triage = 0 } = {}) {
      items = next.slice();
      if (highlightId && !items.some((item) => item.id === highlightId)) highlightId = null;
      if (!items.length) { paint(emptyHtml({ triage }), 'empty'); return; }
      paint(listHtml(items, { highlightId, openId }), 'rows');
    },
    loading() { paint(LIST_SKELETON_HTML, 'loading'); },
    error(reason) { paint(errorHtml(reason), 'error'); },
    setOpen(id) { openId = id; if (id) highlightId = id; sync(); },
    get highlighted() { return highlighted(); },
    focus() { if (mode === 'rows') node.focus({ preventScroll: true }); },
  };
}
