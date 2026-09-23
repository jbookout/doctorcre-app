/**
 * Deal Room Call Mode: record Joe and Dell's pipeline call, then review it.
 *
 * Restored from the working Deal Room shell that carr-system 13411964 (#963)
 * made inert for the first workspace release, and reinstated by decision
 * 7dc47eea (Joe, 2026-09-23): "a button on the deal room page that started
 * recording our conversation, transcribed, and fed back to the system for
 * context and updates." It is not a way to hold a meeting with a client or a
 * vendor; that stays a Teams meeting.
 *
 * The recorder is Quill on the partner's own Mac. This page reaches it only
 * through the loopback companion at http://127.0.0.1:4682 (carr-system
 * tools/dictation-rig/bin/call-mode.py), and only because a partner pressed a
 * control:
 *
 *   - creating the controller sends nothing and starts no timer;
 *   - opening the dialog reads the recorder's state, nothing more;
 *   - a recording starts only from a Start button AND the consent box ticked
 *     ("I have told everyone on this call that it will be recorded"), and the
 *     companion refuses a start without consent_confirmed as well;
 *   - the post-call review pack is only ever displayed. Every task, deal update
 *     and email draft in it waits for a partner to Confirm or Skip that item;
 *     nothing is written to the record and no Outlook draft is created before
 *     that. There is no send path at all.
 *
 * The weekly call needs a short-lived deal context index so the local
 * distiller can attach what was said to exact deals and people. It is read
 * from get-call-context (at most 50 deals a request, so the agenda is read in
 * batches), shaped to the companion's exact contract, and handed to the
 * companion at start. If the recording's report is still `awaiting_context`
 * when this page next looks at it — the page was closed at start, or the index
 * failed — it is supplied again then, and the companion processes the
 * transcript it already has.
 */
import { uuidv4 } from './uuid.js';
import { escapeText as esc } from './change-receipts.mjs';

export const CALL_MODE_URL = 'http://127.0.0.1:4682';
export const CALL_MODE_HEADER = Object.freeze({ 'X-CARR-Call-Mode': 'deal-room-v1' });
/** get-call-context refuses more than this many deal ids in one request. */
export const CALL_CONTEXT_BATCH = 50;
export const CALL_MODES = Object.freeze(['weekly_deal_call', 'other_call']);

/**
 * The index the companion's validate_context accepts, from get-call-context's
 * answer: string owner/name/state, and only participants that are an exact,
 * addressable party (the partners' own "lead" rows carry no party and are not
 * someone a draft can go to). Nothing is looked up by name.
 */
export function shapeCallContextDeals(deals) {
  const text = (value) => (value == null ? '' : String(value));
  return deals.map((deal) => {
    const participants = [];
    const seen = new Map();
    for (const party of Array.isArray(deal.participants) ? deal.participants : []) {
      if (!party || party.party_id == null || !text(party.ref).trim()) continue;
      const partyId = String(party.party_id);
      const role = text(party.role);
      const prior = seen.get(partyId);
      if (prior) {
        if (role && !prior.role.split(', ').includes(role)) prior.role = prior.role ? `${prior.role}, ${role}` : role;
        continue;
      }
      const shaped = { party_id: partyId, ref: text(party.ref), name: text(party.name), email: text(party.email), role };
      seen.set(partyId, shaped);
      participants.push(shaped);
    }
    return { id: String(deal.id), name: text(deal.name), owner: text(deal.owner),
      operating_state: text(deal.operating_state), participants };
  });
}

/**
 * Read the exact context for these agenda deals, in batches the verb accepts.
 * Throws with a sentence a partner can act on; never returns a partial index.
 */
