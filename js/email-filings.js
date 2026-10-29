import { uuidv4 } from './uuid.js';
import { readWithDeadline } from './current-read.mjs';

const E = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const REFUSALS = {
  email_thread_filing_changed: 'This filing changed since it was filed, so it was left as is. Open the deal to review it.',
  email_thread_filing_not_found: 'This filing is no longer available to undo.',
};
const refusal = error => REFUSALS[error?.payload?.error] || 'Could not undo this filing. It was left as is.';
const denied = error => [401, 403].includes(error?.status) || error?.code === 'session_changed';
const when = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

// Automatic email filings with Undo. Only the source subject and sender name
// are shown; activity_version is the server's guard and may be null (legacy).
export function mountEmailFilings({ container, client }) {
  const win = container.ownerDocument.defaultView;
  let rows = [], loadState = 'loading', epoch = 0, disposed = false;
  const outcomes = new Map();
  function render() {
    if (disposed) return;
    const ownedFocus = container.contains(container.ownerDocument.activeElement);
    const focusId = ownedFocus ? container.ownerDocument.activeElement.closest('[data-filing-id]')?.dataset.filingId : null;
    container.setAttribute('aria-busy', String(loadState === 'loading'));
    const notice = loadState === 'denied' ? '<p role="status">Sign in to review automatic email filings.</p>'
      : loadState === 'error' ? `<p role="status">Could not load automatic email filings.${rows.length ? ' Showing the last successful read.' : ''}</p><button type="button" class="btn home-outline" data-filing-retry>Retry automatic email filings</button>`
        : loadState === 'loading' && !rows.length ? '<p class="home-empty">Loading automatic email filings…</p>'
          : loadState === 'ready' && !rows.length ? '<p class="home-empty">No automatic email filings to review.</p>' : '';
    container.innerHTML = `<header class="home-panel-head"><h2>Automatic email filings</h2></header>${notice}${rows.map(row => {
      const outcome = outcomes.get(row.event_id);
      return `<article class="email-proposal" data-filing-id="${E(row.event_id)}"><h3>${E(row.subject || 'Subject unavailable')}</h3><p>From ${E(row.sender_name || 'Sender unavailable')}${when(row.occurred_at) ? ` · ${E(when(row.occurred_at))}` : ''}</p>${
        outcome?.status === 'undone' ? '<p role="status" tabindex="-1">Undone. The email is no longer filed to this deal and will not be filed automatically again.</p>'
          : `${outcome?.message ? `<p role="status" tabindex="-1">${E(outcome.message)}</p>` : ''}<button type="button" class="btn home-outline" data-filing-undo${outcome?.status === 'submitting' ? ' disabled' : ''}>Undo</button>`}</article>`;
    }).join('')}`;
    const item = focusId && [...container.querySelectorAll('[data-filing-id]')].find(node => node.dataset.filingId === focusId);
    if (ownedFocus) (item?.querySelector('[role="status"], button') || container.querySelector('[data-filing-retry]'))?.focus?.({ preventScroll: true });
  }
  function retire() {
    epoch++; rows = []; loadState = 'denied'; render();
  }
  async function refresh() {
    if (disposed || loadState === 'denied') return;
    const ticket = ++epoch;
    loadState = 'loading'; render();
    try {
      const result = await readWithDeadline(() => client.listEmailThreadFilings(), { timeoutMs: 10_000 });
      if (disposed || ticket !== epoch) return;
      if (!Array.isArray(result?.filings) || result.filings.some(row => !row?.event_id)) throw Error('Invalid email filings');
      // An item undone in this view keeps its place until the next full reload.
      rows = [...result.filings, ...rows.filter(row => outcomes.get(row.event_id)?.status === 'undone' && !result.filings.some(item => item.event_id === row.event_id))];
      loadState = 'ready';
    } catch (error) {
      if (disposed || ticket !== epoch) return;
      if (denied(error)) return retire();
      loadState = 'error';
    }
    render();
  }
  async function undo(row) {
    if (outcomes.get(row.event_id)?.status === 'submitting') return;
    outcomes.set(row.event_id, { status: 'submitting' }); render();
    try {
      const result = await client.undoEmailThreadFiling({ event_id: row.event_id, idempotency_key: uuidv4() });
      if (result?.ok !== true) throw Error('Unexpected undo result');
      outcomes.set(row.event_id, { status: 'undone' });
    } catch (error) {
      if (denied(error)) return retire();
      outcomes.set(row.event_id, { status: 'refused', message: refusal(error) });
    }
    render();
  }
  const click = event => {
    if (event.target?.closest('[data-filing-retry]')) return refresh();
    const id = event.target?.closest('[data-filing-undo]')?.closest('[data-filing-id]')?.dataset.filingId;
    const row = rows.find(item => item.event_id === id);
    if (row) return undo(row);
  };
  container.addEventListener('click', click);
  win?.addEventListener('doctorcre-session-invalidated', retire);
  return { refresh, click, dispose() { disposed = true; container.removeEventListener('click', click); win?.removeEventListener('doctorcre-session-invalidated', retire); } };
}
