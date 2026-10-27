/**
 * What the weekly pipeline call changed by itself (WR-000433 AC4).
 *
 * Joe, 2026-10-26: plainly stated next steps and phases apply automatically,
 * "But a summary of the changes it applied automatically would still need to
 * be recorded and presented just in case they were wrong". CARR keeps that
 * summary (read-call-outcomes); this module shows it after the call and on
 * Home until a partner marks it reviewed. Each change has a one-tap Undo that
 * reverts through undo-call-change with the deal's current version. Cards the
 * model could not settle stay in their own review lists; here they are only
 * counted so nothing waiting is invisible.
 */
import { callChangeText, dayLabel } from './call-change-words.js';

export { callChangeText, dayLabel };

const esc = value => String(value ?? '').replace(/[&<>"']/gu, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// Refusals are answers for a partner, never developer text, and never retried.
const UNDO_REFUSALS = {
  newer_change_exists: 'That card changed again after the call. Edit it on the deal instead.',
  version_conflict: 'That deal changed since this list loaded. Check it and press Undo again if it is still wrong.',
  stale_base_version: 'That deal changed since this list loaded. Check it and press Undo again if it is still wrong.',
  applied_change_not_found: 'That change is no longer on the deal. Open the deal to check it.',
  partner_required: 'Only Joe or Dell can undo a change from the call.',
};
export function undoRefusal(error) {
  return UNDO_REFUSALS[error?.payload?.error] || 'The change could not be undone. Open the deal to check it.';
}

/** Calls whose outcome touches any of these candidate ids, or all when none are given. */
export function callsFor(calls, candidateIds = null) {
  const list = Array.isArray(calls) ? calls : [];
  if (!candidateIds) return list;
  const ids = new Set(candidateIds);
  return list.filter(call => [...(call.applied || []), ...(call.open_cards || [])].some(item => ids.has(item.candidate_id)));
}

export function callOutcomesHtml(calls, { busy = new Set(), openCards = false } = {}) {
  return calls.map(call => {
    const applied = Array.isArray(call.applied) ? call.applied : [];
    const open = Array.isArray(call.open_cards) ? call.open_cards.length : 0;
    const title = `Applied from the ${dayLabel(call.call_date)} pipeline call`;
    const rows = applied.map(change => {
      const undone = Boolean(change.undone_at);
      return `<li class="call-outcome-change${undone ? ' undone' : ''}">
        <div><b>${esc(change.deal_name || 'Deal')}</b><span>${esc(callChangeText(change))}</span>
        <q>${esc(change.evidence_quote)}</q></div>
        ${undone ? '<span class="call-outcome-badge">Undone</span>'
          : `<button type="button" class="call-outcome-action" data-call-undo="${esc(change.candidate_id)}" data-base-version="${esc(change.deal_version)}"${busy.has(change.candidate_id) ? ' disabled' : ''}>Undo</button>`}
      </li>`;
    }).join('');
    return `<section class="call-outcome" data-call-session="${esc(call.session_id)}" aria-label="${esc(title)}">
      <header><h4>${esc(title)}</h4>
      <button type="button" class="call-outcome-action primary-action" data-call-reviewed="${esc(call.session_id)}"${busy.has(call.session_id) ? ' disabled' : ''}>Looks right</button></header>
      ${rows ? `<ul>${rows}</ul>` : '<p class="call-outcome-note">Nothing was applied automatically.</p>'}
      ${open ? `<p class="call-outcome-note">${openCards
        ? `<button type="button" class="call-outcome-link" data-call-open-cards>${open} item${open === 1 ? '' : 's'} from this call still need${open === 1 ? 's' : ''} Joe or Dell to decide</button>`
        : `${open} item${open === 1 ? '' : 's'} from this call still need${open === 1 ? 's' : ''} Joe or Dell to decide.`}</p>` : ''}
    </section>`;
  }).join('');
}

const UNCHECKED = `<p class="call-outcome-note" role="status">Couldn't check for changes from the pipeline call.
  <button type="button" class="call-outcome-action" data-call-recheck>Check again</button></p>`;

/**
 * Mount the outcome list in `container`. `filter` narrows it to one call's
 * candidate ids (the Call Mode report); Home shows every unreviewed call.
 * A failed read says so instead of looking like "nothing to review"; a
 * signed-out read stays quiet because the page already asks for sign-in.
 */
export function mountCallOutcomes({ container, client, toast = () => {}, filter = () => null, onChange = () => {}, listen = true, openCards = null }) {
  const busy = new Set();
  let calls = [];
  let unchecked = false, disposed = false;
  const paint = () => {
    if (disposed) return;
    if (unchecked) { container.innerHTML = UNCHECKED; container.hidden = false; return; }
    const shown = callsFor(calls, filter());
    container.innerHTML = callOutcomesHtml(shown, { busy, openCards: Boolean(openCards) });
    container.hidden = shown.length === 0;
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
  async function act(key, run, done, refused) {
    if (disposed || busy.has(key)) return;
    busy.add(key); paint();
    try { await run(); if (!disposed) toast(done); }
    catch (error) { if (!disposed) toast(refused(error)); }
    finally {
      busy.delete(key);
      if (!disposed) { await refresh(); if (!disposed) onChange(); }
    }
  }
  // A host that delegates its clicks (listen: false) has already scoped them.
  const inside = node => Boolean(node) && (!listen || container.contains(node));
  async function click(event) {
    if (disposed) return;
    const target = event.target;
    if (inside(target.closest?.('[data-call-recheck]'))) return refresh();
    if (inside(target.closest?.('[data-call-open-cards]'))) return openCards?.();
    const undo = target.closest?.('[data-call-undo]');
    if (inside(undo)) {
      const candidate_id = undo.dataset.callUndo;
      return act(candidate_id, () => client().undoCallChange({ candidate_id, base_version: Number(undo.dataset.baseVersion) }),
        'Change undone.', undoRefusal);
    }
    const reviewed = target.closest?.('[data-call-reviewed]');
    if (inside(reviewed)) {
      const session_id = reviewed.dataset.callReviewed;
      return act(session_id, () => client().reviewCallOutcome({ session_id }), 'Marked reviewed.',
        () => 'Could not mark the call reviewed. Try again.');
    }
    return undefined;
  }
  // A host that already delegates its clicks (Call Mode) passes listen: false and forwards them.
  if (listen) container.addEventListener('click', click);
  return { refresh, click, dispose() {
    disposed = true; calls = []; busy.clear(); container.innerHTML = ''; container.hidden = true;
    if (listen) container.removeEventListener('click', click);
  } };
}
