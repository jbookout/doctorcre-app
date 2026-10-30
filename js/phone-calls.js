import { createDayStore } from '../tours/day-store.js';
import { createDayRecorder } from '../tours/day-recorder.js';
import { createPhoneCallClient, sessionId } from './phone-call-client.js';
import { createLiveClient } from './live-client.js';
import { callOutcomesHtml, undoRefusal } from './call-outcomes.js';
import { resolveDealroomBoot } from './boot-mode.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const notice = message => { if (!disposed) $('phoneNotice').textContent = message; };
const api = createPhoneCallClient();
let store, recorder, scope, client, disposed = false, busy = false, currentId = null;
const tour_id = 'calls';
let wakeLock = null, wakeGeneration = 0, transferringId = null;
async function acquireWakeLock() {
  const generation = ++wakeGeneration;
  try {
    const lock = await navigator.wakeLock?.request('screen');
    if (!recorder?.active || generation !== wakeGeneration) { await lock?.release(); return; }
    const previous = wakeLock;
    wakeLock = lock;
    if (previous !== lock) await previous?.release();
    lock?.addEventListener('release', () => {
      if (wakeLock !== lock) return;
      wakeLock = null;
      if (document.hidden) recorder?.stop('locked');
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
  return '';
}
const mimeTypes = new Set(['audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/mpeg', 'audio/webm']);
const labels = { pending: 'Pending transfer', queued: 'Waiting for the Studio', expired: 'Expired — upload again', transferred: 'Received by the Studio', ready_review: 'Ready for review', filed: 'Filed', needs_attention: 'Needs attention on the Studio', held_review: 'Held for review' };
let retryTimer, retryTime;
function scheduleRetry(at) {
  if (!at || disposed || (retryTime && retryTime <= at)) return;
  clearTimeout(retryTimer);
  retryTime = at;
  retryTimer = setTimeout(() => { retryTime = null; void pending().catch(error => notice(error.message)); }, Math.max(0, at - Date.now()));
}
async function duration(audio) {
  const url = URL.createObjectURL(audio);
  try {
    return await new Promise((resolve, reject) => {
      const media = new Audio();
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
const transferred = session => session.transferred && ['transferred', 'ready_review', 'filed', 'needs_attention', 'held_review'].includes(session.state);
async function pending() {
  const rows = await recorder.recover(await store.list(scope, tour_id));
  for (const row of rows.filter(r => r.session_id && r.audio?.size && r.status !== 'failed' && r.id !== transferringId)) {
    if (row.retry_at > Date.now()) { scheduleRetry(row.retry_at); continue; }
    let confirmed;
    try { confirmed = await api.status(row.session_id); }
    catch (error) { notice(error.message); continue; }
    if (disposed) return;
    Object.assign(row, await store.patch(scope, row.id, { state: confirmed.state, retry_at: null }));
    if (transferred(confirmed))
      Object.assign(row, await store.patch(scope, row.id, { audio: null, status: 'transferred' }));
  }
  if (disposed) return;
  $('phonePending').innerHTML = rows.filter(r => r.audio?.size || r.status === 'recording' || r.status === 'transferred').map(r => `<article class="phone-row"><strong>${esc(r.name || 'Microphone recording')}</strong><span class="phone-badge">${r.id === transferringId ? 'Transferring…' : labels[r.state] || (r.status === 'recording' ? 'Recording' : r.status === 'failed' ? 'Failed' : r.status === 'transferred' ? 'Transferred' : 'Pending transfer')}</span>${r.status === 'transferred' ? `<a href="/calls?session=${esc(r.session_id)}">Review call</a>` : ''}${stopMessage(r) ? `<p>${esc(stopMessage(r))}</p>` : ''}${r.interrupted && !stopMessage(r) ? '<p>Recording interrupted. Review the saved audio before transferring. Start a new recording to continue.</p>' : ''}${r.audio?.size ? `<audio controls src="" data-audio="${esc(r.id)}"></audio><p class="phone-meta">Saved on this device</p>${!r.state || r.state === 'pending' || r.state === 'expired' || r.state === 'queued' ? `<button data-transfer="${esc(r.id)}" ${r.status === 'recording' || busy || r.retry_at > Date.now() ? 'disabled' : ''}>${r.state === 'expired' ? 'Upload again' : r.state === 'queued' ? 'Check upload' : 'Transfer recording'}</button>` : ''}` : ''}</article>`).join('');
  for (const player of $('phonePending').querySelectorAll('audio')) {
    const url = URL.createObjectURL(rows.find(r => r.id === player.dataset.audio).audio);
    player.src = url; player.onloadeddata = () => URL.revokeObjectURL(url);
  }
}
async function transfer(id) {
  const row = (await store.list(scope, tour_id)).find(r => r.id === id);
  if (!row?.audio?.size || row.status === 'recording') return;
  const meta = row.metadata || await metadata(row.audio, row.captured_at, row.consent_announced_at, row.duration_seconds);
  await store.patch(scope, id, { metadata: meta });
  if (row.state === 'queued') {
    const confirmed = await api.status(row.session_id);
    if (transferred(confirmed)) await review(row.session_id);
    return;
  }
  const admitted = row.session_id && row.state !== 'expired' ? { session_id: row.session_id } : await api.admit(meta);
  await store.patch(scope, id, { session_id: admitted.session_id });
  notice('Transferring…');
  const receipt = await api.transfer(admitted.session_id, row.audio, meta.mime_type);
  if (receipt.sha256 && receipt.sha256 !== meta.sha256) throw new Error('Transfer could not be verified. Saved audio has been kept.');
  if (receipt.state === 'queued') {
    const retry_at = Date.now() + Math.max(0, Number(receipt.retry_after_seconds) || 0) * 1000;
    await store.patch(scope, id, { state: receipt.state, retry_at });
    scheduleRetry(retry_at);
    notice(''); return;
  }
  const confirmed = await api.status(admitted.session_id);
  await store.patch(scope, id, { state: confirmed.state, retry_at: null });
  if (!receipt.transferred || !transferred(confirmed)) { notice(''); return; }
  await store.patch(scope, id, { audio: null, status: 'transferred' });
  try { await review(admitted.session_id); notice('Transfer confirmed. Audio removed from this device.'); }
  catch { notice('Transfer confirmed. Review is unavailable. Open the saved review link to retry.'); }
}
function reviewId(value) { try { return new URL(value).searchParams.get('session'); } catch { return value; } }
async function review(id) {
  if (!sessionId(id)) throw new Error('Enter a valid call session ID.');
  const result = await api.report(id);
  if (disposed) return;
  currentId = id;
  $('phoneCalls').classList.add('has-review');
  const url = new URL(location.href); url.searchParams.set('session', id); history.replaceState(null, '', url);
  $('phoneSession').value = id;
  $('phoneOpen').hidden = true;
  const held = [...(result.actions || []), ...(result.deal_updates || [])].some(r => r.status === 'pending');
  $('phoneReview').innerHTML = `<span class="phone-badge">${esc(labels[result.state])}</span><p><a href="${esc(url.pathname + url.search)}">Review link for another authorized device</a></p>${result.report ? `<h3>Summary</h3><p>${esc(result.report.summary)}</p>${result.report.decisions.length ? `<h3>Decisions</h3><ul>${result.report.decisions.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}${held ? '<p class="phone-hold">Partner confirmation needed. Speaker attribution may be ambiguous in a single track. Pending items have not been applied. Confirm only after checking who said what.</p>' : ''}<h3>Assigned actions</h3>${(result.actions || []).map(r => `<div class="phone-row"><strong>${esc(r.action)}</strong><p>${esc(({ joe: 'Joe', dell: 'Dell' })[r.assignee] || r.assignee)} · ${esc(r.due_on || 'No due date')} · ${esc(r.status === 'pending' ? 'Needs your confirmation' : r.status)}</p>${r.status === 'pending' ? `<button data-confirm-action="${esc(r.id)}">Confirm assigned action</button>` : ''}</div>`).join('') || '<p>No assigned actions.</p>'}<h3>Deal changes</h3>${(result.deal_updates || []).map(r => `<div class="phone-row"><p>${esc(r.payload?.text || r.payload?.summary || r.payload?.value || r.kind)}</p><p class="phone-meta">${esc(r.status)}${r.status === 'confirmed' ? ' · Confirmed changes are revised on the deal. Call Undo covers automatic changes only.' : ''}</p>${r.status === 'pending' ? `<button data-confirm-change="${esc(r.id)}">Confirm deal change</button>` : ''}</div>`).join('') || '<p>No deal changes.</p>'}<h3>Open questions</h3><ul>${result.report.open_questions.map(s => `<li>${esc(s)}</li>`).join('')}</ul><div id="phoneOutcomes"></div>` : '<p>The call service is waiting for transfer or processing. Refresh to check again.</p>'}<button id="phoneRefresh">Refresh review</button><button id="phoneAnother">Open another call</button>`;
  if (result.report) {
    try {
      const answer = await client.readCallOutcomes();
      if (!disposed && currentId === id) $('phoneOutcomes').innerHTML = callOutcomesHtml((answer.calls || []).filter(c => c.session_id === id)) || '<p class="phone-meta">No unreviewed automatic changes were returned. Confirmed changes remain listed above.</p>';
    } catch { if (!disposed) notice('Applied changes could not be checked. Refresh review to retry.'); }
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
  $('phoneCalls').addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.transfer) void run(async () => {
      transferringId = button.dataset.transfer; await pending();
      try { await transfer(button.dataset.transfer); }
      catch (error) { await store.patch(scope, button.dataset.transfer, { status: 'failed' }); throw error; }
      finally { transferringId = null; }
    });
    if (button.id === 'phoneAnother') { $('phoneOpen').hidden = false; $('phoneSession').focus(); }
    if (button.id === 'phoneRefresh') void run(() => review(currentId));
    if (button.dataset.callReviewed) void run(async () => { await client.reviewCallOutcome({ session_id: button.dataset.callReviewed }); await review(currentId); });
    if (button.dataset.callUndo) void run(async () => {
      try { await client.undoCallChange({ candidate_id: button.dataset.callUndo, base_version: Number(button.dataset.baseVersion) }); }
      catch (error) { throw new Error(undoRefusal(error)); }
      await review(currentId);
    });
    if (button.dataset.confirmAction || button.dataset.confirmChange) void run(async () => {
      if (button.dataset.confirmAction) await client.resolvePostCallCandidate({ candidate_id: button.dataset.confirmAction, accept: true, idempotency_key: crypto.randomUUID() });
      else await client.resolveConfirm({ proposal_id: button.dataset.confirmChange, accept: true, idempotency_key: crypto.randomUUID() });
      await review(currentId);
    });
  });
  const id = new URL(location.href).searchParams.get('session'); if (id) await review(id);
}
window.addEventListener('doctorcre-session-invalidated', () => { disposed = true; clearTimeout(retryTimer); releaseWakeLock(); recorder?.dispose(); void store?.close(); $('phoneCalls').replaceChildren(); }, { once: true });
document.addEventListener('visibilitychange', () => {
  if (!recorder?.active) return;
  if (!document.hidden) void acquireWakeLock();
  else if (!wakeLock || wakeLock.released) recorder.stop('locked');
});
document.addEventListener('freeze', () => recorder?.stop('locked'));
window.addEventListener('pagehide', () => { recorder?.stop('locked'); releaseWakeLock(); }, { once: true });
void start().catch(error => notice(error.message));
