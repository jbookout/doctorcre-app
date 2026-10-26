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
const esc = value => String(value ?? '').replace(/[&<>"']/gu, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const PHASES = { pending: 'Pending', research: 'Research', site_selection: 'Site selection', negotiation: 'Negotiation',
  legal: 'Legal', due_diligence: 'Due diligence', closing: 'Closing' };

export function callChangeText(change) {
  const payload = change?.payload || {};
  if (change?.kind === 'phase_move') {
    const phase = PHASES[payload.value] || payload.value || 'a new phase';
    return `Phase moved to ${phase}${payload.started_on ? `, started ${payload.started_on}` : ''}`;
  }
  if (change?.kind === 'next_step') return `Next step: ${payload.text || ''}${payload.next_date ? ` · due ${payload.next_date}` : ''}`;
  return 'Change applied from the call';
}

/** Calls whose outcome touches any of these candidate ids, or all when none are given. */
export function callsFor(calls, candidateIds = null) {
  const list = Array.isArray(calls) ? calls : [];
  if (!candidateIds) return list;
  const ids = new Set(candidateIds);
  return list.filter(call => [...(call.applied || []), ...(call.open_cards || [])].some(item => ids.has(item.candidate_id)));
}

export function callOutcomesHtml(calls, { busy = new Set() } = {}) {
  return calls.map(call => {
    const applied = Array.isArray(call.applied) ? call.applied : [];
    const open = Array.isArray(call.open_cards) ? call.open_cards.length : 0;
    const rows = applied.map(change => {
      const undone = Boolean(change.undone_at);
      return `<li class="call-outcome-change${undone ? ' undone' : ''}">
        <div><b>${esc(change.deal_name || 'Deal')}</b><span>${esc(callChangeText(change))}</span>
        <q>${esc(change.evidence_quote)}</q></div>
        ${undone ? '<span class="post-call-badge skipped">Undone</span>'
          : `<button type="button" class="secondary" data-call-undo="${esc(change.candidate_id)}" data-base-version="${esc(change.deal_version)}"${busy.has(change.candidate_id) ? ' disabled' : ''}>Undo</button>`}
      </li>`;
    }).join('');
    return `<section class="call-outcome" data-call-session="${esc(call.session_id)}" aria-label="Applied from the ${esc(call.call_date)} pipeline call">
      <header><h4>Applied from the ${esc(call.call_date)} pipeline call</h4>
      <button type="button" class="primary" data-call-reviewed="${esc(call.session_id)}"${busy.has(call.session_id) ? ' disabled' : ''}>Looks right</button></header>
      ${rows ? `<ul>${rows}</ul>` : '<p class="post-call-empty">Nothing was applied automatically.</p>'}
      ${open ? `<p class="call-outcome-open">${open} item${open === 1 ? '' : 's'} still need${open === 1 ? 's' : ''} Joe or Dell to decide.</p>` : ''}
    </section>`;
  }).join('');
}

/**
 * Mount the outcome list in `container`. `filter` narrows it to one call's
 * candidate ids (the Call Mode report); Home shows every unreviewed call.
 */
export function mountCallOutcomes({ container, client, toast = () => {}, filter = () => null, onChange = () => {} }) {
  const busy = new Set();
  let calls = [];
  const paint = () => {
    const shown = callsFor(calls, filter());
    container.innerHTML = callOutcomesHtml(shown, { busy });
    container.hidden = shown.length === 0;
  };
  async function refresh() {
    try {
      const answer = await client().readCallOutcomes();
      calls = Array.isArray(answer?.calls) ? answer.calls : [];
    } catch { calls = []; }
    paint();
  }
  async function act(key, run, done) {
    if (busy.has(key)) return;
    busy.add(key); paint();
    try { await run(); toast(done); }
    catch (error) {
      toast(error.payload?.error === 'newer_change_exists'
        ? 'That card changed again after the call. Edit it on the deal instead.'
        : error.message || 'The change could not be saved.');
    } finally { busy.delete(key); await refresh(); onChange(); }
  }
  async function click(event) {
    const undo = event.target.closest?.('[data-call-undo]');
    if (undo && container.contains(undo)) {
      const candidate_id = undo.dataset.callUndo;
      return act(candidate_id, () => client().undoCallChange({ candidate_id, base_version: Number(undo.dataset.baseVersion) }), 'Change undone.');
    }
    const reviewed = event.target.closest?.('[data-call-reviewed]');
    if (reviewed && container.contains(reviewed)) {
      const session_id = reviewed.dataset.callReviewed;
      return act(session_id, () => client().reviewCallOutcome({ session_id }), 'Marked reviewed.');
    }
    return undefined;
  }
  container.addEventListener('click', click);
  return { refresh, click, dispose() { container.removeEventListener('click', click); } };
}
