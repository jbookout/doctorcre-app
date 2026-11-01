import { createPageBudget } from './read-budget.mjs';
import { mountLocalTicker } from './visibility-poll.mjs';
import { createRetainedCommands } from './retained-commands.mjs';
import { callChangeText, dayLabel } from './call-change-words.js';
import { requestCompanion, CALL_MODE_URL, CALL_MODE_HEADER, CALL_MODE_STATES } from './post-call-client.js';
import { escapeText as esc, compareInstants } from './change-receipts.mjs';
import { mountVisibilityPoll } from './visibility-poll.mjs';

export { CALL_MODE_URL, CALL_MODE_HEADER };
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
  if (!agenda.length) throw new Error('This weekly agenda has no active deals. Open Deals (the team pipeline) and try again.');
  const allowed = new Set(agenda.map((deal) => deal.id));
  const ids = [...allowed];
  const exact = [];
  const takePage = createPageBudget();
  // eslint-disable-next-line no-restricted-syntax -- Call context batches consume takePage before each batch; a max of 100 batches per explicit context load.
  for (let start = 0; start < ids.length; start += CALL_CONTEXT_BATCH) {
    takePage();
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
  contextReady: false, contextAttempted: false, draftErrors: new Map(), questionEdits: new Map() });

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
  const candidateCommands = createRetainedCommands({ scope: () => deps.client()?.selfActor || null });
  const root = deps.root;
  const $ = (selector) => root.querySelector(selector);
  const fetchImpl = deps.fetchImpl || ((...args) => fetch(...args));
  const now = deps.now || (() => Date.now());
  const toast = deps.toast || (() => {});
  const dealName = deps.dealName || (() => undefined);
  const dateLabel = deps.dateLabel || dayLabel;
  // eslint-disable-next-line no-restricted-syntax -- Timer adapter used only by mountLocalTicker; ceil(30 minutes / intervalMs) ticks. Local repaint only; callback error stops the clock without retry The owning mountLocalTicker stops hidden, after 30-minute idle, or on disposal
  const timers = { setInterval: deps.setInterval || ((...a) => setInterval(...a)),
    clearInterval: deps.clearInterval || ((h) => clearInterval(h)),
    // eslint-disable-next-line no-restricted-syntax -- Post-call poll adapter is limited by mountVisibilityPoll to a max of 20 attempts, with hidden/idle stops and failure backoff.
    setTimeout: deps.setTimeout || ((...a) => setTimeout(...a)),
    clearTimeout: deps.clearTimeout || ((h) => clearTimeout(h)) };
  const state = { callMode: { state: 'idle' }, postCall: idlePostCall(), pollTimer: null,
    tickTimer: null, contextInFlight: null, eligibility: 'unknown', eligibilityInFlight: null };

  // Only a read of the companion can establish eligibility. Abort the request
  // and bound the whole response (including JSON) even if a transport hangs.
  function checkEligibility() {
    if (state.eligibilityInFlight) return state.eligibilityInFlight;
    state.eligibility = 'checking';
    render();
    const probe = (async () => {
      try {
        const snapshot = await api('state',null,deps.eligibilityTimeoutMs ?? 1200);
        state.callMode = snapshot;
        state.eligibility = 'available';
        return true;
      } catch {
        state.eligibility = 'unavailable';
        stopPolling();
        if (state.tickTimer) state.tickTimer.dispose();
        state.tickTimer = null;
        return false;
      } finally {
        state.eligibilityInFlight = null;
        render();
      }
    })();
    state.eligibilityInFlight = probe;
    return probe;
  }

  const callModeActive = (snapshot = state.callMode) => snapshot?.state === 'recording';
  const postCallDealName = (item) => item.deal_name || dealName(item.deal_id) || 'Deal';

  async function api(path, body = null, timeoutMs = deps.requestTimeoutMs) {
    const options = body ? {
      method: 'POST', headers: { 'content-type': 'application/json', ...CALL_MODE_HEADER },
      body: JSON.stringify(body), targetAddressSpace: 'loopback',
    } : { method: 'GET', targetAddressSpace: 'loopback' };
    const payload = await requestCompanion(`${CALL_MODE_URL}/api/${path}`,options,{fetchImpl,timeoutMs});
    if (!CALL_MODE_STATES.includes(payload.state)) {
      throw Object.assign(new Error('Local Call Mode response unavailable. Check local state before retrying.'),{outcomeUnknown:Boolean(body)});
    }
    return payload;
  }
  function showFailure(error) {
    const notice = $('#callModePermission');
    if (notice) { notice.textContent = error.message; notice.hidden = false; }
    toast(error.message);
  }
  async function reconcileRecorder() {
    if (!state.recorderUncertain) return false;
    const snapshot = await api('state');
    if (snapshot.state === 'state_unknown') throw new Error('Recorder outcome unknown. Check call recorder status before another action.');
    state.recorderUncertain = false;
    const notice = $('#callModePermission'); if (notice) notice.hidden = true;
    await refresh({snapshot});
    toast('Local recorder state refreshed. Review it before another recording action.');
    return true;
  }

  function render() {
    const eligible = state.eligibility === 'available';
    const availability = $('#callModeAvailability');
    if (availability) {
      availability.hidden = eligible;
      availability.textContent = state.eligibility === 'checking' || state.eligibility === 'unknown'
        ? 'Checking the call recorder…' : 'Call recorder offline';
    }
    for (const id of ['callModeButton', 'callModeStandalone']) {
      const element = $(`#${id}`);
      if (element) element.hidden = !eligible;
    }
    const recheck = $('#callModeRetry');
    if (recheck) {
      recheck.hidden = eligible || state.eligibility === 'unknown';
      recheck.disabled = state.eligibility === 'checking';
    }
    if (!eligible) {
      for (const id of ['callModeStarts', 'callModeConsentRow', 'callModeStop', 'callModeSpeakers', 'postCallPanel', 'callModePermission']) {
        const element = $(`#${id}`);
        if (element) element.hidden = true;
      }
      if ($('#callModeState')) $('#callModeState').textContent = 'Call recorder offline';
      if ($('#callModeTimer')) $('#callModeTimer').textContent = '';
      if ($('#callModeDetail')) $('#callModeDetail').textContent = '';
      return;
    }
    const snapshot = state.callMode || { state: 'idle' };
    const recording = callModeActive(snapshot);
    const processing = ['transcribing', 'ready_to_extract', 'filed'].includes(snapshot.state);
    const stage = $('#callModeStage');
    if (!stage) return;
    stage.classList.toggle('recording', recording);
    stage.classList.toggle('processing', processing);
    // A finished call (transcript ready or filed) must not block the next one.
    const busy = recording || snapshot.state === 'transcribing';
    $('#callModeStarts').hidden = busy;
    $('#callModeConsentRow').hidden = busy;
    $('#callModeStop').hidden = !recording;
    $('#callModeTimer').textContent = recording ? elapsedTime(snapshot.started_at, now) : ({
      idle: 'Ready', transcribing: 'Processing', ready_to_extract: 'Transcript ready', awaiting_context: 'Processing',
      ready_review: 'Ready for review', blocked: 'Needs attention', needs_attention: 'Needs attention', filed: 'Summary saved', state_unknown: 'Check call recorder status',
    }[snapshot.state] || 'Ready');
    $('#callModeState').textContent = recording ? 'Recording live' : ({
      transcribing: 'Processing this call', ready_to_extract: 'Transcript ready for extraction',
      awaiting_context: 'Processing this call', ready_review: 'Call summary ready for review',
      blocked: 'This call needs attention', needs_attention: 'This call needs attention',
      filed: 'Call summary saved', state_unknown: 'Recorder state needs attention',
    }[snapshot.state] || 'Ready to record');
    const labels = snapshot.speaker_labels || {};
    const speakers = $('#callModeSpeakers');
    speakers.hidden = !labels.mic;
    speakers.textContent = labels.mic ? `${labels.mic} on microphone · ${labels.system || 'Other participant'} on system audio` : '';
    const toolbarButton = $('#callModeButton');
    if (toolbarButton) {
      toolbarButton.classList.toggle('recording', recording);
      toolbarButton.innerHTML = recording
        ? `<span aria-hidden="true">●</span> ${elapsedTime(snapshot.started_at, now)}`
        : '<span aria-hidden="true">☎</span>';
      toolbarButton.setAttribute('aria-label', recording ? `Call Mode recording ${elapsedTime(snapshot.started_at, now)}` : 'Call mode');
    }
    renderPostCall();
  }

  // ------------------------------------------------------------ review pack

  /**
   * The visible signal from post_call_jev.py's RIGHT DEAL / RIGHT SPEAKER /
   * RIGHT DETAILS checks (decision 008d682a): a flagged item shows its
   * plain-English reasons, and an item the checks never reached shows a neutral
   * note. Never hides or removes the item either way -- Joe and Dell still
   * approve or reject every candidate by hand.
   */
  function checksNote(item) {
    const checks = item?.checks;
    if (!checks) return '';
    if (checks.unavailable) {
      return `<p class="post-call-checks post-call-checks-unavailable">Automatic checks did not run for this item.</p>`;
    }
    if (checks.flagged) {
      const reasons = Array.isArray(checks.reasons) ? checks.reasons : [];
      return `<div class="post-call-checks post-call-checks-flagged" role="alert"><b>⚠ Flagged for review</b>${reasons.length ? `<ul>${reasons.map((reason) => `<li>${esc(reportText(reason))}</li>`).join('')}</ul>` : ''}</div>`;
    }
    return '';
  }

  function taskCard(item, owner) {
    const status = postCallItemStatus(item);
    const pending = status === 'pending';
    const text = item.action || item.title || item.text || item.summary || 'Action needs review';
    return `<article class="post-call-card" data-post-call-item="${esc(item.candidate_id || '')}">
    <div class="post-call-card-head"><b>${esc(postCallDealName(item))}</b><span class="post-call-badge ${esc(status)}">${esc(status.replaceAll('_',' '))}</span></div>
    <p>${esc(reportText(text))}</p>${item.due_on ? `<small>Due ${esc(dateLabel(item.due_on))}</small>` : ''}
    ${checksNote(item)}
    ${pending ? `<div class="post-call-card-actions"><button type="button" class="primary" data-post-call-confirm="${esc(item.candidate_id)}" data-candidate-resolver="post_call">Confirm ${esc(owner)} task</button><button type="button" class="secondary" data-post-call-skip="${esc(item.candidate_id)}" data-candidate-resolver="post_call">Skip</button></div>` : ''}
  </article>`;
  }

  // The companion appends each change to the summary as raw lines
  // ("Phase moved to: due_diligence (started 2026-10-20)", "Next date:
  // 2026-11-03"; carr-system post_call.report_for_deal_room). The card shows
  // those changes formatted in their own sections, so drop the raw copies.
  const RAW_CHANGE_LINE = /^(Phase moved to|Move phase to|Next step set to|Replace next step with|Next date):/u;
  function cardSummary(text) {
    return String(text).split('\n').filter(line => !RAW_CHANGE_LINE.test(line.trim())).join('\n').trim();
  }

  function dealUpdateCard(item) {
    const status = postCallItemStatus(item);
    const pending = status === 'pending';
    const summary = cardSummary(item.update || item.summary || item.text || item.action || '') || 'Deal update needs review';
    const resolver = ['assigned_action','email_draft'].includes(item.candidate_kind || item.kind) || item.candidate_table === 'capture_post_call_candidate' ? 'post_call' : 'legacy';
    const step = item.next_step?.applied_automatically ? null : item.next_step;
    const stepStatus = step ? postCallItemStatus(step) : null;
    const phase = item.phase_move?.applied_automatically ? null : item.phase_move;
    const phaseStatus = phase ? postCallItemStatus(phase) : null;
    return `<article class="post-call-card" data-post-call-item="${esc(item.candidate_id || '')}">
    <div class="post-call-card-head"><b>${esc(postCallDealName(item))}</b><span class="post-call-badge ${esc(status)}">${esc(status.replaceAll('_',' '))}</span></div>
    <p>${esc(reportText(summary))}</p>
    ${checksNote(item)}
    ${pending ? `<div class="post-call-card-actions"><button type="button" class="primary" data-post-call-confirm="${esc(item.candidate_id)}" data-candidate-resolver="${resolver}">Confirm update</button><button type="button" class="secondary" data-post-call-skip="${esc(item.candidate_id)}" data-candidate-resolver="${resolver}">Skip</button></div>` : ''}
    ${phase ? `<section aria-label="Proposed phase">
      <div class="post-call-card-head"><b>Proposed phase</b><span class="post-call-badge ${esc(phaseStatus)}">${esc(phaseStatus.replaceAll('_', ' '))}</span></div>
      <p>${esc(callChangeText({ kind: 'phase_move', payload: phase }).replace('Phase moved to', 'Move to'))}</p>
      ${phase.review_reason && phaseStatus === 'pending' ? `<p class="post-call-checks">${esc(reportText(phase.review_reason))}</p>` : ''}
      ${phaseStatus === 'pending' && phase.candidate_id ? `<div class="post-call-card-actions"><button type="button" class="primary" data-post-call-confirm="${esc(phase.candidate_id)}" data-candidate-resolver="legacy">Confirm phase</button><button type="button" class="secondary" data-post-call-skip="${esc(phase.candidate_id)}" data-candidate-resolver="legacy">Skip phase</button></div>` : ''}
    </section>` : ''}
    ${step ? `<section aria-label="Proposed next step">
      <div class="post-call-card-head"><b>Proposed next step</b><span class="post-call-badge ${esc(stepStatus)}">${esc(stepStatus.replaceAll('_', ' '))}</span></div>
      <p>${esc(reportText(step.text))}</p><small>${step.next_date ? `Next date: ${esc(dateLabel(step.next_date))}` : 'No next date. Confirming clears the current date.'}</small>
      ${step.review_reason && stepStatus === 'pending' ? `<p class="post-call-checks">${esc(reportText(step.review_reason))}</p>` : ''}
      ${stepStatus === 'pending' && step.candidate_id ? `<div class="post-call-card-actions"><button type="button" class="primary" data-post-call-confirm="${esc(step.candidate_id)}" data-candidate-resolver="legacy">Confirm next step</button><button type="button" class="secondary" data-post-call-skip="${esc(step.candidate_id)}" data-candidate-resolver="legacy">Skip next step</button></div>` : ''}
    </section>` : ''}
  </article>`;
  }

  function questionCard(item) {
    const question = typeof item === 'string' ? item : (item.question || item.text || item.summary || 'Needs review');
    const options = Array.isArray(item?.options) ? item.options : [];
    const edit = state.postCall.questionEdits.get(item?.id);
    return `<article class="post-call-card question"><p>${esc(reportText(question))}</p>${options.length ? `<div class="post-call-options" aria-label="Possible answers">${options.map((option) => `<span>${esc(reportText(typeof option === 'string' ? option : option.label || option.text))}</span>`).join('')}</div>` : ''}
      ${edit?.error ? `<p class="post-call-inline-error" role="alert">${esc(edit.error)}</p>` : ''}
      ${item?.resolved === true ? `<p><b>Resolved</b> · ${esc(item.resolution || '')}</p>` : item?.id ? `
      <div class="field"><label>Resolution <textarea rows="3" data-question-resolution="${esc(item.id)}"${edit?.busy ? ' disabled' : ''}>${esc(edit?.text || '')}</textarea></label></div>
      <div class="post-call-card-actions"><button type="button" class="primary" data-resolve-question="${esc(item.id)}"${!edit?.text?.trim() || edit?.busy ? ' disabled' : ''}>${edit?.busy ? 'Resolving…' : 'Resolve'}</button></div>
      ` : ''}</article>`;
  }

  function questionInput(event) {
    const field = event.target?.closest?.('[data-question-resolution]');
    if (!field) return;
    const id = field.dataset.questionResolution;
    state.postCall.questionEdits.set(id, { text: field.value });
    field.closest('article').querySelector('[data-resolve-question]').disabled = !field.value.trim();
  }
  root.addEventListener('input', questionInput);

  async function resolveQuestion(button) {
    const id = button.dataset.resolveQuestion;
    const edit = state.postCall.questionEdits.get(id);
    if (!edit?.text?.trim() || edit.busy) return;
    const session = state.postCall.session, generation = state.callGeneration;
    const current = () => state.postCall.session === session && state.callGeneration === generation;
    edit.busy = true;
    edit.error = null;
    state.statusSequence = (state.statusSequence || 0) + 1;
    state.statusInFlight = null;
    renderPostCall();
    try {
      const result = await deps.postCallClient.resolveQuestion(session, id, edit.text.trim());
      if (!current()) return;
      if (!Array.isArray(result.report?.review_questions)) throw new Error('The updated questions could not be read. Refresh the report to check the resolution.');
      state.statusSequence = (state.statusSequence || 0) + 1;
      state.statusInFlight = null;
      state.postCall.report = result.report;
      const status = typeof result.status === 'object' ? result.status.state : result.status;
      state.postCall.status = ({ ready_review: 'review_ready', blocked: 'failed' })[status] || status || state.postCall.status;
      state.postCall.questionEdits.delete(id);
    } catch (error) {
      if (!current()) return;
      if (error.status === 409 && (error.cause?.message === 'already_resolved' || error.cause?.message === 'Call Mode could not verify the post-call review state')) {
        edit.error = 'Already resolved';
        await refreshPostCall();
      } else {
        edit.error = error.status === 404 ? 'This question could not be found. Refresh the report.'
          : error.status === 400 ? 'Enter a resolution before trying again.' : error.status === 409 ? error.cause?.message || error.message : error.message;
      }
    } finally {
      if (current()) { edit.busy = false; renderPostCall(); }
    }
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
    ${checksNote(draft)}
    ${busyError ? `<p class="post-call-inline-error" role="alert">${esc(busyError)} Check the report before retrying.</p>` : ''}
    <div class="post-call-card-actions"><button type="button" class="primary create-draft" data-create-outlook-draft="${esc(draft.draft_id)}" data-draft-candidate="${esc(draft.candidate_id || '')}" data-draft-status="${esc(status)}" data-content-hash="${esc(draft.content_hash || '')}"${created || skipped || awaitingReceipt ? ' disabled' : ''}>${created ? 'Created in Outlook' : skipped ? 'Skipped' : awaitingReceipt ? 'Preparing draft…' : state.uncertainDrafts?.has(draft.draft_id) ? 'Check draft outcome' : busyError ? 'Retry Outlook draft' : 'Approve and create Outlook draft'}</button>${status === 'pending' && draft.candidate_id ? `<button type="button" class="secondary" data-post-call-skip="${esc(draft.candidate_id)}" data-candidate-resolver="post_call">Skip</button>` : ''}</div>
    <small class="human-gate">Creates a draft only. Joe or Dell reviews and sends it in Outlook.</small>
  </article>`;
  }

  function reportSection(title, items, renderItem, empty) {
    return `<section class="post-call-group"><h4>${esc(title)}</h4>${items.length ? `<div class="post-call-cards">${items.map(renderItem).join('')}</div>` : `<p class="post-call-empty">${esc(empty)}</p>`}</section>`;
  }

  // Applied-from-the-call summary (read-call-outcomes) above the report. Its
  // module loads only once a call has candidates to list, so the Deals page
  // does not carry it on every visit.
  let outcomes = null;
  let outcomesLoading = null;
  function retireOutcomes() {
    outcomes?.dispose();
    outcomes = null;
    const node = $('#postCallOutcomes');
    if (node) { node.innerHTML = ''; node.hidden = true; }
  }
  function reportCandidateIds() {
    const updates = state.postCall.report?.deal_updates;
    return (Array.isArray(updates) ? updates : []).flatMap(update => ['next_step', 'phase_move']
      .map(field => update?.[field]?.candidate_id).filter(Boolean));
  }
  async function callOutcomes() {
    const node = $('#postCallOutcomes');
    if (!node || !deps.client()?.readCallOutcomes) return null;
    if (outcomes) return outcomes;
    const generation = state.callGeneration || 0, session = state.postCall.session;
    outcomesLoading ||= import('./call-outcomes.js');
    const { mountCallOutcomes } = await outcomesLoading;
    if (state.postCall.session !== session || (state.callGeneration || 0) !== generation) return null;
    outcomes ||= mountCallOutcomes({ container: node, client: deps.client, toast, filter: reportCandidateIds, listen: false,
      onChange: () => refreshPostCall({ quiet: true }) });
    return outcomes;
  }

  // The companion writes report.automatic only after the call's plainly
  // stated changes have been applied (or refused) through the record layer.
  // Until then nothing is claimed as applied.
  const APPLY_WAIT_MS = 3 * 60 * 1000;
  const automaticSettled = report => !report || Boolean(report.automatic?.finished_at);
  function reviewReadyLabel(post) {
    const automatic = post.report?.automatic;
    if (!automaticSettled(post.report)) {
      return post.applyTimedOut
        ? 'Call processed, but the plainly stated changes have not been confirmed as applied yet. Press ↻ to check again.'
        : 'Call processed. Applying the changes stated plainly…';
    }
    const applied = Number(automatic?.applied) || 0;
    const held = Number(automatic?.kept_for_review) || 0;
    const appliedText = applied ? `${applied} change${applied === 1 ? '' : 's'} applied and listed with Undo` : 'Nothing was applied automatically';
    return `Call processed. ${appliedText}${held ? `; ${held} held change${held === 1 ? ' waits' : 's wait'} for Joe or Dell below` : ''}.`;
  }

  function renderPostCall() {
    if (state.eligibility !== 'available') {
      if ($('#postCallPanel')) $('#postCallPanel').hidden = true;
      return;
    }
    const panel = $('#postCallPanel');
    if (!panel) return;
    const post = state.postCall;
    panel.hidden = !post.session && post.status === 'idle';
    if (panel.hidden) return;
    const labels = {
      context_loading: 'Preparing the weekly deal context…',
      context_ready: 'Deal context ready. Recording continues locally.',
      awaiting_context: 'Preparing the weekly deal context…',
      waiting_for_transcript: 'Recording stopped. Transcribing on this Mac…',
      distilling: 'Pulling out the weekly updates and next actions…',
      review_ready: reviewReadyLabel(post),
      filed: 'Post-call report filed. Outlook drafts still require a person to send them.',
      failed: 'The post-call report needs attention.',
    };
    $('#postCallStatus').innerHTML = `<span class="post-call-spinner" aria-hidden="true"></span><b>${esc(labels[post.status] || 'Post-call workflow ready.')}</b>${post.error ? `<small role="alert">${esc(post.error)}</small>${post.errorAction === 'report' ? '<button type="button" class="secondary" data-refresh-post-call>Retry report</button>' : '<button type="button" class="secondary" data-retry-call-context>Retry deal context</button>'}` : ''}`;
    $('#postCallStatus').classList.toggle('failed', Boolean(post.error) || post.status === 'failed');
    const envelope = post.report || {};
    const core = envelope.report || {};
    const joe = Array.isArray(envelope.joe_tasks) ? envelope.joe_tasks : [];
    const dell = Array.isArray(envelope.dell_tasks) ? envelope.dell_tasks : [];
    const updates = [...(Array.isArray(envelope.deal_updates) ? envelope.deal_updates : (Array.isArray(envelope.deals) ? envelope.deals : []))]
      .sort((a, b) => compareInstants(a.occurred_at || a.at || a.created_at || a.recorded_at, b.occurred_at || b.at || b.created_at || b.recorded_at));
    const questions = [...(Array.isArray(envelope.review_questions) ? envelope.review_questions : []),
      ...(Array.isArray(core.open_questions) ? core.open_questions : []),
      ...(Array.isArray(envelope.questions) ? envelope.questions : [])];
    const drafts = Array.isArray(envelope.draft_proposals) ? envelope.draft_proposals : (Array.isArray(envelope.drafts) ? envelope.drafts : []);
    const hasReport = post.status === 'review_ready' || post.status === 'filed' || joe.length || dell.length || updates.length || questions.length || drafts.length;
    const active = root.activeElement;
    const focusedId = active?.dataset?.questionResolution;
    const selection = focusedId ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
    $('#postCallReport').innerHTML = hasReport ? `${core.summary ? `<p class="post-call-summary">${esc(reportText(core.summary))}</p>` : ''}
    ${reportSection('Deal by deal', updates, dealUpdateCard, 'No deal updates were identified.')}
    ${reportSection('Joe this week', joe, (item) => taskCard(item, 'Joe'), 'No Joe tasks were identified.')}
    ${reportSection('Dell this week', dell, (item) => taskCard(item, 'Dell'), 'No Dell tasks were identified.')}
    ${reportSection('Questions to resolve', questions, questionCard, 'No unresolved questions.')}
    ${reportSection('What clients and vendors need to know · email drafts', drafts, draftCard, 'No client or vendor emails are needed from this call.')}` : '';
    if (focusedId) {
      const field = [...$('#postCallReport').querySelectorAll('[data-question-resolution]')].find(node => node.dataset.questionResolution === focusedId);
      if (field && !field.disabled) { field.focus(); field.setSelectionRange(...selection); }
    }
  }

  // --------------------------------------------------------- context index

  async function publishWeeklyCallContext(session) {
    if (!session) throw new Error('The recorder did not return a recording session.');
    const generation = state.callGeneration || 0;
    if (state.postCall.session && state.postCall.session !== session) return false;
    if (state.contextInFlight?.session === session && state.contextInFlight.generation === generation) return state.contextInFlight.promise;
    const slot = { session, generation };
    const current = () => state.postCall.session === session && (state.callGeneration || 0) === generation && state.contextInFlight === slot;
    state.contextInFlight = slot;
    const run = (async () => {
      state.postCall = { ...state.postCall, status: 'context_loading', session, weekly: true,
        error: null, contextReady: false, contextAttempted: true };
      renderPostCall();
      const deals = await readCallContextIndex(deps.client(), deps.agendaDeals());
      if (!current()) return false;
      const scope = deps.scope();
      await deps.postCallClient.publishCallContext({ session, workspace_kind: scope.workspace_kind,
        ...(scope.account_client_id ? { account_client_id: scope.account_client_id } : {}),
        generated_at: new Date(now()).toISOString(), deals });
      if (!current()) return false;
      state.postCall = { ...state.postCall, status: 'context_ready', contextReady: true, error: null };
      renderPostCall();
      return true;
    })();
    slot.promise = run;
    try { return await run; } finally { if (state.contextInFlight === slot) state.contextInFlight = null; }
  }

  async function publishOrRecord(session) {
    const generation = state.callGeneration || 0;
    try {
      return await publishWeeklyCallContext(session);
    } catch (error) {
      if (state.postCall.session !== session || (state.callGeneration || 0) !== generation) return false;
      // Stop polling so the reason stays on screen: the next poll would read
      // awaiting_context again and quietly replace it. Retry resumes.
      stopPolling();
      state.postCall = { ...state.postCall, status: 'failed', session, weekly: true, error: error.message, errorAction:'context' };
      renderPostCall();
      return false;
    }
  }

  // ----------------------------------------------------------- report poll

  function stopPolling() {
    state.pollTimer?.dispose();
    state.pollTimer = null;
  }

  async function refreshPostCall({ quiet = false } = {}) {
    const session = state.postCall.session;
    if (!session) return;
    if (state.statusInFlight?.session === session) return;
    const sequence = state.statusSequence = (state.statusSequence || 0) + 1;
    const read = { session, sequence };
    state.statusInFlight = read;
    try {
      const payload = await deps.postCallClient.getStatus(session);
      if (state.postCall.session !== session || state.statusSequence !== sequence) return;
      const rawStatus = (typeof payload.status === 'object' ? payload.status.state : payload.status) || payload.state || 'waiting_for_transcript';
      const status = ({ ready_review: 'review_ready', blocked: 'failed' })[rawStatus] || rawStatus;
      const reason = typeof payload.status === 'object' && rawStatus === 'blocked' ? payload.status.reason : null;
      const report = payload.report || null;
      // review_ready arrives before the companion has filed and applied the
      // call; keep reading until report.automatic says the apply finished.
      const readyAt = status === 'review_ready' ? (state.postCall.readyAt ?? now()) : null;
      const applying = status === 'review_ready' && !automaticSettled(report);
      const applyTimedOut = applying && now() - readyAt >= APPLY_WAIT_MS;
      state.postCall = { ...state.postCall, status, report, readyAt, applyTimedOut,
        error: reason ? `Local processing stopped: ${reason}` : null };
      if (['filed', 'failed'].includes(status) || (status === 'review_ready' && (!applying || applyTimedOut))) stopPolling();
      else if (!state.pollTimer) startPolling(session, {immediate:false});
      if (['review_ready', 'filed'].includes(status) && !applying && reportCandidateIds().length) callOutcomes().then(view => view?.refresh());
      renderPostCall();
      // The stall this closes: a weekly recording whose companion never got
      // the context index. Supply it now, once per session unless a partner
      // presses Retry; the companion processes the transcript it already has.
      if (status === 'awaiting_context' && state.postCall.weekly && !state.postCall.contextAttempted) {
        await publishOrRecord(session);
      }
    } catch (error) {
      if (state.postCall.session !== session || state.statusSequence !== sequence) return;
      stopPolling();
      state.postCall = { ...state.postCall, status:state.postCall.report ? state.postCall.status : 'failed', error: error.message, errorAction:'report' };
      renderPostCall();
      if (!quiet) toast(error.message);
    } finally {
      if (state.statusInFlight === read) state.statusInFlight = null;
    }
  }

  function startPolling(session, { weekly = false, immediate = true } = {}) {
    stopPolling();
    const newCall = state.postCall.session !== session;
    if (newCall) {
      retireOutcomes();
      state.callGeneration = (state.callGeneration || 0) + 1;
    }
    state.postCall = { ...state.postCall, session, weekly: weekly || state.postCall.weekly,
      ...(newCall ? { readyAt: null, applyTimedOut: false } : {}) };
    // Hidden-tab polling is allowed only while the recorder is live.
    // Post-call processing uses the normal visibility and idle boundary.
    state.pollTimer = mountVisibilityPoll({ document: root, window: root.defaultView, keepAlive: () => callModeActive(),
      now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
      intervalMs: 1600, poll: () => refreshPostCall({ quiet: true }) });
    if (immediate) state.pollTimer.refresh();
  }

  // ------------------------------------------------------ per-item approval

  async function resolveCandidate(candidateId, accept, button) {
    if (!candidateId) return;
    button.disabled = true;
    try {
      const client = deps.client();
      if (button.dataset.candidateResolver === 'post_call') {
        await candidateCommands.send(`post-call:${candidateId}`, { candidate_id: candidateId, accept }, request => client.resolvePostCallCandidate(request));
      } else {
        await candidateCommands.send(`candidate:${candidateId}`, { proposal_id: candidateId, accept }, request => client.resolveConfirm(request));
      }
      await deps.postCallClient.syncStatus(state.postCall.session);
      toast(accept ? 'Post-call item confirmed.' : 'Post-call item skipped.');
      await refreshPostCall();
      if (accept && deps.onConfirmed) await deps.onConfirmed();
    } catch (error) {
      toast(error.pendingRequest ? 'Outcome unknown. Repeat the same decision to check its original request.' : error.message);
    } finally { button.disabled = false; }
  }

  async function createDraft(button) {
    const draftId = button.dataset.createOutlookDraft;
    const candidateId = button.dataset.draftCandidate;
    const session = state.postCall.session, contentHash = button.dataset.contentHash;
    const status = button.dataset.draftStatus;
    button.disabled = true;
    const uncertain = state.uncertainDrafts?.get(draftId);
    state.postCall.draftErrors.delete(draftId);
    try {
      if (uncertain) {
        if (uncertain.session !== session) throw new Error('Check the original call report before retrying this draft.');
        const payload = await deps.postCallClient.getStatus(uncertain.session);
        const drafts = payload.report?.draft_proposals || payload.report?.drafts;
        if (!Array.isArray(drafts)) throw new Error('Draft outcome unknown. Refresh the report before retrying.');
        const draft = drafts.find(item => item.draft_id === draftId);
        if (!draft) throw new Error('Draft outcome unknown. Keep this report open and check again.');
        if (['created','already_created','draft_created'].includes(draft.status)) {
          state.uncertainDrafts.delete(draftId); await refreshPostCall(); return;
        }
        if (button.dataset.contentHash !== uncertain.hash) throw new Error('Draft changed. Check the original draft outcome before approving new content.');
      }
      // Pressing this button IS the partner's approval of this one draft: the
      // candidate is confirmed first, then the companion creates an Outlook
      // draft. Nothing is ever sent.
      if (!uncertain && !['confirmed', 'created', 'already_created', 'draft_created'].includes(status)) {
        if (!candidateId) throw new Error('This email draft still needs a matched metadata candidate.');
        await candidateCommands.send(`post-call:${candidateId}`, { candidate_id: candidateId, accept: true }, request => deps.client().resolvePostCallCandidate(request));
      }
      if (state.postCall.session !== session) return;
      await deps.postCallClient.syncStatus(session);
      if (state.postCall.session !== session) return;
      const created = await deps.postCallClient.createOutlookDraft(
        session, draftId, contentHash,
      );
      if (state.postCall.session !== session) return;
      state.uncertainDrafts?.delete(draftId);
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
      if (state.postCall.session !== session) return;
      if (error.outcomeUnknown) {
        state.uncertainDrafts ||= new Map();
        state.uncertainDrafts.set(draftId,{session,hash:contentHash});
      }
      state.postCall.draftErrors.set(draftId, error.message);
      renderPostCall();
    } finally { button.disabled = false; }
  }

  // ------------------------------------------------------- recorder control

  async function refresh({ quiet = false, snapshot: suppliedSnapshot = null } = {}) {
    try {
      state.callMode = suppliedSnapshot || await api('state');
      const notice = $('#callModePermission');
      if (notice) notice.hidden = true;
      const snapshot = state.callMode;
      const session = snapshot.session || state.postCall.session;
      const changed = state.postCall.session !== session;
      const weekly = snapshot.mode === 'weekly_deal_call' || (!changed && state.postCall.weekly);
      if (changed) {
        stopPolling();
        retireOutcomes();
        state.callGeneration = (state.callGeneration || 0) + 1;
        state.postCall = {...idlePostCall(),session,weekly};
      }
      render();
      if (session && (weekly || state.postCall.contextReady)) {
        if (callModeActive(snapshot)) {
          if (changed && weekly) await publishOrRecord(session);
        } else if (changed || ['idle','context_ready','context_loading'].includes(state.postCall.status)
          || (state.postCall.status === 'failed' && state.postCall.errorAction === 'context')) {
          state.postCall = {...state.postCall,status:'waiting_for_transcript',session,weekly,error:null,
            contextAttempted:state.postCall.contextReady};
          renderPostCall();
          startPolling(session,{weekly});
        }
      }
    } catch (error) {
      showFailure(error);
    }
  }

  function startTicker() {
    if (state.tickTimer) return;
    state.tickTimer = mountLocalTicker({ document: root, window: root.defaultView, setInterval: timers.setInterval, clearInterval: timers.clearInterval, intervalMs: 250, tick: () => { if (callModeActive()) render(); } });
  }

  async function open({ session = null, signal } = {}) {
    if (signal?.aborted) return false;
    const dialog = $('#callModeDialog');
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    if (!await checkEligibility()) return false;
    if (signal?.aborted) { close(); return false; }
    startTicker();
    if (session) {
      stopPolling();
      retireOutcomes();
      state.callGeneration = (state.callGeneration || 0) + 1;
      state.postCall = { ...idlePostCall(), session, status: 'waiting_for_transcript' };
      const generation = state.callGeneration;
      signal?.addEventListener('abort', () => {
        if (state.postCall.session !== session || state.callGeneration !== generation) return;
        state.statusSequence = (state.statusSequence || 0) + 1;
        stopPolling();
        state.postCall = idlePostCall();
        retireOutcomes();
        $('#postCallReport').innerHTML = '';
        $('#postCallStatus').innerHTML = '';
        renderPostCall();
        close();
      }, { once: true });
      renderPostCall();
      await refreshPostCall();
      return !signal?.aborted;
    }
    await refresh({ quiet: true, snapshot: state.callMode });
    return true;
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
    if (state.eligibility === 'unavailable') return false;
    if (state.callMode.state === 'state_unknown') state.recorderUncertain = true;
    if (state.eligibility !== 'available' && !await checkEligibility()) return false;
    const button = root.querySelector(`[data-call-mode-start="${mode}"]`);
    if (button) button.disabled = true;
    try {
      if (await reconcileRecorder()) return false;
      state.callMode = await api('start', { mode, consent_confirmed: true });
      stopPolling();
      state.postCall = idlePostCall();
      render();
      startTicker();
      if (mode === 'weekly_deal_call') {
        const ok = await publishOrRecord(state.callMode.session || null);
        if (!ok) toast(`Recording started, but the weekly deal context needs attention: ${state.postCall.error}`);
        try {
          if (deps.startAgenda) {
            if (await deps.startAgenda() === false) throw new Error('Agenda unavailable');
            toast('Weekly deal call is recording. The agenda is open.');
          } else toast('Weekly deal call is recording.');
        } catch (error) {
          console.error('Could not start the weekly agenda', error);
          toast('Weekly deal call is recording. The agenda could not open.');
        }
      } else {
        toast('Call is recording.');
      }
      return true;
    } catch (error) {
      if (error.outcomeUnknown) state.recorderUncertain = true;
      showFailure(error);
      return false;
    } finally {
      if (button) button.disabled = false;
      // A recording needs a fresh confirmation every time.
      if (consent) consent.checked = false;
    }
  }

  async function stop() {
    if (state.eligibility !== 'available') return;
    const button = $('#callModeStop');
    if (button) button.disabled = true;
    try {
      if (await reconcileRecorder()) return;
      await refresh({snapshot:await api('stop', {})});
      toast('Recording stopped. Processing the call.');
    } catch (error) {
      if (error.outcomeUnknown) state.recorderUncertain = true;
      showFailure(error);
    } finally { if (button) button.disabled = false; }
  }

  /**
   * One delegated click handler for everything the dialog draws. Returns true
   * when it handled the click. Only an element carrying one of these data
   * attributes (and so only a partner pressing it) can reach a write.
   */
  async function handleClick(target) {
    const hit = (selector) => target?.closest?.(selector) || null;
    const recheck = hit('#callModeRetry');
    if (recheck) {
      const hadFocus = root.activeElement === recheck;
      if (await checkEligibility() && hadFocus && (root.activeElement === recheck || root.activeElement === root.body))
        $('#callModeButton')?.focus();
      return true;
    }
    if (outcomes && ['[data-call-undo]', '[data-call-reviewed]', '[data-call-recheck]', '[data-call-open-cards]'].some(hit)) { await outcomes.click({ target }); return true; }
    const confirm = hit('[data-post-call-confirm]');
    if (confirm) { await resolveCandidate(confirm.dataset.postCallConfirm, true, confirm); return true; }
    const skip = hit('[data-post-call-skip]');
    if (skip) { await resolveCandidate(skip.dataset.postCallSkip, false, skip); return true; }
    const draft = hit('[data-create-outlook-draft]');
    if (draft) { await createDraft(draft); return true; }
    const question = hit('[data-resolve-question]');
    if (question) { await resolveQuestion(question); return true; }
    if (hit('[data-refresh-post-call]')) { await refreshPostCall(); return true; }
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
    state, open, close, start, stop, refresh, refreshPostCall, render, handleClick, checkEligibility,
    startPolling, stopPolling, publishWeeklyCallContext,
    dispose() { root.removeEventListener('input', questionInput); stopPolling(); if (state.tickTimer) state.tickTimer.dispose(); state.tickTimer = null; },
  };
}
