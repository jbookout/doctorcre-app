import { mountLocalTicker } from './visibility-poll.mjs';
import { createPageBudget } from './read-budget.mjs';
import { homeListLimit } from './ui.generated.js';
import { workCard } from './work-card.js';
import { validEmailDraftAddresses } from './email-draft.js';
import { PHASE_BY_SLUG } from './client.js';
import { uuidv4 } from './uuid.js';
import { readWithDeadline } from './current-read.mjs';
import { sourceTime, waitingDays } from './email-source-line.js';

const E = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const emailSource = source => `${String(source.sender || '').split('<', 1)[0].replace(/^[\"'\s]+|[\"'\s]+$/g, '') || 'Sender unavailable'} · ${sourceTime(source.occurred_at)} · ${waitingDays(source.occurred_at)}`;
const day = value => value ? new Date(`${value}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'No date';
const owner = value => ({ joe: 'Joe', dell: 'Dell' })[value] || 'Owner unavailable';
const phase = value => PHASE_BY_SLUG[value] || 'Phase unavailable';
const KINDS = {
  file_to_deal: { confirm: 'confirmEmailFiling', verb: 'confirm-email-filing', contract: 'email-filing.v1' },
  possible_new_deal: { confirm: 'confirmEmailFiling', verb: 'confirm-email-filing', contract: 'email-filing.v1' },
  next_step: { preview: 'previewEmailNextStep', confirm: 'confirmEmailNextStep', verb: 'confirm-email-next-step', contract: 'email-next-step.v1' },
  reply_draft: { verb: 'submit-email-draft' },
  phase_move: { preview: 'previewEmailDealProgress', confirm: 'confirmEmailDealProgress', verb: 'confirm-email-deal-progress', contract: 'email-deal-progress.v1' },
};
const DISMISS_REASONS = ['Already handled', 'Wrong deal', 'Not now'];
const createdLinks = deals => (deals || []).map(deal => `<p>Previously created deal: <a href="/deals?deal=${encodeURIComponent(deal)}">Open created deal</a></p>`).join('');
const SUBJECT_LABELS = new Map([['client','Client'],['lead','Lead'],['vendor','Vendor']]);
const subjectLabel = type => SUBJECT_LABELS.get(type);
const filing = row => ['file_to_deal', 'possible_new_deal'].includes(row.kind);
const change = (row, preview) => filing(row) ? (row.kind === 'possible_new_deal' ? row.proposed_matter || 'Possible new deal' : 'File email to this deal') : row.kind === 'reply_draft' ? `Reply draft · ${row.reply_draft.subject} · ${owner(row.reply_draft.owner)}` : !preview ? 'Proposal needs a fresh review'
  : row.kind === 'next_step' ? `${preview.text} · ${day(preview.next_date)} · ${owner(preview.owner)}`
    : `${phase(preview.from_phase)} → ${phase(preview.to_phase)}`;
const argsFor = (row, preview) => ({ deal: row.deal, activity_id: row.source.activity_id, evidence_quote: row.source.evidence_quote,
  ...(row.kind === 'next_step' ? { text: preview.text, next_date: preview.next_date, owner: preview.owner } : {}) });
const validDraft = row => row.preview === null && typeof row.reply_draft?.subject === 'string' && row.reply_draft.subject.trim()
  && row.reply_draft.subject.length <= 998 && typeof row.reply_draft.body === 'string' && row.reply_draft.body.length <= 20000
  && ['joe', 'dell'].includes(row.reply_draft.owner)
  && (row.confirm_verb === 'submit-email-draft' ? validEmailDraftAddresses(row.reply_draft.to) && validEmailDraftAddresses(row.reply_draft.cc)
    : row.confirm_verb === null && ['email_draft_source_missing', 'email_draft_copy_address_missing'].includes(row.preview_error)
      && !Object.hasOwn(row.reply_draft, 'to') && !Object.hasOwn(row.reply_draft, 'cc'));
const validPreview = (row, preview) => filing(row) ? preview?.contract === 'email-filing.v1' && preview.proposal_id === row.id && preview.kind === row.kind
  && preview.deal === row.deal && preview.activity_id === row.source.activity_id && preview.evidence_quote === row.source.evidence_quote
  && preview.requires_confirmation === true && /^sha256:[a-f0-9]{64}$/.test(preview.proposal_digest) && preview.sender && Array.isArray(preview.new_people)
  : preview?.contract === KINDS[row.kind]?.contract && preview.status === 'proposed'
  && preview.requires_confirmation === true && /^sha256:[a-f0-9]{64}$/.test(preview.proposal_digest)
  && preview.deal === row.deal && (row.deal !== null || (row.kind === 'next_step' && subjectLabel(row.subject_type)
    && preview.subject_type === row.subject_type && preview.subject_id === row.subject_id && preview.subject_name === row.subject_name
    && typeof row.subject_id === 'string' && row.subject_id && typeof row.subject_name === 'string' && row.subject_name.trim()))
  && preview.source?.activity_id === row.source.activity_id && preview.evidence_quote === row.source.evidence_quote
  && (row.kind === 'next_step' ? typeof preview.text === 'string' && preview.text.trim() && /^\d{4}-\d{2}-\d{2}$/.test(preview.next_date)
    && ['joe', 'dell'].includes(preview.owner) : Boolean(PHASE_BY_SLUG[preview.from_phase] && PHASE_BY_SLUG[preview.to_phase]));
const denied = error => [401, 403].includes(error.status) || error.code === 'session_changed';


export function mountEmailFollowups({ container, client, deal, onChange = () => {} }) {
  const win = container.ownerDocument.defaultView;
  let visibleCount = deal ? Infinity : homeListLimit(win);
  let rows = [], loaded = false, loadState = 'loading', epoch = 0, disposed = false, cursor = null, retryCursor = null, pages = 1;
  const decisions = new Map();
  const refusedCreations = new Map();
  function render() {
    if (disposed) return;
    const active = container.contains(container.ownerDocument.activeElement) ? container.ownerDocument.activeElement : null;
    const selection = active?.matches('textarea, input') ? [active.selectionStart, active.selectionEnd] : null;
    const focusField = active?.hasAttribute('data-email-subject') ? 'subject' : active?.hasAttribute('data-email-body') ? 'body' : active?.hasAttribute('data-email-deal-name') ? 'deal-name' : active?.hasAttribute('data-email-deal-client') ? 'deal-client' : 'reason';
    const focusId = active?.closest('[data-email-id]')?.dataset.emailId, focusAction = active?.dataset.emailAction;
    container.setAttribute('aria-busy', String(loadState === 'loading'));
    const button = (action, label, disabled = false) => `<button type="button" class="btn home-outline" data-email-action="${action}"${disabled ? ' disabled' : ''}>${label}</button>`;
    const notice = loadState === 'denied' ? '<p role="status">Sign in to review email follow-ups.</p>'
      : loadState === 'error' ? `<p role="status">Could not load email follow-ups.${loaded && rows.length ? ' Showing the last successful read.' : ''}</p>${button('retry', 'Retry email follow-ups')}`
        : loadState === 'loading' && !loaded ? '<div class="home-followup-skeleton" role="status">Loading email follow-ups…</div>' : '';
    container.innerHTML = `<header class="home-panel-head"><h2>Email follow-ups</h2>${!deal && rows.length > visibleCount ? `<span class="home-list-count">Showing ${visibleCount} of ${rows.length}${cursor ? "+" : ""}</span>` : ""}</header>${notice}${loaded && !rows.length && loadState === 'ready' ? '<p class="home-empty">No email follow-ups.</p>' : ''}${rows.slice(0, visibleCount).map(row => {
      const state = decisions.get(row.id) || { status: 'pending' }, preview = state.preview || row.preview;
      let controls = '';
      if (state.status === 'editing') {
        controls = `<div class="email-review"><p>To: ${E(state.to.join(', '))}</p><p>CC: ${E(state.cc.join(', '))}</p><p>Submit authorizes sending this exact reply to these recipients.</p><label>Subject<input type="text" maxlength="998" data-email-subject value="${E(state.subject)}"></label><label>Message<textarea rows="8" maxlength="20000" data-email-body>${E(state.body)}</textarea></label>${state.updatedDraft ? `<details><summary>Updated saved draft</summary><p>${E(state.updatedDraft.subject)}</p><p>${E(state.updatedDraft.body)}</p></details>` : ''}${state.conflict ? button('review-updated', 'Review updated draft', loadState !== 'ready') : button('submit-draft', 'Submit', loadState !== 'ready' || row.confirm_verb !== 'submit-email-draft')}${button('cancel', 'Cancel')}</div>`;
      } else if (state.status === 'filing') {
        controls = `<div class="email-review">${createdLinks(state.createdDeals)}${preview.new_people.map(person => `<p>Person: ${E(person.name || person.email || 'Unknown')}</p>`).join('')}${row.kind === 'possible_new_deal' && !state.deal ? !preview.sender.party_id ? '<p>Add the sender as a contact first. Refresh the proposal after adding the contact.</p>' : `<label>Deal name<input data-email-deal-name value="${E(state.name || '')}"></label><label>Existing client (reference or exact name)<input data-email-deal-client value="${E(state.client || '')}"></label>${button('create-filing', 'Create deal and confirm filing', loadState !== 'ready')}` : `${state.deal ? `<p>Created deal: <a href="/deals?deal=${encodeURIComponent(state.deal)}">Open created deal</a></p>` : ''}${button('confirm-filing', 'Confirm filing', loadState !== 'ready')}`}${state.deal ? '' : button('cancel', 'Cancel')}</div>`;
      } else if (state.status === 'reviewing') {
        const replaces = row.kind === 'phase_move' ? `Moves from ${phase(preview.from_phase)} to ${phase(preview.to_phase)}.`
          : preview.owner === 'dell' ? `Replaces Dell's open actions: ${(preview.current_owner_actions || []).map(item => `${item.description} · ${day(item.due_date)}`).join('; ') || 'None'}.`
            : `Replaces ${preview.current_next_step || 'no current next step'} · ${day(preview.current_next_date)}.`;
        controls = `<div class="email-review"><p>${E(replaces)}</p><p>Joe confirms this change to the ${row.deal ? 'deal' : E(row.subject_type)}.</p>${button('confirm', 'Confirm change', loadState !== 'ready')}${button('cancel', 'Cancel')}</div>`;
      } else if (state.status === 'dismissing') {
        controls = `<label>Reason for dismissal<textarea maxlength="500" rows="2" data-email-reason>${E(state.reason || '')}</textarea></label>${button('submit-dismiss', 'Dismiss proposal', loadState !== 'ready')}${button('cancel', 'Cancel')}`;
      } else if (state.status === 'creation-refused') controls = `${button('edit-filing', 'Edit deal details')}${button('cancel', 'Cancel')}`;
      else if (state.status === 'filing-refused') controls = `<p>Deal created: <a href="/deals?deal=${encodeURIComponent(state.deal)}">Open created deal</a>. Refresh the proposal before filing it.</p>${button('refresh-filing', 'Refresh filing')}${state.correctable ? button('correct-filing', 'Create a corrected deal') : ''}`;
      else if (state.status === 'submitting') controls = button('confirm', 'Saving…', true);
      else if (state.status === 'previewing') controls = button('preview', 'Checking preview…', true);
      else if (state.status === 'unknown') controls = button('replay', 'Check outcome');
      else if (state.status !== 'done') controls = `${row.kind === 'reply_draft' && row.confirm_verb === 'submit-email-draft' && row.reply_draft.owner === client.selfActor ? button('edit-draft', 'Review reply', loadState !== 'ready') : ''}${preview && validPreview(row, preview) ? button(filing(row) ? 'review-filing' : 'preview', filing(row) ? 'Review filing' : 'Confirm', loadState !== 'ready') : ''}<div class="email-dismiss" role="group" aria-label="Dismiss reason"><span>Dismiss</span>${DISMISS_REASONS.map(reason => `<button type="button" class="btn home-outline email-chip" data-email-action="dismiss-chip" data-email-chip="${reason}"${loadState !== 'ready' ? ' disabled' : ''}>${reason}</button>`).join('')}${button('note', 'Add a note', loadState !== 'ready')}</div>`;
      return workCard({ className: 'email-proposal', attributes: `data-email-id="${E(row.id)}"`,
        title: E(row.source.subject || 'Subject unavailable'),
        meta: `<p class="email-source"></p><p>${row.deal ? `<a href="/deals?deal=${encodeURIComponent(row.deal)}">${E(row.deal_name)}</a>` : row.kind === 'possible_new_deal' ? 'Possible new deal' : `${E(subjectLabel(row.subject_type) || 'Contact')} · ${E(row.subject_name || 'Follow-up')}`}</p>${filing(row) && preview ? `<p>Sender: ${E(preview.sender.name || preview.sender.email || 'Unknown')} · ${E(preview.sender_role)}</p>` : ''}`,
        status: state.status === 'done' ? 'Reviewed' : '',
        body: `<q>${E(row.source.evidence_quote)}</q>${row.suspected_instruction ? `<p class="email-warning">Caution: ${E(row.suspected_instruction)}. Review the quoted email carefully.</p>` : ''}<p class="email-change">${E(change(row, preview))}</p>${!preview && row.kind !== 'reply_draft' ? '<p>This proposal cannot currently be confirmed. Review the source email or dismiss it with a reason.</p>' : ''}${row.kind === 'reply_draft' && row.confirm_verb === null ? '<p>Recipient addresses are unavailable. Refresh to check them before reviewing this reply, or dismiss it with a reason.</p>' : ''}${state.message ? `<p role="status">${E(state.message)}</p>` : ''}${state.receipt ? `<p>To: ${E(state.receipt.to.join(', '))}</p><p>CC: ${E(state.receipt.cc.join(', '))}</p>` : ''}`, actions: `<div class="email-controls">${controls}</div>` });
    }).join('')}${rows.length > visibleCount ? button('show', `Show ${rows.length - visibleCount} more`) : ''}${cursor && loadState === 'ready' ? button('more', 'Load more email follow-ups') : ''}`;
    for (const article of container.querySelectorAll('[data-email-id]')) {
      const { source } = rows.find(row => row.id === article.dataset.emailId);
      article.querySelector('.email-source').textContent = emailSource(source);
      article.querySelector('.email-source').title = sourceTime(source.occurred_at);
    }
    if (active) {
      const article = [...container.querySelectorAll('[data-email-id]')].find(node => node.dataset.emailId === focusId);
      const replacement = (selection && article?.querySelector(`[data-email-${focusField}]`)) || [...(article || container).querySelectorAll('[data-email-action]')].find(node => node.dataset.emailAction === focusAction && !node.disabled)
        || article?.querySelector('button:not(:disabled), a') || container.querySelector('button:not(:disabled), h2');
      replacement?.focus();
      if (selection && replacement?.matches('textarea, input')) replacement.setSelectionRange(...selection);
    }
  }
  function retire() {
    minute.dispose(); epoch++; rows = []; cursor = null; retryCursor = null; pages = 1; decisions.clear(); refusedCreations.clear(); loaded = false; loadState = 'denied'; render();
  }
  async function refresh(pageCursor = null) {
    if (disposed || loadState === 'denied') return;
    const ticket = ++epoch;
    retryCursor = pageCursor;
    loadState = 'loading'; render();
    try {
      let next = pageCursor ? [...rows] : [], currentCursor = pageCursor, result;
      const pageCount = pageCursor ? 1 : pages;
      const takePage = createPageBudget({ document: container.ownerDocument });
      // eslint-disable-next-line no-restricted-syntax -- Follow-up pagination calls takePage for each of pageCount retained pages; at most 100 reads per refresh.
      for (let i = 0; i < pageCount; i++) {
        takePage();
        result = await readWithDeadline(() => client.listEmailProposals({ limit: 50, ...(deal ? { deal } : { include_non_deal: true }), ...(currentCursor ? { cursor: currentCursor } : {}) }), { timeoutMs: 10_000 });
        if (disposed || ticket !== epoch) return;
        if (result?.schema_version !== 'email-proposals.v1' || result.send !== false || !Array.isArray(result.proposals)
          || typeof result.more !== 'boolean' || (result.more ? !result.next_cursor || result.next_cursor === currentCursor || result.next_cursor !== result.proposals.at(-1)?.id : result.next_cursor !== null)
          || result.proposals.filter(row => Object.hasOwn(KINDS, row?.kind)).some(row => !row?.id || !Number.isInteger(row.version) || row.version < 1
            || (deal && row.deal !== deal) || (row.confirm_verb !== KINDS[row.kind].verb && !(row.kind === 'reply_draft' && row.confirm_verb === null)) || (row.deal === null ? !['possible_new_deal','next_step'].includes(row.kind) : !row.deal || !row.deal_name) || !row.source?.activity_id || typeof row.source.evidence_quote !== 'string'
            || (row.kind === 'reply_draft' ? !validDraft(row) : row.preview !== null && !validPreview(row, row.preview)))) throw Error('Invalid email proposals');
        next.push(...result.proposals.filter(item => Object.hasOwn(KINDS, item?.kind) && !next.some(row => row.id === item.id)));
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
      const { submitEmailProposal } = await import('./email-proposal-command.js');
      if (disposed || loadState === 'denied') return;
      const decision = await submitEmailProposal(client, row, state);
      if (disposed || loadState === 'denied') return;
      decisions.set(row.id, decision);
      if (decision.status === 'done') onChange();
    } catch (error) {
      if (disposed || loadState === 'denied') return;
      if (denied(error)) return retire();
      decisions.set(row.id, { ...state, request: error.pendingRequest || state.request, status: 'unknown', message: 'Outcome unknown. Check outcome to recover the original request.' });
    }
    render();
  }
  async function createFiling(row, state) {
    decisions.set(row.id, { ...state, status: 'submitting' }); render();
    try {
      const result = await client.createDeal(state.createRequest);
      if (!result?.deal_id) throw Error('Created deal receipt unavailable');
      if (disposed || loadState === 'denied') return;
      return submit(row, { method: 'confirmEmailFiling', request: { proposal_id: row.id, base_version: state.baseVersion, proposal_digest: state.preview.proposal_digest, deal: result.deal_id, idempotency_key: uuidv4() }, createdDeals: state.createdDeals });
    } catch (error) {
      if (disposed || loadState === 'denied') return;
      if (denied(error)) return retire();
      if (error.creationRefused || (error.creationStage === 'new-deal' && error.payload?.error)) {
        const refused = refusedCreations.get(row.id) || [];
        refused.push({ name: state.createRequest.name, client: state.createRequest.client });
        refusedCreations.set(row.id, refused);
        decisions.set(row.id, { ...state, status: 'creation-refused', message: error.creationRefused
          ? 'Deal creation was refused. Edit the deal name or existing client before trying again.'
          : 'Deal creation was not confirmed. Check the Deals list before editing the details to avoid creating a duplicate.' });
      }
      else decisions.set(row.id, { ...state, status: 'unknown', message: 'Deal creation outcome unknown. Check outcome to recover the original request.' });
      render();
    }
  }
  async function click(event) {
    const button = event.target?.closest('[data-email-action]');
    if (!button || button.disabled || !container.contains(button) || disposed || loadState === 'denied') return;
    const action = button.dataset.emailAction;
    if (action === 'show') { visibleCount = rows.length; render(); return; }
    if (action === 'retry') return refresh(retryCursor);
    if (action === 'more' && cursor) { pages++; return refresh(cursor); }
    const row = rows.find(item => item.id === button.closest('[data-email-id]')?.dataset.emailId);
    if (!row) return;
    const state = decisions.get(row.id) || { status: 'pending' };
    if (['previewing', 'submitting', 'done'].includes(state.status)) return;
    if (state.status === 'filing-refused' && !['refresh-filing', 'correct-filing'].includes(action)) return;
    if (['refresh-filing', 'correct-filing'].includes(action) && state.status === 'filing-refused') {
      await refresh();
      const current = rows.find(item => item.id === row.id);
      if (!disposed && loadState === 'ready' && current && validPreview(current, current.preview)) decisions.set(row.id, { status: 'filing', preview: current.preview, baseVersion: current.version, ...(action === 'correct-filing' ? { createdDeals: [...state.createdDeals, state.deal] } : { deal: state.deal, createdDeals: state.createdDeals }) });
      render(); return;
    }
    if (action === 'replay' && state.status === 'unknown') return state.createRequest ? createFiling(row, state) : submit(row, state);
    if (state.status === 'unknown') return;
    if (action === 'edit-filing' && state.status === 'creation-refused') {
      decisions.set(row.id, { ...state, status: 'filing', createRequest: null }); render(); return;
    }
    if (action === 'cancel') { decisions.delete(row.id); render(); return; }
    if (loadState !== 'ready') return;
    if (action === 'edit-draft' && row.kind === 'reply_draft' && row.confirm_verb === 'submit-email-draft' && row.reply_draft.owner === client.selfActor) {
      decisions.set(row.id, { status: 'editing', baseVersion: row.version, subject: row.reply_draft.subject, body: row.reply_draft.body, to: [...row.reply_draft.to], cc: [...row.reply_draft.cc] }); render();
      [...container.querySelectorAll('[data-email-id]')].find(node => node.dataset.emailId === row.id)?.querySelector('input')?.focus();
    }
    if (action === 'review-updated' && state.status === 'editing' && state.conflict) {
      await refresh();
      if (disposed || loadState !== 'ready' || decisions.get(row.id) !== state) return;
      const current = rows.find(item => item.id === row.id && item.kind === 'reply_draft');
      if (current && current.confirm_verb === 'submit-email-draft' && current.reply_draft.owner === client.selfActor) decisions.set(row.id, { ...state, baseVersion: current.version, to: [...current.reply_draft.to], cc: [...current.reply_draft.cc], conflict: false, message: '', updatedDraft: current.reply_draft });
      render(); return;
    }
    if (action === 'submit-draft' && state.status === 'editing' && !state.conflict && row.confirm_verb === 'submit-email-draft' && row.reply_draft.owner === client.selfActor) {
      if (!state.subject.trim() || /[\r\n]/.test(state.subject) || state.subject.length > 998 || !state.body.trim() || state.body.length > 20000) {
        decisions.set(row.id, { ...state, message: 'Enter a subject without line breaks and a message before submitting.' }); render(); return;
      }
      return submit(row, { method: 'submitEmailDraft', request: { proposal_id: row.id, base_version: state.baseVersion, subject: state.subject, body: state.body, to: [...state.to], cc: [...state.cc], idempotency_key: uuidv4() } });
    }
    if (action === 'dismiss-chip' && DISMISS_REASONS.includes(button.dataset.emailChip)) return submit(row, { method: 'dismissEmailProposal', request: { proposal_id: row.id, base_version: row.version, reason: button.dataset.emailChip, idempotency_key: uuidv4() } });
    if (action === 'note') { decisions.set(row.id, { status: 'dismissing', baseVersion: row.version }); render(); [...container.querySelectorAll('[data-email-id]')].find(node => node.dataset.emailId === row.id)?.querySelector('textarea')?.focus(); }
    if (action === 'submit-dismiss' && state.status === 'dismissing') {
      const reason = button.closest('article').querySelector('textarea').value.trim();
      if (!reason || reason.length > 500) { button.closest('article').querySelector('textarea').focus(); return; }
      return submit(row, { method: 'dismissEmailProposal', request: { proposal_id: row.id, base_version: state.baseVersion, reason, idempotency_key: uuidv4() } });
    }
    if (action === 'review-filing' && filing(row) && validPreview(row, row.preview)) { decisions.set(row.id, { status: 'filing', preview: row.preview, baseVersion: row.version }); render(); return; }
    if (action === 'confirm-filing' && state.status === 'filing' && (row.kind === 'file_to_deal' || state.deal)) return submit(row, { method: 'confirmEmailFiling', request: { proposal_id: row.id, base_version: state.baseVersion, proposal_digest: state.preview.proposal_digest, ...(state.deal ? { deal: state.deal } : {}), idempotency_key: uuidv4() }, createdDeals: state.createdDeals });
    if (action === 'create-filing' && state.status === 'filing' && row.kind === 'possible_new_deal' && state.preview.sender.party_id) {
      if (!state.name?.trim() || !state.client?.trim()) { state.message = 'Enter a deal name and client.'; render(); return; }
      if (refusedCreations.get(row.id)?.some(request => request.name === state.name.trim() && request.client === state.client.trim())) {
        state.message = 'These details were already refused. Change the deal name or existing client before trying again.'; render(); return;
      }
      return createFiling(row, { ...state, createRequest: { name: state.name.trim(), client: state.client.trim(), idempotency_key: uuidv4() } });
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
    if (!event.target.matches('[data-email-reason], [data-email-subject], [data-email-body], [data-email-deal-name], [data-email-deal-client]')) return;
    const state = decisions.get(event.target.closest('[data-email-id]').dataset.emailId);
    if (state?.status === 'dismissing') state.reason = event.target.value;
    if (state?.status === 'filing') state[event.target.hasAttribute('data-email-deal-name') ? 'name' : 'client'] = event.target.value;
    if (state?.status === 'editing') state[event.target.hasAttribute('data-email-subject') ? 'subject' : 'body'] = event.target.value;
  };
  container.addEventListener('input', input);
  container.addEventListener('click', click);
  const minute = mountLocalTicker({ document: container.ownerDocument, window: win, intervalMs: 60_000, tick: () => {
    for (const article of container.querySelectorAll('[data-email-id]')) {
      const row = rows.find(row => row.id === article.dataset.emailId);
      if (row) {
        article.querySelector('.email-source').textContent = emailSource(row.source);
        article.querySelector('.email-source').title = sourceTime(row.source.occurred_at);
      }
    }
  } });
  win?.addEventListener('doctorcre-session-invalidated', retire);
  return { refresh, click, update: render, dispose() { retire(); disposed = true; container.removeEventListener('click', click); container.removeEventListener('input', input); win?.removeEventListener('doctorcre-session-invalidated', retire); } };
}
