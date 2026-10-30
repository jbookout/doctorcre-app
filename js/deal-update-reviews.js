import { workCard } from './work-card.js';
import { escapeText as E } from './change-receipts.mjs';
import { readWithDeadline } from './current-read.mjs';
import { uuidv4 } from './uuid.js';

export function mountDealUpdateReviews({ container, client, initialResult, onChange = () => {} }) {
  let rows = [], state = 'loading', epoch = 0, disposed = false;
  const decisions = new Map();
  const win = container.ownerDocument.defaultView;
  const button = (action, label, disabled = false) => `<button type="button" class="btn home-outline" data-update-action="${action}"${disabled ? ' disabled' : ''}>${label}</button>`;
  function render() {
    const focused = container.contains(container.ownerDocument.activeElement) ? container.ownerDocument.activeElement : null;
    const focusId = focused?.closest('[data-update-id]')?.dataset.updateId, focusAction = focused?.dataset.updateAction;
    container.setAttribute('aria-busy', String(state === 'loading'));
    container.innerHTML = `<header class="home-panel-head"><h2>Overdue tasks to review</h2></header>${state === 'denied' ? '<p role="status">Sign in to review overdue tasks.</p>' : state === 'error' ? `<p role="status">Could not load overdue reviews.</p>${button('refresh', 'Retry overdue reviews')}` : state === 'loading' ? '<p role="status">Loading overdue reviews…</p>' : !rows.length ? '<p class="home-empty">No overdue reviews.</p>' : ''}${rows.map(row => {
      const decision = decisions.get(row.assessment_id), pending = decision?.state === 'submitting', unknown = decision?.state === 'unknown';
      const disabled = state !== 'ready' || pending;
      return workCard({ className: 'email-proposal', attributes: `data-update-id="${E(row.assessment_id)}"`,
        title: `<a href="/deals?deal=${encodeURIComponent(row.deal_id)}">${E(row.deal_name)}</a>`,
        meta: `<p>Overdue task · ${E(row.assessment.action.description)}</p>`,
        body: `<q>${E(row.assessment.quote || row.assessment.update)}</q><p class="email-change">Mark this overdue task as done.</p>${decision?.message ? `<p role="status">${E(decision.message)}</p>` : ''}`,
        actions: `<div class="email-controls">${decision?.state === 'done' ? '' : decision?.state === 'refused' ? button('refresh', 'Refresh overdue reviews') : unknown ? button('replay', 'Check outcome', disabled) : `${button('resolve', pending ? 'Saving…' : 'Confirm', disabled)}${button('dismiss', 'Dismiss', disabled)}`}</div>` });
    }).join('')}`;
    if (focused) {
      const article = [...container.querySelectorAll('[data-update-id]')].find(node => node.dataset.updateId === focusId);
      const target = [...(article || container).querySelectorAll('button:not(:disabled)')].find(node => node.dataset.updateAction === focusAction) || article?.querySelector('button:not(:disabled), a') || container.querySelector('button:not(:disabled)');
      target?.focus();
    }
  }
  function retire() { epoch++; rows = []; decisions.clear(); state = 'denied'; render(); }
  async function refresh() {
    if (disposed || state === 'denied') return;
    const ticket = ++epoch;
    state = 'loading'; render();
    try {
      const result = initialResult ?? await readWithDeadline(() => client.readDealUpdateReviews(), { timeoutMs: 10_000 });
      initialResult = undefined;
      if (disposed || ticket !== epoch) return;
      const ids = new Set();
      if (result?.schema_version !== 'deal-update-reviews.v1' || !Array.isArray(result.proposals) || result.proposals.length > 200
        || result.proposals.some(row => {
          const invalid = !row?.assessment_id || ids.has(row.assessment_id) || !row.deal_id || !row.deal_name
            || row.confirm_verb !== 'review-deal-update' || row.assessment?.review_required !== true
            || !row.assessment.action?.id || typeof row.assessment.action.description !== 'string'
            || typeof row.assessment.update !== 'string' || !(row.assessment.quote === null || typeof row.assessment.quote === 'string');
          ids.add(row?.assessment_id); return invalid;
        })) throw Error('Invalid overdue reviews');
      const next = [...result.proposals];
      for (const row of rows) if (!ids.has(row.assessment_id) && ['unknown', 'submitting'].includes(decisions.get(row.assessment_id)?.state)) next.push(row);
      for (const [id, decision] of decisions) if (decision.state === 'refused') decisions.delete(id);
      rows = next; state = 'ready';
    } catch (error) {
      if (disposed || ticket !== epoch) return;
      if ([401, 403].includes(error.status) || error.code === 'session_changed') return retire();
      state = 'error';
    }
    render();
  }
  async function click(event) {
    const control = event.target?.closest('[data-update-action]');
    if (!control || control.disabled || disposed || state === 'denied') return;
    if (control.dataset.updateAction === 'refresh') return refresh();
    if (state !== 'ready') return;
    const row = rows.find(item => item.assessment_id === control.closest('[data-update-id]')?.dataset.updateId);
    if (!row) return;
    const prior = decisions.get(row.assessment_id), action = control.dataset.updateAction;
    if (prior?.state === 'submitting' || prior?.state === 'done' || prior?.state === 'unknown' && action !== 'replay') return;
    const request = prior?.request || { assessment_id: row.assessment_id, decision: action,
      reason: action === 'resolve' ? 'The quoted update shows this task was handled.' : 'This update does not establish that the task was handled.', idempotency_key: uuidv4() };
    decisions.set(row.assessment_id, { state: 'submitting', request }); render();
    try {
      const result = await client.reviewDealUpdate(request);
      if (disposed || state === 'denied') return;
      if (result?.ok !== true || result.decision !== request.decision || result.action_id !== row.assessment.action.id) throw Error('Unverified review outcome');
      decisions.set(row.assessment_id, { state: 'done', message: request.decision === 'resolve' ? 'Task marked done.' : 'Dismissed. Task remains open.' });
      render(); onChange();
    } catch (error) {
      if (disposed || state === 'denied') return;
      if ([401, 403].includes(error.status) || error.code === 'session_changed') return retire();
      if (error.payload?.error && error.payload.error !== 'offline') {
        decisions.set(row.assessment_id, { state: 'refused', message: error.payload.error === 'overdue_action_changed'
          ? 'The task changed. Refresh overdue reviews before deciding again.' : 'Review was refused. Refresh overdue reviews before deciding again.' });
        render(); return;
      }
      decisions.set(row.assessment_id, { state: 'unknown', request, message: 'Review outcome unconfirmed. Check outcome to retry the original decision.' });
      render();
    }
  }
  container.addEventListener('click', click);
  win?.addEventListener('doctorcre-session-invalidated', retire);
  render();
  return { refresh, click, dispose() { disposed = true; epoch++; rows = []; decisions.clear(); container.replaceChildren(); container.removeEventListener('click', click); win?.removeEventListener('doctorcre-session-invalidated', retire); } };
}
