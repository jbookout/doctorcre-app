import { validEmailDraftAddresses, validEmailDraftReceipt } from './email-draft.js';
import { PHASE_BY_SLUG } from './client.js';
import { uuidv4 } from './uuid.js';
import { readWithDeadline } from './current-read.mjs';

const E = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const day = value => value ? new Date(`${value}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'No date';
const owner = value => ({ joe: 'Joe', dell: 'Dell' })[value] || 'Owner unavailable';
const phase = value => PHASE_BY_SLUG[value] || 'Phase unavailable';
const KINDS = {
  next_step: { preview: 'previewEmailNextStep', confirm: 'confirmEmailNextStep', verb: 'confirm-email-next-step', contract: 'email-next-step.v1' },
  reply_draft: { verb: 'submit-email-draft' },
  phase_move: { preview: 'previewEmailDealProgress', confirm: 'confirmEmailDealProgress', verb: 'confirm-email-deal-progress', contract: 'email-deal-progress.v1' },
};
const change = (row, preview) => row.kind === 'reply_draft' ? `Reply draft · ${row.reply_draft.subject} · ${owner(row.reply_draft.owner)}` : !preview ? 'Proposal needs a fresh review'
  : row.kind === 'next_step' ? `${preview.text} · ${day(preview.next_date)} · ${owner(preview.owner)}`
    : `${phase(preview.from_phase)} → ${phase(preview.to_phase)}`;
const argsFor = (row, preview) => ({ deal: row.deal, activity_id: row.source.activity_id, evidence_quote: row.source.evidence_quote,
  ...(row.kind === 'next_step' ? { text: preview.text, next_date: preview.next_date, owner: preview.owner } : {}) });
const validDraft = row => row.preview === null && typeof row.reply_draft?.subject === 'string' && row.reply_draft.subject.trim()
  && row.reply_draft.subject.length <= 998 && typeof row.reply_draft.body === 'string' && row.reply_draft.body.length <= 20000
  && ['joe', 'dell'].includes(row.reply_draft.owner) && validEmailDraftAddresses(row.reply_draft.to) && validEmailDraftAddresses(row.reply_draft.cc);
const validPreview = (row, preview) => preview?.contract === KINDS[row.kind]?.contract && preview.status === 'proposed'
  && preview.requires_confirmation === true && /^sha256:[a-f0-9]{64}$/.test(preview.proposal_digest)
  && preview.deal === row.deal && preview.source?.activity_id === row.source.activity_id && preview.evidence_quote === row.source.evidence_quote
  && (row.kind === 'next_step' ? typeof preview.text === 'string' && preview.text.trim() && /^\d{4}-\d{2}-\d{2}$/.test(preview.next_date)
    && ['joe', 'dell'].includes(preview.owner) : Boolean(PHASE_BY_SLUG[preview.from_phase] && PHASE_BY_SLUG[preview.to_phase]));
const denied = error => [401, 403].includes(error.status) || error.code === 'session_changed';
const refusal = error => {
  const code = error.payload?.error;
  if (code === 'joe_confirmation_required') return 'Only Joe can confirm email changes. Joe or Dell can dismiss them.';
  if (code === 'email_draft_recipients_changed') return 'Recipients changed. Review updated draft to check the exact To and CC addresses before submitting again.';
  if (code === 'email_draft_not_owner') return 'Only the partner who received this email can submit its reply.';
  if (code === 'email_draft_copy_address_missing') return 'The other partner needs an email address before this reply can be submitted.';
  if (code === 'email_draft_already_submitted') return 'This reply has already been submitted. Refresh to review the current state.';
  if (code === 'partner_dismissal_required') return 'Only Joe or Dell can dismiss email proposals.';
  if (code?.includes('stale') || code === 'version_conflict') return 'This proposal or deal changed. Refresh and review it again.';
  return 'This proposal could not be applied. Refresh and review the deal before trying again.';
};

export function mountEmailFollowups({ container, client, deal, onChange = () => {} }) {
  const win = container.ownerDocument.defaultView;
  let rows = [], loaded = false, loadState = 'loading', epoch = 0, disposed = false, cursor = null, retryCursor = null, pages = 1;
  const decisions = new Map();
  function render() {
    if (disposed) return;
    const active = container.contains(container.ownerDocument.activeElement) ? container.ownerDocument.activeElement : null;
    const selection = active?.matches('textarea, input') ? [active.selectionStart, active.selectionEnd] : null;
    const focusField = active?.hasAttribute('data-email-subject') ? 'subject' : active?.hasAttribute('data-email-body') ? 'body' : 'reason';
    const focusId = active?.closest('[data-email-id]')?.dataset.emailId, focusAction = active?.dataset.emailAction;
    container.setAttribute('aria-busy', String(loadState === 'loading'));
    const button = (action, label, disabled = false) => `<button type="button" class="btn home-outline" data-email-action="${action}"${disabled ? ' disabled' : ''}>${label}</button>`;
    const notice = loadState === 'denied' ? '<p role="status">Sign in to review email follow-ups.</p>'
      : loadState === 'error' ? `<p role="status">Could not load email follow-ups.${loaded && rows.length ? ' Showing the last successful read.' : ''}</p>${button('retry', 'Retry email follow-ups')}`
        : loadState === 'loading' ? '<p role="status">Updating email follow-ups…</p>' : '';
    container.innerHTML = `<header class="home-panel-head"><h2>Email follow-ups</h2></header>${notice}${loaded && !rows.length && loadState === 'ready' ? '<p class="home-empty">No pending email follow-ups.</p>' : ''}${rows.map(row => {
      const state = decisions.get(row.id) || { status: 'pending' }, preview = state.preview || row.preview;
      let controls = '';
      if (state.status === 'editing') {
        controls = `<div class="email-review"><p>To: ${E(state.to.join(', '))}</p><p>CC: ${E(state.cc.join(', '))}</p><p>Submit authorizes sending this exact reply to these recipients.</p><label>Subject<input type="text" maxlength="998" data-email-subject value="${E(state.subject)}"></label><label>Message<textarea rows="8" maxlength="20000" data-email-body>${E(state.body)}</textarea></label>${state.updatedDraft ? `<details><summary>Updated saved draft</summary><p>${E(state.updatedDraft.subject)}</p><p>${E(state.updatedDraft.body)}</p></details>` : ''}${state.conflict ? button('review-updated', 'Review updated draft', loadState !== 'ready') : button('submit-draft', 'Submit', loadState !== 'ready')}${button('cancel', 'Cancel')}</div>`;
      } else if (state.status === 'reviewing') {
        const replaces = row.kind === 'phase_move' ? `Moves from ${phase(preview.from_phase)} to ${phase(preview.to_phase)}.`
          : preview.owner === 'dell' ? `Replaces Dell's open actions: ${(preview.current_owner_actions || []).map(item => `${item.description} · ${day(item.due_date)}`).join('; ') || 'None'}.`
            : `Replaces ${preview.current_next_step || 'no current next step'} · ${day(preview.current_next_date)}.`;
        controls = `<div class="email-review"><p>${E(replaces)}</p><p>Joe confirms this change to the deal.</p>${button('confirm', 'Confirm change', loadState !== 'ready')}${button('cancel', 'Cancel')}</div>`;
      } else if (state.status === 'dismissing') {
        controls = `<label>Reason for dismissal<textarea maxlength="500" rows="2" data-email-reason>${E(state.reason || '')}</textarea></label>${button('submit-dismiss', 'Dismiss proposal', loadState !== 'ready')}${button('cancel', 'Cancel')}`;
      } else if (state.status === 'submitting') controls = button('confirm', 'Saving…', true);
      else if (state.status === 'previewing') controls = button('preview', 'Checking preview…', true);
      else if (state.status === 'unknown') controls = button('replay', 'Check outcome');
      else if (state.status !== 'done') controls = `${row.kind === 'reply_draft' && row.reply_draft.owner === client.selfActor ? button('edit-draft', 'Review reply', loadState !== 'ready') : ''}${preview && validPreview(row, preview) ? button('preview', 'Confirm', loadState !== 'ready') : ''}${button('dismiss', 'Dismiss', loadState !== 'ready')}`;
      return `<article class="email-proposal" data-email-id="${E(row.id)}"><h3><a href="/deals?deal=${encodeURIComponent(row.deal)}">${E(row.deal_name)}</a></h3><p class="email-source">Email sender</p><q>${E(row.source.evidence_quote)}</q>${row.suspected_instruction ? `<p class="email-warning">Caution: ${E(row.suspected_instruction)}. Review the quoted email carefully.</p>` : ''}<p class="email-change">${E(change(row, preview))}</p>${!preview && row.kind !== 'reply_draft' ? '<p>This proposal cannot currently be confirmed. Open the deal to review it or dismiss it with a reason.</p>' : ''}${state.message ? `<p role="status">${E(state.message)}</p>` : ''}${state.receipt ? `<p>To: ${E(state.receipt.to.join(', '))}</p><p>CC: ${E(state.receipt.cc.join(', '))}</p>` : ''}<div class="email-controls">${controls}</div></article>`;
    }).join('')}${cursor && loadState === 'ready' ? button('more', 'Load more email follow-ups') : ''}`;
    if (active) {
      const article = [...container.querySelectorAll('[data-email-id]')].find(node => node.dataset.emailId === focusId);
      const replacement = (selection && article?.querySelector(`[data-email-${focusField}]`)) || [...(article || container).querySelectorAll('[data-email-action]')].find(node => node.dataset.emailAction === focusAction && !node.disabled)
        || article?.querySelector('button:not(:disabled), a') || container.querySelector('button:not(:disabled), h2');
      replacement?.focus();
      if (selection && replacement?.matches('textarea, input')) replacement.setSelectionRange(...selection);
    }
  }
  function retire() {
    epoch++; rows = []; cursor = null; retryCursor = null; pages = 1; decisions.clear(); loaded = false; loadState = 'denied'; render();
  }
  async function refresh(pageCursor = null) {
    if (disposed || loadState === 'denied') return;
    const ticket = ++epoch;
    retryCursor = pageCursor;
    loadState = 'loading'; render();
    try {
      let next = pageCursor ? [...rows] : [], currentCursor = pageCursor, result;
      const pageCount = pageCursor ? 1 : pages;
      for (let i = 0; i < pageCount; i++) {
        result = await readWithDeadline(() => client.listEmailProposals({ limit: 50, ...(deal ? { deal } : {}), ...(currentCursor ? { cursor: currentCursor } : {}) }), { timeoutMs: 10_000 });
        if (disposed || ticket !== epoch) return;
        if (result?.schema_version !== 'email-proposals.v1' || result.send !== false || !Array.isArray(result.proposals)
          || typeof result.more !== 'boolean' || (result.more ? !result.next_cursor || result.next_cursor === currentCursor || result.next_cursor !== result.proposals.at(-1)?.id : result.next_cursor !== null)
          || result.proposals.some(row => !row?.id || !Number.isInteger(row.version) || row.version < 1 || !KINDS[row.kind]
            || (deal && row.deal !== deal) || row.confirm_verb !== KINDS[row.kind].verb || !row.deal || !row.deal_name || !row.source?.activity_id || typeof row.source.evidence_quote !== 'string'
            || (row.kind === 'reply_draft' ? !validDraft(row) : row.preview !== null && !validPreview(row, row.preview)))) throw Error('Invalid email proposals');
        next.push(...result.proposals.filter(item => !next.some(row => row.id === item.id)));
        currentCursor = result.next_cursor;
        if (!currentCursor) break;
      }
      cursor = currentCursor;
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
      if (!result || (state.method === 'submitEmailDraft' ? !validEmailDraftReceipt(result, state.request) : state.method === 'dismissEmailProposal' ? result.ok !== true || result.status !== 'dismissed' || result.proposal_id !== row.id
        : result.status !== 'confirmed' || result.requires_confirmation !== false)) throw Error('Unconfirmed receipt');
      if (disposed || loadState === 'denied') return;
      decisions.set(row.id, { status: 'done', ...(state.method === 'submitEmailDraft' ? { receipt: result } : {}), message: state.method === 'submitEmailDraft' ? 'Submitted for sending. Delivery is not yet confirmed.' : state.method === 'dismissEmailProposal' ? 'Dismissed.' : 'Confirmed.' });
      onChange();
    } catch (error) {
      if (disposed || loadState === 'denied') return;
      if (denied(error)) return retire();
      if (error.payload?.error && !error.pendingRequest) decisions.set(row.id, state.method === 'submitEmailDraft' ? { status: 'editing', baseVersion: state.request.base_version, subject: state.request.subject, body: state.request.body, to: state.request.to, cc: state.request.cc, conflict: ['version_conflict', 'email_draft_recipients_changed'].includes(error.payload.error), message: refusal(error) } : { status: 'refused', message: refusal(error) });
      else decisions.set(row.id, { ...state, request: error.pendingRequest || state.request, status: 'unknown', message: 'Outcome unknown. Check outcome to recover the original request.' });
    }
    render();
  }
  async function click(event) {
    const button = event.target?.closest('[data-email-action]');
    if (!button || button.disabled || !container.contains(button) || disposed || loadState === 'denied') return;
    const action = button.dataset.emailAction;
    if (action === 'retry') return refresh(retryCursor);
    if (action === 'more' && cursor) { pages++; return refresh(cursor); }
    const row = rows.find(item => item.id === button.closest('[data-email-id]')?.dataset.emailId);
    if (!row) return;
    const state = decisions.get(row.id) || { status: 'pending' };
    if (['previewing', 'submitting', 'done'].includes(state.status)) return;
    if (action === 'replay' && state.status === 'unknown') return submit(row, state);
    if (state.status === 'unknown') return;
    if (action === 'cancel') { decisions.delete(row.id); render(); return; }
    if (loadState !== 'ready') return;
    if (action === 'edit-draft' && row.kind === 'reply_draft' && row.reply_draft.owner === client.selfActor) {
      decisions.set(row.id, { status: 'editing', baseVersion: row.version, subject: row.reply_draft.subject, body: row.reply_draft.body, to: [...row.reply_draft.to], cc: [...row.reply_draft.cc] }); render();
      [...container.querySelectorAll('[data-email-id]')].find(node => node.dataset.emailId === row.id)?.querySelector('input')?.focus();
    }
    if (action === 'review-updated' && state.status === 'editing' && state.conflict) {
      await refresh();
      if (disposed || loadState !== 'ready' || decisions.get(row.id) !== state) return;
      const current = rows.find(item => item.id === row.id && item.kind === 'reply_draft');
      if (current && current.reply_draft.owner === client.selfActor) decisions.set(row.id, { ...state, baseVersion: current.version, to: [...current.reply_draft.to], cc: [...current.reply_draft.cc], conflict: false, message: '', updatedDraft: current.reply_draft });
      render(); return;
    }
    if (action === 'submit-draft' && state.status === 'editing' && !state.conflict && row.reply_draft.owner === client.selfActor) {
      if (!state.subject.trim() || /[\r\n]/.test(state.subject) || state.subject.length > 998 || !state.body.trim() || state.body.length > 20000) {
        decisions.set(row.id, { ...state, message: 'Enter a subject without line breaks and a message before submitting.' }); render(); return;
      }
      return submit(row, { method: 'submitEmailDraft', request: { proposal_id: row.id, base_version: state.baseVersion, subject: state.subject, body: state.body, to: [...state.to], cc: [...state.cc], idempotency_key: uuidv4() } });
    }
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
    if (!event.target.matches('[data-email-reason], [data-email-subject], [data-email-body]')) return;
    const state = decisions.get(event.target.closest('[data-email-id]').dataset.emailId);
    if (state?.status === 'dismissing') state.reason = event.target.value;
    if (state?.status === 'editing') state[event.target.hasAttribute('data-email-subject') ? 'subject' : 'body'] = event.target.value;
  };
  container.addEventListener('input', input);
  container.addEventListener('click', click);
  win?.addEventListener('doctorcre-session-invalidated', retire);
  return { refresh, click, update: render, dispose() { retire(); disposed = true; container.removeEventListener('click', click); container.removeEventListener('input', input); win?.removeEventListener('doctorcre-session-invalidated', retire); } };
}
