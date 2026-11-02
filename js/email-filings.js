import { uuidv4 } from './uuid.js';
import { readWithDeadline } from './current-read.mjs';

const E = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const REFUSALS = {
  email_thread_filing_changed: 'This filing changed since it was filed, so it was left as is. Open the deal to review it.',
  email_thread_filing_not_found: 'This filing is no longer available to undo.',
};
const denied = error => [401, 403].includes(error?.status) || error?.code === 'session_changed';
const when = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

// Filed automatically with Undo. Only the source subject and sender name
// are shown; activity_version is the server's guard and may be null (legacy).
export function mountEmailFilings({ container, client }) {
  const win = container.ownerDocument.defaultView;
  let rows = [], loadState = 'loading', epoch = 0, disposed = false;
  const outcomes = new Map();
  function render(restoreFocus = false, restoreId = null) {
    if (disposed) return;
    const ownedFocus = container.contains(container.ownerDocument.activeElement);
    const focusControl = ownedFocus && container.ownerDocument.activeElement.matches('a') ? 'a' : 'button';
    const focusId = ownedFocus ? container.ownerDocument.activeElement.closest('[data-filing-id]')?.dataset.filingId : restoreId;
    container.setAttribute('aria-busy', String(loadState === 'loading'));
    const notice = loadState === 'denied' ? '<p role="status">Sign in to review filed emails.</p>'
      : loadState === 'error' ? `<p role="status">Could not load filed emails.${rows.length ? ' Showing the last successful read.' : ''}</p><button type="button" class="btn home-outline" data-filing-retry>Retry filed emails</button>`
        : loadState === 'loading' && !rows.length ? '<p class="home-empty">Loading filed emails…</p>'
          : loadState === 'ready' && !rows.length ? '<p class="home-empty">No filed emails to review.</p>' : '';
    container.innerHTML = `<header class="home-panel-head"><h2>Filed automatically</h2></header>${notice}${rows.map(row => {
      const outcome = outcomes.get(row.event_id);
      const deal = typeof row.deal === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.deal) ? row.deal : null;
      const destination = deal ? `<a class="btn home-outline" href="/deals?deal=${encodeURIComponent(deal)}">Open filed deal</a>` : '';
      return `<article class="email-proposal" data-filing-id="${E(row.event_id)}"><h3>${E(row.subject || 'Subject unavailable')}</h3><p>From ${E(row.sender_name || 'Sender unavailable')}${when(row.occurred_at) ? ` · ${E(when(row.occurred_at))}` : ''}</p>${
        outcome?.status === 'undone' ? '<p role="status" tabindex="-1">Undone. The email is no longer filed to this deal and will not be filed automatically again.</p>'
          : `${!deal ? '<p>Filed deal destination unavailable.</p>' : ''}${outcome?.message ? `<p role="status" tabindex="-1">${E(outcome.message)}</p>` : ''}<div class="email-controls">${destination}<button type="button" class="btn home-outline" data-filing-undo${outcome?.status === 'submitting' ? ' disabled' : ''}>${outcome?.status === 'uncertain' ? 'Check outcome' : 'Undo'}</button></div>`}</article>`;
    }).join('')}`;
    const item = focusId && [...container.querySelectorAll('[data-filing-id]')].find(node => node.dataset.filingId === focusId);
    if (ownedFocus || restoreFocus) ((item?.querySelector('[role="status"]') || item?.querySelector(focusControl) || item?.querySelector('button')) || container.querySelector('[data-filing-retry], button'))?.focus?.({ preventScroll: true });
  }
  function retire() {
    epoch++; rows = []; outcomes.clear(); loadState = 'denied'; render();
  }
  async function refresh() {
    if (disposed || loadState === 'denied') return;
    const ticket = ++epoch;
    const hadFocus = container.contains(container.ownerDocument.activeElement);
    loadState = 'loading'; render();
    try {
      const result = await readWithDeadline(() => client.listEmailThreadFilings(), { timeoutMs: 10_000 });
      if (disposed || ticket !== epoch) return;
      if (!Array.isArray(result?.filings) || result.filings.some(row => !row?.event_id)) throw Error('Invalid email filings');
      rows = [...result.filings, ...rows.filter(row => ['submitting', 'uncertain', 'undone'].includes(outcomes.get(row.event_id)?.status) && !result.filings.some(item => item.event_id === row.event_id))];
      loadState = 'ready';
    } catch (error) {
      if (disposed || ticket !== epoch) return;
      if (denied(error)) return retire();
      loadState = 'error';
    }
    render(loadState === 'error' && hadFocus && container.ownerDocument.activeElement === container.ownerDocument.body);
  }
  async function undo(row) {
    if (disposed || loadState === 'denied') return;
    const previous = outcomes.get(row.event_id);
    if (['submitting', 'undone'].includes(previous?.status)) return;
    const request = previous?.request || Object.freeze({ event_id: row.event_id, idempotency_key: uuidv4() });
    const hadFocus = container.contains(container.ownerDocument.activeElement);
    outcomes.set(row.event_id, { status: 'submitting', request, message: 'Checking Undo outcome…' }); render();
    try {
      const result = await readWithDeadline(() => client.undoEmailThreadFiling(request), { timeoutMs: 10_000 });
      if (disposed || loadState === 'denied') return;
      if (result?.ok !== true) throw Error('Unexpected undo result');
      outcomes.set(row.event_id, { status: 'undone' });
    } catch (error) {
      if (disposed || loadState === 'denied') return;
      if (denied(error)) return retire();
      const message = REFUSALS[error?.payload?.error];
      outcomes.set(row.event_id, message ? { status: 'refused', message }
        : { status: 'uncertain', request, message: 'We could not confirm whether Undo completed. Check outcome to retry the same request.' });
    }
    render(hadFocus && container.ownerDocument.activeElement === container.ownerDocument.body, row.event_id);
  }
  const click = event => {
    if (event.target?.closest('[data-filing-retry]')) return refresh();
    const id = event.target?.closest('[data-filing-undo]')?.closest('[data-filing-id]')?.dataset.filingId;
    const row = rows.find(item => item.event_id === id);
    if (row) return undo(row);
  };
  container.addEventListener('click', click);
  win?.addEventListener('doctorcre-session-invalidated', retire);
  return { refresh, click, dispose() { disposed = true; outcomes.clear(); container.removeEventListener('click', click); win?.removeEventListener('doctorcre-session-invalidated', retire); } };
}