export async function readCallContextIndex(client, agenda) {
  if (!client?.getCallContext) throw new Error('The exact call-context index is not available for this account.');
  if (!agenda.length) throw new Error('This weekly agenda has no active work records. Open Deals (the team pipeline) and try again.');
  const allowed = new Set(agenda.map((deal) => deal.id));
  const ids = [...allowed];
  const exact = [];
  for (let start = 0; start < ids.length; start += CALL_CONTEXT_BATCH) {
    const answer = await client.getCallContext({ deal_ids: ids.slice(start, start + CALL_CONTEXT_BATCH) });
    if (!Array.isArray(answer?.deals)) throw new Error('The call-context index returned an invalid response.');
    exact.push(...answer.deals);
  }
  const active = exact.filter((deal) => allowed.has(deal.id) && deal.operating_state === 'active');
  if (!active.length) throw new Error('The call-context index returned no active agenda work.');
  for (const deal of active) {
    if (!deal.id || !deal.name || !Array.isArray(deal.participants))
      throw new Error('The call-context index is missing exact deal or participant metadata.');
  }
  return shapeCallContextDeals(active);
}

function elapsedTime(startedAt, now) {
  if (!startedAt) return '0:00';
  const seconds = Math.max(0, Math.floor((now() - Date.parse(startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function reportText(value) {
  return String(value || '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, 'unmatched record')
    .replace(/\bP-\d+\b/giu, 'unmatched participant');
}

export function postCallItemStatus(item) {
  return item.candidate_status || item.status || (item.candidate_id ? 'pending' : 'needs_review');
}

const idlePostCall = () => ({ status: 'idle', session: null, weekly: false, report: null, error: null,
  contextReady: false, contextAttempted: false, draftErrors: new Map() });

/**
 * @param {Object} deps
 * @param {{querySelector:Function}} deps.root the page (document in the browser)
 * @param {() => Object} deps.client the current DealRoomClient
 * @param {Object} deps.postCallClient createPostCallClient(...)
 * @param {Function} [deps.fetchImpl] loopback fetch
 * @param {() => Object[]} deps.agendaDeals the active agenda the weekly call covers
 * @param {() => {workspace_kind:string, account_client_id?:string}} deps.scope
 * @param {(id:string) => string|undefined} [deps.dealName]
 * @param {(value:string) => string} [deps.dateLabel]
 * @param {(message:string) => void} [deps.toast]
 * @param {() => Promise<void>} [deps.startAgenda] opens the weekly agenda
 * @param {() => Promise<void>} [deps.onConfirmed] reload after a confirmed item
 */
export function createCallMode(deps) {
  const root = deps.root;
  const $ = (selector) => root.querySelector(selector);
  const fetchImpl = deps.fetchImpl || ((...args) => fetch(...args));
  const now = deps.now || (() => Date.now());
  const toast = deps.toast || (() => {});
  const dealName = deps.dealName || (() => undefined);
  const dateLabel = deps.dateLabel || ((value) => String(value));
  const timers = { setInterval: deps.setInterval || ((...a) => setInterval(...a)),
    clearInterval: deps.clearInterval || ((h) => clearInterval(h)) };
  const state = { callMode: { state: 'idle' }, postCall: idlePostCall(), pollTimer: null,
    tickTimer: null, contextInFlight: null };

  const callModeActive = (snapshot = state.callMode) => snapshot?.state === 'recording';
  const postCallDealName = (item) => item.deal_name || dealName(item.deal_id) || 'Work record';

  function showPermission() {
    const notice = $('#callModePermission');
    if (!notice) return;
    notice.textContent = 'Chrome needs one-time Local Network Access permission to reach Quill on this Mac. Allow the prompt, then retry here. The standalone controller remains available if the local bridge itself needs checking.';
    notice.hidden = false;
  }

  async function api(path, body = null) {
    const options = body ? {
      method: 'POST', headers: { 'content-type': 'application/json', ...CALL_MODE_HEADER },
      body: JSON.stringify(body), targetAddressSpace: 'loopback',
    } : { method: 'GET', targetAddressSpace: 'loopback' };
    let response;
    try {
      response = await fetchImpl(`${CALL_MODE_URL}/api/${path}`, options);
    } catch {
      showPermission();
      throw new Error('Call Mode could not reach Quill locally.');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Call Mode could not complete that action.');
    return payload;
  }

  function render() {
    const snapshot = state.callMode || { state: 'idle' };
    const recording = callModeActive(snapshot);
    const processing = ['transcribing', 'ready_to_extract', 'filed'].includes(snapshot.state);
    const stage = $('#callModeStage');
    if (!stage) return;
    stage.classList.toggle('recording', recording);
    stage.classList.toggle('processing', processing);
    $('#callModeStarts').hidden = recording || processing;
    $('#callModeConsentRow').hidden = recording || processing;
    $('#callModeStop').hidden = !recording;
    $('#callModeTimer').textContent = recording ? elapsedTime(snapshot.started_at, now) : ({
      idle: 'Ready', transcribing: 'Processing', ready_to_extract: 'Transcript ready', filed: 'Summary saved', state_unknown: 'Check Quill',
    }[snapshot.state] || 'Ready');
    $('#callModeState').textContent = recording ? 'Recording live' : ({
      transcribing: 'Quill is processing this call', ready_to_extract: 'Transcript ready for extraction',
      filed: 'Call summary saved', state_unknown: 'Recorder state needs attention',
    }[snapshot.state] || 'Ready to record');
    $('#callModeDetail').textContent = recording ? 'Quill is recording separate local and other-side audio tracks.'
      : processing ? 'The recording has stopped. Quill is preparing the local transcript for the review pipeline.'
        : 'Record the weekly Joe and Dell deal call, or another call. Quill keeps the local and other-side tracks separate.';
    const labels = snapshot.speaker_labels || {};
    const speakers = $('#callModeSpeakers');
    speakers.hidden = !labels.mic;
    speakers.textContent = labels.mic ? `${labels.mic} on microphone · ${labels.system || 'Other participant'} on system audio` : '';
    const toolbarButton = $('#callModeButton');
    if (toolbarButton) {
      toolbarButton.classList.toggle('recording', recording);
      toolbarButton.innerHTML = recording
        ? `<span aria-hidden="true">●</span> ${elapsedTime(snapshot.started_at, now)}`
        : '<span aria-hidden="true">✦</span> Call Mode';
      toolbarButton.setAttribute('aria-label', recording ? `Call Mode recording ${elapsedTime(snapshot.started_at, now)}` : 'Open Call Mode');
    }
    renderPostCall();
  }

  // ------------------------------------------------------------ review pack

  function taskCard(item, owner) {
    const status = postCallItemStatus(item);
    const pending = status === 'pending';
    const text = item.action || item.title || item.text || item.summary || 'Action needs review';
    return `<article class="post-call-card" data-post-call-item="${esc(item.candidate_id || '')}">
    <div class="post-call-card-head"><b>${esc(postCallDealName(item))}</b><span class="post-call-badge ${esc(status)}">${esc(status.replaceAll('_',' '))}</span></div>
    <p>${esc(reportText(text))}</p>${item.due_on ? `<small>Due ${esc(dateLabel(item.due_on))}</small>` : ''}
    ${pending ? `<div class="post-call-card-actions"><button type="button" class="primary" data-post-call-confirm="${esc(item.candidate_id)}" data-candidate-resolver="post_call">Confirm ${esc(owner)} task</button><button type="button" class="secondary" data-post-call-skip="${esc(item.candidate_id)}" data-candidate-resolver="post_call">Skip</button></div>` : ''}
  </article>`;
  }

  function dealUpdateCard(item) {
    const status = postCallItemStatus(item);
    const pending = status === 'pending';
    const summary = item.update || item.summary || item.text || item.action || 'Deal update needs review';
    const resolver = ['assigned_action','email_draft'].includes(item.candidate_kind || item.kind) || item.candidate_table === 'capture_post_call_candidate' ? 'post_call' : 'legacy';
    return `<article class="post-call-card" data-post-call-item="${esc(item.candidate_id || '')}">
    <div class="post-call-card-head"><b>${esc(postCallDealName(item))}</b><span class="post-call-badge ${esc(status)}">${esc(status.replaceAll('_',' '))}</span></div>
    <p>${esc(reportText(summary))}</p>
    ${pending ? `<div class="post-call-card-actions"><button type="button" class="primary" data-post-call-confirm="${esc(item.candidate_id)}" data-candidate-resolver="${resolver}">Confirm update</button><button type="button" class="secondary" data-post-call-skip="${esc(item.candidate_id)}" data-candidate-resolver="${resolver}">Skip</button></div>` : ''}
  </article>`;
  }

  function questionCard(item) {
    const question = typeof item === 'string' ? item : (item.question || item.text || item.summary || 'Needs review');
    const options = Array.isArray(item?.options) ? item.options : [];
    return `<article class="post-call-card question"><p>${esc(reportText(question))}</p>${options.length ? `<div class="post-call-options" aria-label="Possible answers">${options.map((option) => `<span>${esc(reportText(typeof option === 'string' ? option : option.label || option.text))}</span>`).join('')}</div>` : ''}</article>`;
  }

  function draftCard(draft) {
    const status = draft.status || draft.candidate_status || 'pending';
    const created = ['created','already_created','draft_created'].includes(status) || draft.idempotent === true;
    const skipped = status === 'skipped';
    const awaitingReceipt = !draft.candidate_id && !created;
    const busyError = state.postCall.draftErrors.get(draft.draft_id);
    const recipient = draft.recipient_name || 'Recipient needs review';
    return `<article class="post-call-card vendor-draft" data-post-call-draft-card="${esc(draft.draft_id)}">
    <div class="post-call-card-head"><div><b>${esc(postCallDealName(draft))}</b><small>${esc(recipient)}${draft.recipient_email ? ` · ${esc(draft.recipient_email)}` : ''}</small></div><span class="post-call-badge ${esc(status)}">${esc(status.replaceAll('_',' '))}</span></div>
    <h5>${esc(reportText(draft.subject || 'Deal update'))}</h5><p class="draft-body">${esc(reportText(draft.body || ''))}</p>
    ${busyError ? `<p class="post-call-inline-error" role="alert">${esc(busyError)} You can retry safely.</p>` : ''}
    <div class="post-call-card-actions"><button type="button" class="primary create-draft" data-create-outlook-draft="${esc(draft.draft_id)}" data-draft-candidate="${esc(draft.candidate_id || '')}" data-draft-status="${esc(status)}" data-content-hash="${esc(draft.content_hash || '')}"${created || skipped || awaitingReceipt ? ' disabled' : ''}>${created ? 'Created in Outlook' : skipped ? 'Skipped' : awaitingReceipt ? 'Preparing draft…' : busyError ? 'Retry Outlook draft' : 'Approve and create Outlook draft'}</button>${status === 'pending' && draft.candidate_id ? `<button type="button" class="secondary" data-post-call-skip="${esc(draft.candidate_id)}" data-candidate-resolver="post_call">Skip</button>` : ''}</div>
    <small class="human-gate">Creates a draft only. Joe or Dell reviews and sends it in Outlook.</small>
  </article>`;
  }

  function reportSection(title, items, renderItem, empty) {
    return `<section class="post-call-group"><h4>${esc(title)}</h4>${items.length ? `<div class="post-call-cards">${items.map(renderItem).join('')}</div>` : `<p class="post-call-empty">${esc(empty)}</p>`}</section>`;
  }

  function renderPostCall() {
    const panel = $('#postCallPanel');
    if (!panel) return;
    const post = state.postCall;
    panel.hidden = !post.session && post.status === 'idle';
    if (panel.hidden) return;
    const labels = {
      context_loading: 'Preparing the weekly deal context…',
      context_ready: 'Deal context ready. Recording continues locally.',
      awaiting_context: 'Preparing the weekly deal context…',
      waiting_for_transcript: 'Recording stopped. Quill is transcribing locally…',
      distilling: 'Quill is distilling the weekly updates and next actions…',
      review_ready: 'Review pack ready. Nothing is saved until Joe or Dell approves each item.',
      filed: 'Post-call report filed. Outlook drafts still require a person to send them.',
      failed: 'The post-call report needs attention.',
    };
    $('#postCallStatus').innerHTML = `<span class="post-call-spinner" aria-hidden="true"></span><b>${esc(labels[post.status] || 'Post-call workflow ready.')}</b>${post.error ? `<small role="alert">${esc(post.error)}</small><button type="button" class="secondary" data-retry-call-context>Retry deal context</button>` : ''}`;
    $('#postCallStatus').classList.toggle('failed', Boolean(post.error) || post.status === 'failed');
    const envelope = post.report || {};
    const core = envelope.report || {};
    const joe = Array.isArray(envelope.joe_tasks) ? envelope.joe_tasks : [];
    const dell = Array.isArray(envelope.dell_tasks) ? envelope.dell_tasks : [];
    const updates = Array.isArray(envelope.deal_updates) ? envelope.deal_updates : (Array.isArray(envelope.deals) ? envelope.deals : []);
    const questions = [...(Array.isArray(envelope.review_questions) ? envelope.review_questions : []),
      ...(Array.isArray(core.open_questions) ? core.open_questions : []),
      ...(Array.isArray(envelope.questions) ? envelope.questions : [])];
    const drafts = Array.isArray(envelope.draft_proposals) ? envelope.draft_proposals : (Array.isArray(envelope.drafts) ? envelope.drafts : []);
    const hasReport = post.status === 'review_ready' || post.status === 'filed' || joe.length || dell.length || updates.length || questions.length || drafts.length;
    $('#postCallReport').innerHTML = hasReport ? `${core.summary ? `<p class="post-call-summary">${esc(reportText(core.summary))}</p>` : ''}
    ${reportSection('Deal by deal', updates, dealUpdateCard, 'No deal updates were identified.')}
    ${reportSection('Joe this week', joe, (item) => taskCard(item, 'Joe'), 'No Joe tasks were identified.')}
    ${reportSection('Dell this week', dell, (item) => taskCard(item, 'Dell'), 'No Dell tasks were identified.')}
    ${reportSection('Questions to resolve', questions, questionCard, 'No unresolved questions.')}
    ${reportSection('What clients and vendors need to know · email drafts', drafts, draftCard, 'No client or vendor emails are needed from this call.')}` : '';
  }

  // --------------------------------------------------------- context index

  async function publishWeeklyCallContext(session) {
    if (!session) throw new Error('Quill did not return a recording session.');
    if (state.contextInFlight) return state.contextInFlight;
    const run = (async () => {
      state.postCall = { ...state.postCall, status: 'context_loading', session, weekly: true,
        error: null, contextReady: false, contextAttempted: true };
      renderPostCall();
      const deals = await readCallContextIndex(deps.client(), deps.agendaDeals());
      const scope = deps.scope();
      await deps.postCallClient.publishCallContext({ session, workspace_kind: scope.workspace_kind,
        ...(scope.account_client_id ? { account_client_id: scope.account_client_id } : {}),
        generated_at: new Date(now()).toISOString(), deals });
      state.postCall = { ...state.postCall, status: 'context_ready', contextReady: true, error: null };
      renderPostCall();
    })();
    state.contextInFlight = run;
    try { await run; } finally { state.contextInFlight = null; }
  }

  async function publishOrRecord(session) {
    try {
      await publishWeeklyCallContext(session);
      return true;
    } catch (error) {
      // Stop polling so the reason stays on screen: the next poll would read
      // awaiting_context again and quietly replace it. Retry resumes.
      stopPolling();
      state.postCall = { ...state.postCall, status: 'failed', session, weekly: true, error: error.message };
      renderPostCall();
      return false;
    }
  }

  // ----------------------------------------------------------- report poll

  function stopPolling() {
    if (state.pollTimer) timers.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  async function refreshPostCall({ quiet = false } = {}) {
    const session = state.postCall.session;
    if (!session) return;
    try {
      const payload = await deps.postCallClient.getStatus(session);
      const rawStatus = (typeof payload.status === 'object' ? payload.status.state : payload.status) || payload.state || 'waiting_for_transcript';
      const status = ({ ready_review: 'review_ready', blocked: 'failed' })[rawStatus] || rawStatus;
      const reason = typeof payload.status === 'object' && rawStatus === 'blocked' ? payload.status.reason : null;
      state.postCall = { ...state.postCall, status, report: payload.report || null,
        error: reason ? `Local processing stopped: ${reason}` : null };
      if (['review_ready', 'filed', 'failed'].includes(status)) stopPolling();
      renderPostCall();
      // The stall this closes: a weekly recording whose companion never got
      // the context index. Supply it now, once per session unless a partner
      // presses Retry; the companion processes the transcript it already has.
      if (status === 'awaiting_context' && state.postCall.weekly && !state.postCall.contextAttempted) {
        await publishOrRecord(session);
      }
    } catch (error) {
      state.postCall = { ...state.postCall, error: error.message };
      renderPostCall();
      if (!quiet) toast(error.message);
    }
  }

  function startPolling(session, { weekly = false } = {}) {
    stopPolling();
    state.postCall = { ...state.postCall, session, weekly: weekly || state.postCall.weekly };
    refreshPostCall({ quiet: true });
    state.pollTimer = timers.setInterval(() => refreshPostCall({ quiet: true }), 1600);
  }

  // ------------------------------------------------------ per-item approval

  async function resolveCandidate(candidateId, accept, button) {
    if (!candidateId) return;
    button.disabled = true;
    try {
      const client = deps.client();
      if (button.dataset.candidateResolver === 'post_call') {
        await client.resolvePostCallCandidate({ candidate_id: candidateId, accept, idempotency_key: uuidv4() });
      } else {
        await client.resolveConfirm({ proposal_id: candidateId, accept, idempotency_key: uuidv4() });
      }
      await deps.postCallClient.syncStatus(state.postCall.session);
      toast(accept ? 'Post-call item confirmed.' : 'Post-call item skipped.');
      await refreshPostCall();
      if (accept && deps.onConfirmed) await deps.onConfirmed();
    } catch (error) {
      toast(error.message);
    } finally { button.disabled = false; }
  }

  async function createDraft(button) {
    const draftId = button.dataset.createOutlookDraft;
    const candidateId = button.dataset.draftCandidate;
    const status = button.dataset.draftStatus;
    button.disabled = true;
    state.postCall.draftErrors.delete(draftId);
    try {
      // Pressing this button IS the partner's approval of this one draft: the
      // candidate is confirmed first, then the companion creates an Outlook
      // draft. Nothing is ever sent.
      if (!['confirmed', 'created', 'already_created', 'draft_created'].includes(status)) {
        if (!candidateId) throw new Error('This email draft still needs a matched metadata candidate.');
        await deps.client().resolvePostCallCandidate({ candidate_id: candidateId, accept: true, idempotency_key: uuidv4() });
      }
      await deps.postCallClient.syncStatus(state.postCall.session);
      const created = await deps.postCallClient.createOutlookDraft(
        state.postCall.session, draftId, button.dataset.contentHash,
      );
      await refreshPostCall();
      const report = state.postCall.report;
      for (const draft of report?.draft_proposals || report?.drafts || []) {
        if (draft.draft_id === draftId) {
          draft.status = created.idempotent ? 'already_created' : (created.status || 'created');
          draft.idempotent = Boolean(created.idempotent);
        }
      }
      renderPostCall();
      toast('Outlook draft created. Nothing was sent.');
    } catch (error) {
      state.postCall.draftErrors.set(draftId, error.message);
      renderPostCall();
    } finally { button.disabled = false; }
  }

  // ------------------------------------------------------- recorder control

  async function refresh({ quiet = false } = {}) {
    try {
      state.callMode = await api('state');
      const notice = $('#callModePermission');
      if (notice) notice.hidden = true;
      render();
      const snapshot = state.callMode;
      if (snapshot.mode === 'weekly_deal_call' && snapshot.session) {
        if (callModeActive(snapshot) && state.postCall.session !== snapshot.session) {
          state.postCall = { ...idlePostCall(), session: snapshot.session, weekly: true };
          await publishOrRecord(snapshot.session);
        } else if (!callModeActive(snapshot) && state.postCall.session !== snapshot.session) {
          state.postCall = { ...idlePostCall(), session: snapshot.session, weekly: true };
          startPolling(snapshot.session, { weekly: true });
        }
      }
    } catch (error) {
      if (!quiet) toast(error.message);
    }
  }

  function startTicker() {
    if (state.tickTimer) return;
    state.tickTimer = timers.setInterval(() => { if (callModeActive()) render(); }, 250);
  }

  async function open() {
    const dialog = $('#callModeDialog');
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    render();
    startTicker();
    await refresh({ quiet: true });
  }

  function close() {
    const dialog = $('#callModeDialog');
    if (dialog?.open) dialog.close();
  }

  async function start(mode) {
    if (!CALL_MODES.includes(mode)) return false;
    const consent = $('#callModeConsent');
    if (!consent?.checked) {
      toast('Confirm that everyone has been told before recording.');
      consent?.focus?.();
      return false;
    }
    const button = root.querySelector(`[data-call-mode-start="${mode}"]`);
    if (button) button.disabled = true;
    try {
      state.callMode = await api('start', { mode, consent_confirmed: true });
      stopPolling();
      state.postCall = idlePostCall();
      render();
      startTicker();
      if (mode === 'weekly_deal_call') {
        const ok = await publishOrRecord(state.callMode.session || null);
        if (!ok) toast(`Recording started, but the weekly deal context needs attention: ${state.postCall.error}`);
        try {
          if (deps.startAgenda) await deps.startAgenda();
          toast('Weekly deal call is recording. The agenda is open.');
        } catch (error) {
          console.error('Could not start the weekly agenda', error);
          toast('Weekly deal call is recording. The agenda could not open.');
        }
      } else {
        toast('Call is recording.');
      }
      return true;
    } catch (error) {
      toast(error.message);
      return false;
    } finally {
      if (button) button.disabled = false;
      // A recording needs a fresh confirmation every time.
      if (consent) consent.checked = false;
    }
  }

  async function stop() {
    const button = $('#callModeStop');
    if (button) button.disabled = true;
    try {
      state.callMode = await api('stop', {});
      render();
      const session = state.callMode.session || state.postCall.session;
      const weekly = state.callMode.mode === 'weekly_deal_call' || state.postCall.weekly;
      if (session && (weekly || state.postCall.contextReady)) {
        // If the index never reached the companion, the first poll that sees
        // awaiting_context gets one more automatic attempt.
        state.postCall = { ...state.postCall, status: 'waiting_for_transcript', session, weekly, error: null,
          contextAttempted: state.postCall.contextReady };
        renderPostCall();
        startPolling(session, { weekly });
      }
      toast('Recording stopped. Quill is processing the call.');
    } catch (error) {
      toast(error.message);
    } finally { if (button) button.disabled = false; }
  }

  /**
   * One delegated click handler for everything the dialog draws. Returns true
   * when it handled the click. Only an element carrying one of these data
   * attributes (and so only a partner pressing it) can reach a write.
   */
  async function handleClick(target) {
    const hit = (selector) => target?.closest?.(selector) || null;
    const confirm = hit('[data-post-call-confirm]');
    if (confirm) { await resolveCandidate(confirm.dataset.postCallConfirm, true, confirm); return true; }
    const skip = hit('[data-post-call-skip]');
    if (skip) { await resolveCandidate(skip.dataset.postCallSkip, false, skip); return true; }
    const draft = hit('[data-create-outlook-draft]');
    if (draft) { await createDraft(draft); return true; }
    const retry = hit('[data-retry-call-context]');
    if (retry) {
      retry.disabled = true;
      try {
        const session = state.postCall.session || state.callMode.session;
        if (await publishOrRecord(session) && !callModeActive()) startPolling(session, { weekly: true });
      } finally { retry.disabled = false; }
      return true;
    }
    const startButton = hit('[data-call-mode-start]');
    if (startButton) { await start(startButton.dataset.callModeStart); return true; }
    if (hit('#callModeClose')) { close(); return true; }
    return false;
  }

  return {
    state, open, close, start, stop, refresh, refreshPostCall, render, handleClick,
    startPolling, stopPolling, publishWeeklyCallContext,
    dispose() { stopPolling(); if (state.tickTimer) timers.clearInterval(state.tickTimer); state.tickTimer = null; },
  };
}
