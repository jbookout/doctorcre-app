import { PHASE_BY_SLUG } from './client.js';
import { uuidv4 } from './uuid.js';
import { readWithDeadline } from './current-read.mjs';

const E = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const day = value => value ? new Date(`${value}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'No date';
const owner = value => ({ joe: 'Joe', dell: 'Dell' })[value] || 'Owner unavailable';
const phase = value => PHASE_BY_SLUG[value] || 'Phase unavailable';
const KINDS = {
  next_step: { preview: 'previewEmailNextStep', confirm: 'confirmEmailNextStep', verb: 'confirm-email-next-step', contract: 'email-next-step.v1' },
  phase_move: { preview: 'previewEmailDealProgress', confirm: 'confirmEmailDealProgress', verb: 'confirm-email-deal-progress', contract: 'email-deal-progress.v1' },
};
const change = (row, preview) => !preview ? 'Proposal needs a fresh review'
  : row.kind === 'next_step' ? `${preview.text} · ${day(preview.next_date)} · ${owner(preview.owner)}`
    : `${phase(preview.from_phase)} → ${phase(preview.to_phase)}`;
const argsFor = (row, preview) => ({ deal: row.deal, activity_id: row.source.activity_id, evidence_quote: row.source.evidence_quote,
  ...(row.kind === 'next_step' ? { text: preview.text, next_date: preview.next_date, owner: preview.owner } : {}) });
const validPreview = (row, preview) => preview?.contract === KINDS[row.kind]?.contract && preview.status === 'proposed'
  && preview.requires_confirmation === true && /^sha256:[a-f0-9]{64}$/.test(preview.proposal_digest)
  && preview.deal === row.deal && preview.source?.activity_id === row.source.activity_id && preview.evidence_quote === row.source.evidence_quote
  && (row.kind === 'next_step' ? typeof preview.text === 'string' && preview.text.trim() && /^\d{4}-\d{2}-\d{2}$/.test(preview.next_date)
    && ['joe', 'dell'].includes(preview.owner) : Boolean(PHASE_BY_SLUG[preview.from_phase] && PHASE_BY_SLUG[preview.to_phase]));
const denied = error => [401, 403].includes(error.status) || error.code === 'session_changed';
const refusal = error => {
  const code = error.payload?.error;
  if (code === 'joe_confirmation_required') return 'Only Joe can confirm email changes. Joe or Dell can dismiss them.';
  if (code === 'partner_dismissal_required') return 'Only Joe or Dell can dismiss email proposals.';
  if (code?.includes('stale') || code === 'version_conflict') return 'This proposal or deal changed. Refresh and review it again.';
  return 'This proposal could not be applied. Refresh and review the deal before trying again.';
};

export function mountEmailFollowups({ container, client, onChange = () => {} }) {
  const win = container.ownerDocument.defaultView;
  let rows = [], loaded = false, loadState = 'loading', epoch = 0, disposed = false;
  const decisions = new Map();
  function render() {
    if (disposed) return;
    const active = container.contains(container.ownerDocument.activeElement) ? container.ownerDocument.activeElement : null;
    const selection = active?.matches('textarea') ? [active.selectionStart, active.selectionEnd] : null;
    const focusId = active?.closest('[data-email-id]')?.dataset.emailId, focusAction = active?.dataset.emailAction;
    container.setAttribute('aria-busy', String(loadState === 'loading'));
    const button = (action, label, disabled = false) => `<button type="button" class="home-outline" data-email-action="${action}"${disabled ? ' disabled' : ''}>${label}</button>`;
    const notice = loadState === 'denied' ? '<p role="status">Sign in to review email follow-ups.</p>'
      : loadState === 'error' ? `<p role="status">Could not load email follow-ups.${loaded && rows.length ? ' Showing the last successful read.' : ''}</p>${button('retry', 'Retry email follow-ups')}`
        : loadState === 'loading' ? '<p role="status">Updating email follow-ups…</p>' : '';
    container.innerHTML = `<header class="home-panel-head"><h2>Email follow-ups</h2></header>${notice}${loaded && !rows.length && loadState === 'ready' ? '<p class="home-empty">No pending email follow-ups.</p>' : ''}${rows.map(row => {
      const state = decisions.get(row.id) || { status: 'pending' }, preview = state.preview || row.preview;
      let controls = '';
      if (state.status === 'reviewing') {
        const replaces = row.kind === 'phase_move' ? `Moves from ${phase(preview.from_phase)} to ${phase(preview.to_phase)}.`
          : preview.owner === 'dell' ? `Replaces Dell's open actions: ${(preview.current_owner_actions || []).map(item => `${item.description} · ${day(item.due_date)}`).join('; ') || 'None'}.`
            : `Replaces ${preview.current_next_step || 'no current next step'} · ${day(preview.current_next_date)}.`;
        controls = `<div class="email-review"><p>${E(replaces)}</p><p>Joe confirms this change to the deal.</p>${button('confirm', 'Confirm change', loadState !== 'ready')}${button('cancel', 'Cancel')}</div>`;
      } else if (state.status === 'dismissing') {
        controls = `<label>Reason for dismissal<textarea maxlength="500" rows="2" data-email-reason>${E(state.reason || '')}</textarea></label>${button('submit-dismiss', 'Dismiss proposal', loadState !== 'ready')}${button('cancel', 'Cancel')}`;
      } else if (state.status === 'submitting') controls = button('confirm', 'Saving…', true);
      else if (state.status === 'previewing') controls = button('preview', 'Checking preview…', true);
      else if (state.status === 'unknown') controls = button('replay', 'Check outcome');
      else if (state.status !== 'done') controls = `${preview && validPreview(row, preview) ? button('preview', 'Confirm', loadState !== 'ready') : ''}${button('dismiss', 'Dismiss', loadState !== 'ready')}`;
      return `<article class="email-proposal" data-email-id="${E(row.id)}"><h3><a href="/deals?deal=${encodeURIComponent(row.deal)}">${E(row.deal_name)}</a></h3><p class="email-source">Email sender</p><q>${E(row.source.evidence_quote)}</q>${row.suspected_instruction ? `<p class="email-warning">Caution: ${E(row.suspected_instruction)}. Review the quoted email carefully.</p>` : ''}<p class="email-change">${E(change(row, preview))}</p>${!preview ? '<p>This proposal cannot currently be confirmed. Open the deal to review it or dismiss it with a reason.</p>' : ''}${state.message ? `<p role="status">${E(state.message)}</p>` : ''}<div class="email-controls">${controls}</div></article>`;
    }).join('')}`;
    if (active) {
      const article = [...container.querySelectorAll('[data-email-id]')].find(node => node.dataset.emailId === focusId);
      const replacement = (selection && article?.querySelector('textarea')) || [...(article || container).querySelectorAll('[data-email-action]')].find(node => node.dataset.emailAction === focusAction && !node.disabled)
        || article?.querySelector('button:not(:disabled), a') || container.querySelector('button:not(:disabled), h2');
      replacement?.focus();
      if (selection && replacement?.matches('textarea')) replacement.setSelectionRange(...selection);
    }
  }
  function retire() {
    epoch++; rows = []; decisions.clear(); loaded = false; loadState = 'denied'; render();
  }
  async function refresh() {
    if (disposed || loadState === 'denied') return;
    const ticket = ++epoch;
    loadState = 'loading'; render();
    try {
      const result = await readWithDeadline(() => client.listEmailProposals(), { timeoutMs: 10_000 });
      if (disposed || ticket !== epoch) return;
      if (result?.schema_version !== 'email-proposals.v1' || result.send !== false || !Array.isArray(result.proposals)
        || result.proposals.some(row => !row?.id || !Number.isInteger(row.version) || row.version < 1 || !KINDS[row.kind]
          || row.confirm_verb !== KINDS[row.kind].verb || !row.deal || !row.deal_name || !row.source?.activity_id || typeof row.source.evidence_quote !== 'string'
          || (row.preview !== null && !validPreview(row, row.preview)))) throw Error('Invalid email proposals');
      const next = result.proposals;
      for (const row of rows) if (!next.some(item => item.id === row.id) && ['submitting', 'unknown'].includes(decisions.get(row.id)?.status)) next.push(row);
      rows = next; loaded = true; loadState = 'ready';
    } catch (error) {
      if (disposed || ticket !== epoch) return;
      if (denied(error)) return retire();
      loadState = 'error';
    }
    render();
  }
  async function submit(row, state) {
    decisions.set(row.id, { ...state, status: 'submitting' }); render();
    try {
      const result = await client[state.method](state.request);
      if (!result || (state.method === 'dismissEmailProposal' ? result.ok !== true || result.status !== 'dismissed' || result.proposal_id !== row.id
        : result.status !== 'confirmed' || result.requires_confirmation !== false)) throw Error('Unconfirmed receipt');
      if (disposed || loadState === 'denied') return;
      decisions.set(row.id, { status: 'done', message: state.method === 'dismissEmailProposal' ? 'Dismissed.' : 'Confirmed.' });
      onChange();
    } catch (error) {
      if (disposed || loadState === 'denied') return;
      if (denied(error)) return retire();
      if (error.payload?.error && !error.pendingRequest) decisions.set(row.id, { status: 'refused', message: refusal(error) });
      else decisions.set(row.id, { ...state, status: 'unknown', message: 'Outcome unknown. Check outcome to recover the original request.' });
    }
    render();
  }
  async function click(event) {
    const button = event.target?.closest('[data-email-action]');
    if (!button || button.disabled || !container.contains(button) || disposed || loadState === 'denied') return;
    const action = button.dataset.emailAction;
    if (action === 'retry') return refresh();
    const row = rows.find(item => item.id === button.closest('[data-email-id]')?.dataset.emailId);
    if (!row) return;
    const state = decisions.get(row.id) || { status: 'pending' };
    if (['previewing', 'submitting', 'done'].includes(state.status)) return;
    if (action === 'replay' && state.status === 'unknown') return submit(row, state);
    if (state.status === 'unknown') return;
    if (action === 'cancel') { decisions.delete(row.id); render(); return; }
    if (loadState !== 'ready') return;
    if (action === 'dismiss') { decisions.set(row.id, { status: 'dismissing', baseVersion: row.version }); render(); [...container.querySelectorAll('[data-email-id]')].find(node => node.dataset.emailId === row.id)?.querySelector('textarea')?.focus(); }
    if (action === 'submit-dismiss' && state.status === 'dismissing') {
      const reason = button.closest('article').querySelector('textarea').value.trim();
      if (!reason || reason.length > 500) { button.closest('article').querySelector('textarea').focus(); return; }
      return submit(row, { method: 'dismissEmailProposal', request: { proposal_id: row.id, base_version: state.baseVersion, reason, idempotency_key: uuidv4() } });
    }
    if (action === 'preview' && validPreview(row, row.preview)) {
      decisions.set(row.id, { status: 'previewing' }); render();
      try {
        const preview = await readWithDeadline(() => client[KINDS[row.kind].preview](argsFor(row, row.preview)), { timeoutMs: 10_000 });
        if (disposed || loadState === 'denied') return;
        if (!validPreview(row, preview)) throw Error('Invalid preview');
        decisions.set(row.id, { status: 'reviewing', preview });
      } catch (error) {
        if (disposed || loadState === 'denied') return;
        if (denied(error)) return retire();
        decisions.set(row.id, { status: 'refused', message: 'Could not preview this change. Refresh and review it again.' });
      }
      render();
    }
    if (action === 'confirm' && state.status === 'reviewing') return submit(row, { method: KINDS[row.kind].confirm,
      request: { ...argsFor(row, state.preview), proposal_digest: state.preview.proposal_digest, idempotency_key: uuidv4() } });
  }
  const input = event => {
    if (!event.target.matches('[data-email-reason]')) return;
    const state = decisions.get(event.target.closest('[data-email-id]').dataset.emailId);
    if (state?.status === 'dismissing') state.reason = event.target.value;
  };
  container.addEventListener('input', input);
  container.addEventListener('click', click);
  win?.addEventListener('doctorcre-session-invalidated', retire);
  return { refresh, click, dispose() { retire(); disposed = true; container.removeEventListener('click', click); container.removeEventListener('input', input); win?.removeEventListener('doctorcre-session-invalidated', retire); } };
}
