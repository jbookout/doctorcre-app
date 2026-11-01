import { validEmailDraftReceipt, validEmailDraftSaveReceipt } from './email-draft.js';

const refusal = error => {
  const code = error.payload?.error;
  if (/^email_(?:source_owner_mismatch|proposal_(?:confidence_invalid|fields_invalid|source_missing|quote_invalid|evidence_invalid|deal_invalid|not_pending|stale)|new_deal_(?:client_mismatch|not_found)|thread_(?:not_continuous|ambiguous|recipient_changed)|sender_contact_required)$/.test(code || '') && typeof error.payload.hint === 'string') return error.payload.hint;
  if (code === 'joe_confirmation_required') return 'Only Joe can confirm email changes. Joe or Dell can dismiss them.';
  if (code === 'email_draft_recipients_mismatch') return 'Recipients changed. Review updated draft to check the exact To and CC addresses before submitting again.';
  if (code === 'email_draft_not_owner') return 'Only the partner who received this email can submit its reply.';
  if (code === 'email_draft_copy_address_missing') return 'The other partner needs an email address before this reply can be submitted.';
  if (code === 'email_draft_already_submitted') return 'This reply has already been submitted. Refresh to review the current state.';
  if (code === 'partner_dismissal_required') return 'Only Joe or Dell can dismiss email proposals.';
  if (code?.includes('stale') || code === 'version_conflict') return 'This proposal or deal changed. Refresh and review it again.';
  return 'This proposal could not be applied. Refresh and review the deal before trying again.';
};

const draftSaveRefusal = code => ({
  version_conflict: 'This draft changed. Reload the draft and review it before saving again.',
  email_draft_not_found: 'This draft is no longer available. Reload to review current drafts.',
  email_draft_not_owner: 'Only the partner who received this email can save its reply draft.',
  email_draft_not_pending: 'This reply is no longer a pending draft. Reload to review its current state.',
  email_draft_empty_body: 'Enter a message before saving the draft.',
  email_draft_subject_invalid: 'Enter a subject without line breaks before saving the draft.',
  invalid_field_value: 'Use a subject of at most 998 characters and a message of at most 20,000 characters.',
  key_reuse: 'This save request was already used for different text. Reload before saving again.',
  offline: 'You are offline. Reconnect before saving the draft.',
})[code] || 'The draft could not be saved. Reload and review it before trying again.';

export async function submitEmailProposal(client, row, state) {
  try {
    const result = await client[state.method](state.request);
    if (state.method === 'editEmailDraft') {
      if (!validEmailDraftSaveReceipt(result, state.request)) throw Error('Unconfirmed draft save receipt');
      return { status: 'editing', baseVersion: result.version, subject: result.subject, body: result.body,
        to: state.to, cc: state.cc, saved: true, message: 'Saved as a draft. Nothing was sent.' };
    }
    if (!result || (state.method === 'submitEmailDraft' ? !validEmailDraftReceipt(result, state.request) : state.method === 'confirmEmailFiling' ? result.ok !== true || result.status !== 'confirmed' || result.activity_id !== row.source.activity_id || result.deal !== (state.request.deal || row.deal) : state.method === 'dismissEmailProposal' ? result.ok !== true || result.status !== 'dismissed' || result.proposal_id !== row.id
      : result.status !== 'confirmed' || result.requires_confirmation !== false)) throw Error('Unconfirmed receipt');
    return { status: 'done', ...(state.method === 'submitEmailDraft' ? { receipt: result } : {}), message: state.method === 'submitEmailDraft' ? 'Submitted for sending. Delivery is not yet confirmed.' : state.method === 'dismissEmailProposal' ? 'Dismissed.' : 'Confirmed.' };
  } catch (error) {
    if ([401, 403].includes(error.status) || error.code === 'session_changed') throw error;
    if (state.method === 'editEmailDraft' && error.payload?.error && !error.pendingRequest)
      return { ...state, status: 'editing', saved: false, conflict: ['version_conflict', 'key_reuse', 'email_draft_not_pending', 'email_draft_not_found'].includes(error.payload.error), message: draftSaveRefusal(error.payload.error) };
    if (error.payload?.error && !error.pendingRequest) return state.method === 'submitEmailDraft' ? { status: 'editing', baseVersion: state.request.base_version, subject: state.request.subject, body: state.request.body, to: state.request.to, cc: state.request.cc, conflict: ['version_conflict', 'email_draft_recipients_mismatch'].includes(error.payload.error), message: refusal(error) } : state.method === 'confirmEmailFiling' && state.request.deal ? { status: 'filing-refused', deal: state.request.deal, createdDeals: state.createdDeals || [], correctable: ['email_new_deal_client_mismatch', 'email_new_deal_not_found'].includes(error.payload.error), message: refusal(error) } : { status: 'refused', message: refusal(error) };
    return { ...state, request: error.pendingRequest || state.request, status: 'unknown', message: 'Outcome unknown. Check outcome to recover the original request.' };
  }
}
