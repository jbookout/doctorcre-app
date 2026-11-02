import { callChangeText, dayLabel } from './call-change-words.js';

export { callChangeText, dayLabel };

const esc = value => String(value ?? '').replace(/[&<>"']/gu, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// Refusals are answers for a partner, never developer text, and never retried.
const UNDO_REFUSALS = {
  overdue_action_changed: "A task this call closed was changed afterward, so this change can't be undone. Edit the deal's next step and tasks directly instead.",
  newer_change_exists: 'That card changed again after the call. Edit it on the deal instead.',
  version_conflict: 'That deal changed since this list loaded. Check it and press Undo again if it is still wrong.',
  stale_base_version: 'That deal changed since this list loaded. Check it and press Undo again if it is still wrong.',
  applied_change_not_found: 'That change is no longer on the deal. Open the deal to check it.',
  partner_required: 'Only Joe or Dell can undo a change from the call.',
};
export function undoRefusal(error) {
  return UNDO_REFUSALS[error?.payload?.error] || 'The change could not be undone. Open the deal to check it.';
}

export function callOutcomesHtml(calls) {
  return calls.map(call => {
    const applied = Array.isArray(call.applied) ? call.applied : [];
    const open = Array.isArray(call.open_cards) ? call.open_cards.length : 0;
    const title = `Applied from the ${dayLabel(call.call_date)} pipeline call`;
    const rows = applied.map(change => {
      const undone = Boolean(change.undone_at);
      return `<li class="call-outcome-change${undone ? ' undone' : ''}">
        <div><b>${esc(change.deal_name || 'Deal')}</b><span>${esc(callChangeText(change))}</span>
        <q>${esc(change.evidence_quote)}</q></div>
        ${undone ? '<span class="call-outcome-badge">Undone</span>' : ''}
      </li>`;
    }).join('');
    return `<section class="call-outcome" data-call-session="${esc(call.session_id)}" aria-label="${esc(title)}">
      <header><h4>${esc(title)}</h4>
      <button type="button" class="call-outcome-action primary-action" data-call-open-review>Review call</button></header>
      ${rows ? `<ul>${rows}</ul>` : '<p class="call-outcome-note">Nothing was applied automatically.</p>'}
      ${open ? `<p class="call-outcome-note"><button type="button" class="call-outcome-link" data-call-open-cards>${open} item${open === 1 ? '' : 's'} from this call still need${open === 1 ? 's' : ''} Joe or Dell to decide</button></p>` : ''}
    </section>`;
  }).join('');
}

const UNCHECKED = `<p class="call-outcome-note" role="status">Couldn't check for changes from the pipeline call.
  <button type="button" class="call-outcome-action" data-call-recheck>Check again</button></p>`;

export function mountCallOutcomes({ container, client, openReview }) {
  let calls = [];
  let unchecked = false, disposed = false;
  const paint = () => {
    if (disposed) return;
    if (unchecked) { container.innerHTML = UNCHECKED; container.hidden = false; return; }
    container.innerHTML = callOutcomesHtml(calls);
    container.hidden = calls.length === 0;
  };
  async function refresh() {
    if (disposed) return;
    try {
      const answer = await client().readCallOutcomes();
      if (disposed) return;
      calls = Array.isArray(answer?.calls) ? answer.calls : [];
      unchecked = false;
    } catch (error) {
      if (disposed) return;
      calls = [];
      unchecked = ![401, 403].includes(error?.status);
    }
    paint();
  }
  const inside = node => Boolean(node) && container.contains(node);
  async function click(event) {
    if (disposed) return;
    const target = event.target;
    if (inside(target.closest?.('[data-call-recheck]'))) return refresh();
    const open = target.closest?.('[data-call-open-cards], [data-call-open-review]');
    if (inside(open)) {
      const session = open.closest('[data-call-session]')?.dataset.callSession;
      if (calls.some(call => call.session_id === session)) return openReview?.(session);
      return undefined;
    }
    return undefined;
  }
  container.addEventListener('click', click);
  return { refresh, click, dispose() {
    disposed = true; calls = []; container.innerHTML = ''; container.hidden = true;
    container.removeEventListener('click', click);
  } };
}
