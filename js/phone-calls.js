import { createPageBudget } from './read-budget.mjs';
import { watchPresence } from './visibility-poll.mjs';
import { createDayStore } from '../tours/day-store.js';
import { createDayRecorder } from '../tours/day-recorder.js';
import { createPhoneCallClient, sessionId } from './phone-call-client.js';
import { createLiveClient } from './live-client.js';
import { callChangeText, dayLabel, undoRefusal } from './call-outcomes.js';
import { resolveDealroomBoot } from './boot-mode.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const notice = message => { if (!disposed) $('phoneNotice').textContent = message; };
const api = createPhoneCallClient();
let store, recorder, scope, client, disposed = false, busy = false, currentId = null;
const answers = new Map(), answering = new Set();
const tour_id = 'calls';
let reviewGeneration = 0, guide = null;
let wakeLock = null, wakeGeneration = 0, transferringId = null, pollTimer = null, pollDelay = 30000, pollAttempts = 0;
const pollPresence = watchPresence({ document, window, onResume: resumeReads, onWake: resumeReads });
function resumeReads() {
  schedulePoll();
  if (currentId && !disposed) void review(currentId).catch(() => notice('Call review could not be refreshed. Please retry.'));
}
async function acquireWakeLock() {
  const generation = ++wakeGeneration;
  try {
    if (!navigator.wakeLock) { notice('Keep the screen on and this page open while recording.'); return; }
    const lock = await navigator.wakeLock.request('screen');
    if (!recorder?.active || generation !== wakeGeneration) { await lock?.release(); return; }
    const previous = wakeLock;
    wakeLock = lock;
    if (previous !== lock) await previous?.release();
    lock?.addEventListener('release', () => {
      if (wakeLock !== lock) return;
      wakeLock = null;
      if (document.hidden) recorder?.stop('hidden');
    });
  } catch { notice('Keep the screen on and this page open while recording.'); }
}
function releaseWakeLock() {
  ++wakeGeneration;
  const lock = wakeLock; wakeLock = null;
  void lock?.release();
}
function stopMessage(row) {
  if (row.status !== 'local') return '';
  if (row.stop_reason === 'duration') return 'Stopped at 60 minutes — saved';
  if (row.stop_reason === 'bytes') return 'Stopped at 50 MiB — saved';
  if (row.stop_reason === 'locked' || (row.interrupted && !row.stop_reason)) {
    const seconds = Math.floor(row.duration_seconds || 0);
    return `Recording paused when the phone locked — saved up to ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  if (row.stop_reason === 'hidden') return 'Recording paused when this page was hidden. The audio was saved.';
  return '';
}
const mimeTypes = new Set(['audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/mpeg', 'audio/webm']);
const labels = { pending: 'Pending transfer', queued: 'Uploaded — waiting for the Studio', expired: 'Transfer again', transferred: 'Processing', ready_review: 'Ready for review', filed: 'Filed', held_review: 'Held for review', needs_attention: 'Needs attention' };
function statusReason(session) {
  if (!['held_review', 'needs_attention'].includes(session.state)) return '';
  if (session.reason === 'budget') return "Held until tomorrow: today's processing budget is used.";
  const reasons = {
    summary_repeats_transcript: 'The summary repeated the transcript.',
    transcript_unavailable: session.state === 'held_review' ? 'The transcript is unavailable for review.' : 'The transcript is unavailable.',
    extraction_failed: 'The call could not be extracted.',
    transient_ceiling: 'Processing was retried too long.',
    open_review_questions: session.open_questions === 1 ? '1 question needs your answer.' : `${Number.isSafeInteger(session.open_questions) && session.open_questions > 0 ? session.open_questions : 'Some'} questions need your answer.`,
  };
  return Object.hasOwn(reasons, session.reason) ? reasons[session.reason] : 'This call needs attention before processing can continue.';
}
async function duration(audio) {
  const url = URL.createObjectURL(audio);
  try {
    return await new Promise((resolve, reject) => {
      const media = new Audio();
      // eslint-disable-next-line no-restricted-syntax -- One 10-second audio-metadata deadline per uploaded recording; the timer is cleared on success and both paths release the media source.
      const timer = setTimeout(() => { media.removeAttribute('src'); media.load(); reject(new Error('Could not read the recording length. Try a native audio export.')); }, 10000);
      const finish = value => { clearTimeout(timer); media.removeAttribute('src'); media.load(); resolve(value); };
      media.onloadedmetadata = () => { if (Number.isFinite(media.duration) && media.duration > 0) finish(media.duration); else { media.currentTime = 86400; } };
      media.ontimeupdate = () => { if (Number.isFinite(media.duration) && media.duration > 0) finish(media.duration); };
      media.onerror = () => { clearTimeout(timer); reject(new Error('This audio file could not be read. Try a native audio export.')); };
      media.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}
async function metadata(audio, started_at, consent_announced_at, seconds) {
  const mime_type = audio.type.split(';')[0].toLowerCase();
  if (!mimeTypes.has(mime_type) || !audio.size || audio.size > 50 * 1024 * 1024) throw new Error('Choose a supported audio recording up to 50 MiB.');
  const duration_seconds = seconds || await duration(audio);
  if (!(duration_seconds > 0 && duration_seconds <= 3600)) throw new Error('Choose a recording up to 60 minutes.');
  const digest = await crypto.subtle.digest('SHA-256', await audio.arrayBuffer());
  return { sha256: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join(''), byte_count: audio.size, duration_seconds, mime_type, started_at, consent_announced_at };
}
async function pending() {
  const rows = await recorder.recover(await store.list(scope, tour_id));
  if (disposed) return;
  $('phonePending').innerHTML = rows.filter(r => r.audio?.size || r.status === 'recording' || r.status === 'transferred' || ['held_review', 'needs_attention'].includes(r.status)).map(r => `<article class="phone-row"><strong>${esc(r.name || 'Microphone recording')}</strong><span class="phone-badge">${r.id === transferringId ? 'Transferring…' : r.status === 'recording' ? 'Recording' : r.status === 'failed' ? 'Failed' : r.status === 'queued' ? 'Uploaded — waiting for the Studio' : r.status === 'expired' ? 'Transfer again' : r.status === 'transferred' ? 'Transferred' : labels[r.status] || 'Pending transfer'}</span>${['transferred', 'held_review', 'needs_attention'].includes(r.status) ? `<a href="/calls?session=${esc(r.session_id)}">Review call</a>` : ''}${statusReason({ state: r.status, reason: r.reason, open_questions: r.open_questions }) ? `<p>${esc(statusReason({ state: r.status, reason: r.reason, open_questions: r.open_questions }))}</p>` : ''}${stopMessage(r) ? `<p>${esc(stopMessage(r))}</p>` : ''}${r.interrupted && !stopMessage(r) ? '<p>Recording interrupted. Review the saved audio before transferring. Start a new recording to continue.</p>' : ''}${['held_review', 'needs_attention'].includes(r.status) ? `<button data-status="${esc(r.id)}" ${busy ? 'disabled' : ''}>Check status</button>` : ''}${r.audio?.size ? `<audio controls src="" data-audio="${esc(r.id)}"></audio><p class="phone-meta">Saved on this device</p>${['held_review', 'needs_attention'].includes(r.status) ? '' : `<button data-transfer="${esc(r.id)}" ${r.status === 'recording' || busy ? 'disabled' : ''}>${r.status === 'queued' ? 'Check status' : r.status === 'expired' ? 'Transfer again' : 'Transfer recording'}</button>`}` : ''}</article>`).join('');
  for (const player of $('phonePending').querySelectorAll('audio')) {
    const url = URL.createObjectURL(rows.find(r => r.id === player.dataset.audio).audio);
    player.src = url; player.onloadeddata = () => URL.revokeObjectURL(url);
  }
}
async function applyStatus(id, session) {
  if (session.upload_state_unavailable) throw new Error('Upload status is unavailable. Your saved audio stays on this device.');
  if (['held_review', 'needs_attention'].includes(session.state)) {
    await store.patch(scope, id, { ...(session.transferred ? { audio: null } : {}), status: session.state, reason: session.reason, open_questions: session.open_questions });
  } else if (session.transferred) {
    await store.patch(scope, id, { audio: null, status: 'transferred' });
    await pending();
    try { await review(session.session_id); notice('Transfer confirmed. Audio removed from this device.'); }
    catch { notice('Transfer confirmed. Review is unavailable. Open the saved review link to retry.'); }
  } else if (['pending', 'queued', 'expired'].includes(session.state)) {
    await store.patch(scope, id, { status: session.state, reason: session.reason, open_questions: session.open_questions });
  }
}
function schedulePoll() {
  if (pollTimer || disposed || !store || !pollPresence.active() || pollAttempts >= 10) return;
  // eslint-disable-next-line no-restricted-syntax -- 10 transfer polling attempts; at most 100 queued status reads per attempt. 30 seconds, doubling each attempt to 120-second ceiling; audio stays local after failure watchPresence checked before scheduling and every row; hidden clears timer; 30-minute idle, pagehide and session invalidation stop; a new transfer explicitly resets the budget
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    if (disposed || !pollPresence.active()) return;
    pollAttempts++;
    try {
    const rows = await store.list(scope, tour_id);
    const takePage = createPageBudget();
    // eslint-disable-next-line no-restricted-syntax -- Transfer status consumes takePage before each queued session; a max of 100 status reads per capped poll attempt.
    for (const row of rows.filter(r => r.status === 'queued' && r.session_id)) {
      takePage();
      if (disposed || !pollPresence.active()) return;
      try { await applyStatus(row.id, await api.status(row.session_id)); } catch { /* Keep the saved audio and retry later. */ }
    }
    await pending();
    pollDelay = Math.min(pollDelay * 2, 120000);
    if ((await store.list(scope, tour_id)).some(r => r.status === 'queued')) schedulePoll();
    } catch { notice('Transfer status is unavailable. Check status to try again.'); }
  }, pollDelay);
}
async function transfer(id) {
  const row = (await store.list(scope, tour_id)).find(r => r.id === id);
  if (!row?.audio?.size || row.status === 'recording') return;
  const meta = row.metadata || await metadata(row.audio, row.captured_at, row.consent_announced_at, row.duration_seconds);
  await store.patch(scope, id, { metadata: meta });
  const admitted = row.session_id ? { session_id: row.session_id } : await api.admit(meta);
  await store.patch(scope, id, { session_id: admitted.session_id });
  if (row.session_id) {
    const status = await api.status(admitted.session_id);
    if (status.upload_state_unavailable || status.transferred || ['queued', 'held_review', 'needs_attention'].includes(status.state) || (status.state === 'expired' && row.status !== 'expired')) { await applyStatus(id, status); if (status.state === 'queued') schedulePoll(); return; }
  }
  notice('Transferring…');
  pollAttempts = 0; pollDelay = 30000;
  const result = await api.transfer(admitted.session_id, row.audio, meta.mime_type);
  if (result.state === 'queued') { await applyStatus(id, result); schedulePoll(); notice('Uploaded — waiting for the Studio'); return; }
  const confirmed = await api.status(admitted.session_id);
  await applyStatus(id, confirmed);
  if (confirmed.state === 'queued') schedulePoll();
  if (!confirmed.transferred && confirmed.state !== 'queued') notice('Pending transfer. Try again when the call service is available.');
}
function reviewId(value) { try { return new URL(value).searchParams.get('session'); } catch { return value; } }
async function review(id) {
  if (!sessionId(id)) throw new Error('Enter a valid call session ID.');
  const generation = ++reviewGeneration;
  const [result, session] = await Promise.all([api.report(id), api.status(id)]);
  if (disposed || generation !== reviewGeneration) return;
  currentId = id;
  $('phoneCalls').classList.add('has-review');
  const url = new URL(location.href); url.searchParams.set('session', id); history.replaceState(null, '', url);
  $('phoneSession').value = id;
  $('phoneOpen').hidden = true;
  const held = [...(result.actions || []), ...(result.deal_updates || [])].some(r => r.status === 'pending');
  guide?.dispose(); guide = null;
  $('phoneReview').innerHTML = `<span class="phone-badge">${esc(Object.hasOwn(labels, result.state) ? labels[result.state] : 'Status unavailable')}</span>${statusReason(result) ? `<p>${esc(statusReason(result))}</p>` : ''}<p><a href="${esc(url.pathname + url.search)}">Review link for another authorized device</a></p>${result.report ? `<h3>Summary</h3><p>${esc(result.report.summary)}</p>${result.report.decisions.length ? `<h3>Decisions</h3><ul>${result.report.decisions.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}${held ? '<p class="phone-hold">Partner confirmation needed. Speaker attribution may be ambiguous in a single track. Pending items have not been applied. Confirm only after checking who said what.</p>' : ''}<h3>Assigned actions</h3>${(result.actions || []).map(r => `<div class="phone-row"><strong>${esc(r.action)}</strong><p>${esc(({ joe: 'Joe', dell: 'Dell' })[r.assignee] || r.assignee)} · ${esc(r.due_on || 'No due date')} · ${esc(r.status === 'pending' ? 'Needs your confirmation' : r.status)}</p>${r.status === 'pending' ? `<button data-confirm-action="${esc(r.id)}">Confirm assigned action</button>` : ''}</div>`).join('') || '<p>No assigned actions.</p>'}<h3>Deal changes</h3>${(result.deal_updates || []).map(r => `<div class="phone-row"><p>${esc(r.payload?.text || r.payload?.summary || r.payload?.value || r.kind)}</p><p class="phone-meta">${esc(r.status)}${r.status === 'confirmed' ? ' · Confirmed changes are revised on the deal. Call Undo covers automatic changes only.' : ''}</p>${r.status === 'pending' ? `<button data-confirm-change="${esc(r.id)}">Confirm deal change</button>` : ''}</div>`).join('') || '<p>No deal changes.</p>'}<h3>Open questions</h3><ul>${result.report.open_questions.map(s => `<li>${esc(s)}</li>`).join('')}</ul><div id="phoneOutcomes"></div>` : statusReason(result) ? '' : '<p>The call service is waiting for transfer or processing. Refresh to check again.</p>'}<button id="phoneRefresh">Refresh review</button><button id="phoneAnother">Open another call</button>`;
  const questions = Array.isArray(session.review_questions) ? session.review_questions : [];
  $('phoneReview').insertAdjacentHTML('afterbegin', questions.length ? `<section id="phoneQuestions"><h3>Questions to answer</h3>${questions.map(q => `<form class="phone-row" data-question="${esc(q.id)}"><p>${esc(q.question)}</p><label>Answer <textarea name="answer" maxlength="1000" required ${answering.has(id + ':' + q.id) ? 'disabled' : ''} ${answers.has(id + ':' + q.id) ? 'readonly' : ''}>${esc(answers.get(id + ':' + q.id)?.answer || '')}</textarea></label><button type="submit" ${answering.has(id + ':' + q.id) ? 'disabled' : ''}>Submit answer</button><p role="status"></p></form>`).join('')}</section>` : '');
  if (result.report) {
    try {
      const { mountCallReview } = await import('./ui.generated.js');
      if (disposed || generation !== reviewGeneration || currentId !== id) return;
      guide = mountCallReview($('phoneOutcomes'), { sessionId: id, client: () => client,
        describe: callChangeText, dateLabel: dayLabel, undoRefusal });
      await guide.refresh();
    } catch { if (!disposed && generation === reviewGeneration) notice('Applied changes could not be checked. Refresh review to retry.'); }
  }
}
async function run(action) {
  if (busy || disposed) return;
  busy = true; $('phoneCalls').setAttribute('aria-busy', 'true');
  try { await action(); } catch (error) { notice(error.message || 'Call could not be updated. Please retry.'); }
  finally { busy = false; if (!disposed) $('phoneCalls').setAttribute('aria-busy', 'false'); if (store && !disposed) await pending().catch(error => notice(error.message)); }
}
async function start() {
  if (resolveDealroomBoot(location).mode !== 'live') { notice('Phone capture needs a signed-in connection. Local previews use synthetic recordings only.'); return; }
  const session = await api.session();
  if (!['joe', 'dell'].includes(session.actor?.slug)) throw new Error('Sign in as an authorized partner to capture a call.');
  scope = JSON.stringify([location.origin, session.actor.slug]);
  store = createDayStore(indexedDB, 'doctorcre-call-audio-v1');
  client = createLiveClient({ selfActor: session.actor.slug });
  recorder = createDayRecorder({ window, store, maxDurationMs: 60 * 60_000, maxBytes: 50 * 1024 * 1024, onChange: note => {
    if (disposed) return;
    $('phoneStop').hidden = !recorder.active;
    $('phoneRecord').disabled = Boolean(recorder.active);
    if (!recorder.active) releaseWakeLock();
    void pending().catch(error => notice(error.message));
  }, onError: (message, note) => { notice(message); if (note) void store.patch(scope, note.id, { interrupted: true, stop_reason: 'error' }).catch(() => {}); } });
  $('phoneSave').disabled = false; $('phoneRecord').disabled = false; notice('');
  await pending();
  if ((await store.list(scope, tour_id)).some(r => r.status === 'queued')) schedulePoll();
  $('phoneImport').onsubmit = event => { event.preventDefault(); void run(async () => {
    const audio = $('phoneFile').files[0]; if (!audio) throw new Error('Choose a recording file.');
    const timestamp = new Date().toISOString();
    const started = new Date($('phoneStarted').value).toISOString();
    const consent = new Date($('phoneConsentAt').value).toISOString();
    if (Date.parse(consent) > Date.parse(started)) throw new Error('Consent must be announced before the recording begins.');
    const meta = await metadata(audio, started, consent);
    await store.put({ scope, tour_id, id: crypto.randomUUID(), name: audio.name, audio, metadata: meta, status: 'local', captured_at: timestamp });
    notice('Recording saved on this device. Transfer when ready.'); $('phoneFile').value = ''; $('phoneConsent').checked = false;
  }); };
  $('phoneRecord').onclick = () => { if (!$('phoneConsent').checked) { notice('Confirm that everyone was told before recording.'); return; } void run(async () => { await recorder.start({ scope, tour_id, consent_announced_at: new Date().toISOString() }); await acquireWakeLock(); $('phoneConsent').checked = false; }); };
  $('phoneStop').onclick = () => { recorder.stop(); notice('Recording stopped. Review the saved audio before transferring.'); };
  $('phoneOpen').onsubmit = event => { event.preventDefault(); void run(() => review(reviewId($('phoneSession').value.trim()))); };
  $('phoneCalls').addEventListener('submit', event => {
    const form = event.target.closest('[data-question]'); if (!form) return;
    event.preventDefault();
    const question_id = form.dataset.question, id = currentId, slot = id + ':' + question_id;
    const answer = form.elements.answer.value.trim(); if (!answer || answering.has(slot)) return;
    const prior = answers.get(slot);
    const payload = prior || { idempotency_key: crypto.randomUUID(), session_id: id, question_id, answer };
    answers.set(slot, payload); answering.add(slot);
    form.querySelectorAll('button, textarea').forEach(control => control.disabled = true);
    void (async () => {
      let message = '';
      try { await api.answer(id, payload); } catch (error) { message = error.message; if (['invalid_question_answer', 'key_reuse'].includes(error.code)) answers.delete(slot); }
      try { if (!disposed && currentId === id) await review(id); } catch { message ||= 'Call review could not be refreshed. Please retry.'; }
      answering.delete(slot);
      if (disposed || currentId !== id) return;
      const current = [...$('phoneReview').querySelectorAll('[data-question]')].find(row => row.dataset.question === question_id);
      if (current) { current.querySelector('[role=status]').textContent = message; current.querySelector('button').disabled = false; current.querySelector('textarea').disabled = false; current.querySelector('textarea').readOnly = answers.has(slot); if (!answers.has(slot)) current.querySelector('textarea').value = answer; }
      else if (message) notice(message);
    })();
  });
  $('phoneCalls').addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.status) void run(async () => {
      const row = (await store.list(scope, tour_id)).find(r => r.id === button.dataset.status);
      if (row?.session_id) await applyStatus(row.id, await api.status(row.session_id));
    });
    if (button.dataset.transfer) void run(async () => {
      transferringId = button.dataset.transfer; await pending();
      try { await transfer(button.dataset.transfer); }
      catch (error) { const row = (await store.list(scope, tour_id)).find(r => r.id === button.dataset.transfer); if (row?.status !== 'queued') await store.patch(scope, button.dataset.transfer, { status: 'failed' }); throw error; }
      finally { transferringId = null; }
    });
    if (button.id === 'phoneAnother') { $('phoneOpen').hidden = false; $('phoneSession').focus(); }
    if (button.id === 'phoneRefresh') void run(() => review(currentId));
    if (button.dataset.confirmAction || button.dataset.confirmChange) void run(async () => {
      if (button.dataset.confirmAction) await client.resolvePostCallCandidate({ candidate_id: button.dataset.confirmAction, accept: true, idempotency_key: crypto.randomUUID() });
      else await client.resolveConfirm({ proposal_id: button.dataset.confirmChange, accept: true, idempotency_key: crypto.randomUUID() });
      await review(currentId);
    });
  });
  const id = new URL(location.href).searchParams.get('session'); if (id) await review(id);
}
window.addEventListener('doctorcre-session-invalidated', () => { disposed = true; guide?.dispose(); answers.clear(); answering.clear(); pollPresence.dispose(); clearTimeout(pollTimer); releaseWakeLock(); recorder?.dispose(); void store?.close(); $('phoneCalls').replaceChildren(); }, { once: true });
// eslint-disable-next-line no-restricted-syntax -- Visibility handler calls clearTimeout for transfer polling when hidden and manages 1 recorder wake lock; it performs 0 status reads.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { clearTimeout(pollTimer); pollTimer = null; }
  if (!recorder?.active) return;
  if (!document.hidden) void acquireWakeLock();
  else if (!wakeLock || wakeLock.released) recorder.stop('hidden');
});
document.addEventListener('freeze', () => recorder?.stop('hidden'));
window.addEventListener('pagehide', () => { clearTimeout(pollTimer); pollTimer = null; recorder?.stop('hidden'); releaseWakeLock(); }, { once: true });
void start().catch(error => notice(error.message));
