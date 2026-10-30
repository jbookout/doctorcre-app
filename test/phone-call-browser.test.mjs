import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { contrastRatio } from '../js/visual-system.js';
import { chromium, fixtureServer, animationsSettled } from './browser-harness.mjs';
let browser, server;
const id = '10000000-0000-0000-0000-000000000001';
before(async () => { server = await fixtureServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.close(); });
async function open(t, options = {}) {
  const page = await browser.newPage({ viewport: { width: options.width || 390, height: 900 }, colorScheme: options.theme || 'light', timezoneId: 'America/Chicago' });
  t.after(() => page.close());
  const state = { transferred: false, writes: [], ...options };
  await page.route('**/auth/session', r => r.fulfill({ json: { actor: { slug: 'joe', display: 'Synthetic Joe' }, csrf_token: 'synthetic-csrf' } }));
  await page.route('**/api/v1/call-sessions**', async r => {
    const req = r.request(), path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') state.writes.push({ path, method: req.method(), headers: req.headers(), body: req.postData() });
    if (req.method() === 'PUT' && state.allowTransfer) state.transferred = true;
    const session = { schema_version: 1, session_id: id, state: state.transferred ? 'ready_review' : 'pending', transferred: state.transferred, filed: false };
    if (path.endsWith('/report')) return r.fulfill({ json: { ...session, report: state.transferred ? { summary: 'Synthetic Clinic will review the revised proposal.', decisions: [], open_questions: ['Who agreed to send the proposal?'] } : null,
      actions: state.transferred ? [{ id: 'action-1', assignee: 'joe', action: 'Send revised proposal', due_on: null, status: 'pending' }] : [],
      deal_updates: state.transferred ? [{ id: 'update-1', kind: 'next_step', status: 'pending', payload: { text: 'Review revised proposal', evidence_quote: 'We will review it.' } }] : [] } });
    return r.fulfill({ json: session });
  });
  await page.route('**/mcp', r => {
    const rpc = r.request().postDataJSON();
    const { name, arguments: args } = rpc.params;
    let payload = { calls: [] };
    if (name === 'read-call-outcomes' && state.transferred) payload = { calls: [{ session_id: id, call_date: '2026-10-30', applied: [{ candidate_id: 'applied-1', deal_name: 'Synthetic Clinic', kind: 'next_step', payload: { text: 'Review revised proposal' }, evidence_quote: 'Review it.', deal_version: 3, undone_at: state.undone ? '2026-10-30' : null }], open_cards: [] }] };
    if (name === 'undo-call-change') { state.undone = true; state.writes.push({ name, args }); payload = { ok: true }; }
    return r.fulfill({ json: { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } });
  });
  await page.goto(`${server.origin}/calls?mode=live${options.review ? `&session=${id}` : ''}`);
  return { page, state };
}
function wav() {
  const b = Buffer.alloc(32044); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(32000, 40); return b;
}
test('phone import retains pending audio across reload and clears it only after confirmed transfer', async t => {
  const { page, state } = await open(t);
  await page.getByLabel('Everyone was told').check();
  await page.getByLabel('Recording file').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav() });
  await page.getByLabel('Recording started').fill('2026-10-30T10:00');
  await page.getByLabel('Consent announced').fill('2026-10-30T09:59');
  await page.getByRole('button', { name: 'Save recording' }).click();
  await page.getByText('Pending transfer', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Transfer recording' }).click();
  await page.getByText('Pending transfer. Try again when the call service is available.', { exact: true }).waitFor();
  assert.equal(state.writes.some(r => r.method === 'PUT'), true);
  state.allowTransfer = true;
  await page.getByRole('button', { name: 'Transfer recording' }).click();
  await page.getByText('Ready for review', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Transfer recording' }).count(), 0);
  assert.equal(state.writes.filter(r => r.method === 'POST').length, 1);
  const admission = JSON.parse(state.writes.find(r => r.method === 'POST').body);
  assert.deepEqual(Object.keys(admission).sort(), ['byte_count', 'consent_announced_at', 'duration_seconds', 'mime_type', 'sha256', 'started_at']);
  assert.equal(admission.sha256, createHash('sha256').update(wav()).digest('hex'));
  assert.equal(admission.byte_count, 32044);
  assert.equal(admission.duration_seconds, 1);
  assert.equal(admission.started_at, '2026-10-30T15:00:00.000Z');
  assert.equal(admission.consent_announced_at, '2026-10-30T14:59:00.000Z');
  assert.ok(state.writes.every(r => r.headers['x-carr-csrf'] === 'synthetic-csrf'));
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`review link shows summary, ambiguous holds and Undo at ${width} ${theme}`, async t => {
  const { page, state } = await open(t, { review: true, transferred: true, width, theme });
  await page.getByText('Synthetic Clinic will review the revised proposal.', { exact: true }).waitFor();
  await page.getByText(/Partner confirmation needed/).waitFor();
  assert.equal(state.writes.length, 0, 'opening an ambiguous single-track report never applies changes');
  await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
  await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
  await animationsSettled(page);
  const colors = await page.locator('#phoneCalls button').evaluateAll(buttons => buttons.map(button => {
    const style = getComputedStyle(button);
    const hex = value => '#' + value.match(/\d+/g).slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('');
    return { label: button.textContent, fg: hex(style.color), bg: hex(style.backgroundColor) };
  }));
  for (const color of colors) assert.ok(contrastRatio(color.fg, color.bg) >= 4.5, `${color.label} has readable contrast`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('out/test-artifacts/phone-calls', { recursive: true });
  await page.screenshot({ path: `out/test-artifacts/phone-calls/${width}-${theme}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByText('Undone', { exact: true }).waitFor();
  assert.equal(state.undone, true);
  assert.deepEqual(state.writes.find(w => w.name === 'undo-call-change').args.candidate_id, 'applied-1');
  assert.equal(state.writes.some(w => /resolve-/.test(w.name)), false);
});

test('microphone interruption keeps captured audio and labels the interruption after reload', async t => {
  const { page } = await open(t);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
    window.MediaRecorder = class {
      static isTypeSupported(type) { return type === 'audio/mp4'; }
      constructor() { this.mimeType = 'audio/mp4'; this.state = 'inactive'; }
      start() { this.state = 'recording'; window.syntheticRecorder = this; }
      stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['synthetic audio only'], { type: 'audio/mp4' }) }); this.onstop(); }
    };
  });
  await page.getByLabel('Everyone was told').check();
  await page.getByRole('button', { name: 'Record microphone' }).click();
  await page.getByRole('button', { name: 'Stop recording' }).waitFor();
  await page.waitForFunction(() => window.syntheticRecorder?.state === 'recording');
  await page.evaluate(() => window.syntheticRecorder.onerror());
  await page.getByRole('button', { name: 'Transfer recording' }).waitFor();
  await page.reload();
  await page.getByText(/Recording interrupted. Review the saved audio/).waitFor();
  assert.equal(await page.locator('audio').count(), 1);
});

test('a different verified partner cannot restore another partner pending recording', async t => {
  const { page } = await open(t);
  await page.getByLabel('Everyone was told').check();
  await page.getByLabel('Recording file').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav() });
  await page.getByLabel('Recording started').fill('2026-10-30T10:00');
  await page.getByLabel('Consent announced').fill('2026-10-30T09:59');
  await page.getByRole('button', { name: 'Save recording' }).click();
  await page.getByRole('button', { name: 'Transfer recording' }).waitFor();
  // A fresh login gets a new browser session binding while IndexedDB remains.
  await page.evaluate(() => localStorage.removeItem('doctorcre-session-binding-v1'));
  await page.route('**/auth/session', r => r.fulfill({ json: { actor: { slug: 'dell', display: 'Synthetic Dell' }, csrf_token: 'synthetic-dell-csrf' } }));
  await page.reload();
  await page.locator('#phoneSave:enabled').waitFor();
  assert.equal(await page.locator('audio').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Transfer recording' }).count(), 0);
});

test('a failed transfer is labelled Failed and retains audio for retry after reload', async t => {
  const { page } = await open(t);
  await page.getByLabel('Everyone was told').check();
  await page.getByLabel('Recording file').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav() });
  await page.getByLabel('Recording started').fill('2026-10-30T10:00');
  await page.getByLabel('Consent announced').fill('2026-10-30T09:59');
  await page.getByRole('button', { name: 'Save recording' }).click();
  await page.getByRole('button', { name: 'Transfer recording' }).waitFor();
  await page.route('**/call-sessions/*/transfer', r => r.fulfill({ status: 503, json: { error: 'phone_intake_unavailable' } }));
  await page.getByRole('button', { name: 'Transfer recording' }).click();
  await page.getByText('Failed', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Failed', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Transfer recording' }).isEnabled(), true);
});

test('ambiguous pending items apply only after a partner explicitly confirms them', async t => {
  const { page } = await open(t, { review: true, transferred: true });
  const writes = [];
  await page.route('**/mcp', r => {
    const rpc = r.request().postDataJSON();
    const name = rpc.params.name;
    if (name.startsWith('resolve-')) writes.push(rpc.params);
    return r.fulfill({ json: { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(name === 'read-call-outcomes' ? { calls: [] } : { ok: true, ref: 'synthetic-ref' }) }] } } });
  });
  await page.getByText(/Partner confirmation needed/).waitFor();
  assert.deepEqual(writes, []);
  await page.getByRole('button', { name: 'Confirm assigned action' }).click();
  await page.locator('#phoneCalls[aria-busy=false]').waitFor();
  const resolved = page.waitForResponse(r => r.url().endsWith('/mcp') && r.request().postDataJSON()?.params.name === 'resolve-candidate');
  await page.getByRole('button', { name: 'Confirm deal change' }).click();
  await resolved;
  assert.deepEqual(writes.map(w => [w.name, w.arguments.candidate_id, w.arguments.accept]), [
    ['resolve-post-call-candidate', 'action-1', true], ['resolve-candidate', 'update-1', true],
  ]);
});

test('phone capture navigation and review require no local companion', async t => {
  const { page } = await open(t, { review: true, transferred: true });
  const requests = [];
  page.on('request', r => { if (new URL(r.url()).port === '4682') requests.push(r.url()); });
  await page.reload();
  await page.getByText('Synthetic Clinic will review the revised proposal.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('link', { name: 'Phone capture', exact: true }).waitFor();
  assert.deepEqual(requests, []);
});

for (const locked of [false, true]) test(`phone recording handles hidden page with wake lock ${locked}`, async t => {
  const { page } = await open(t);
  await page.evaluate(locked => {
    window.wakeRequests = 0;
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { async request() {
      window.wakeRequests++;
      if (!locked) throw new Error('unavailable');
      return { released: false, addEventListener() {}, async release() { this.released = true; } };
    } } });
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
    window.MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor() { this.mimeType = 'audio/mp4'; }
      start() { this.state = 'recording'; window.syntheticRecorder = this; }
      stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['synthetic audio'], { type: 'audio/mp4' }) }); void this.onstop(); }
    };
  }, locked);
  await page.getByLabel('Everyone was told').check();
  await page.getByRole('button', { name: 'Record microphone' }).click();
  await page.waitForFunction(() => window.syntheticRecorder?.state === 'recording');
  assert.equal(await page.evaluate(() => window.wakeRequests), 1);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  if (locked) {
    assert.equal(await page.evaluate(() => window.syntheticRecorder.state), 'recording');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => window.wakeRequests === 2);
    await page.getByRole('button', { name: 'Stop recording' }).click();
  } else {
    await page.getByText(/Recording paused when this page was hidden/).waitFor();
    await page.reload();
    await page.getByText(/Recording paused when this page was hidden/).waitFor();
  }
  await page.getByRole('button', { name: 'Transfer recording' }).waitFor();
});

for (const theme of ['light', 'dark']) test(`duration limit says saved at phone width ${theme}`, async t => {
  const { page } = await open(t, { theme });
  await page.evaluate(() => {
    const original = window.setTimeout;
    window.setTimeout = (fn, ms, ...args) => ms === 3600000 ? (window.stopAtLimit = fn, 0) : original(fn, ms, ...args);
    navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [] });
    window.MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor() { this.mimeType = 'audio/mp4'; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['synthetic audio'], { type: 'audio/mp4' }) }); void this.onstop(); }
    };
  });
  await page.getByLabel('Everyone was told').check();
  await page.getByRole('button', { name: 'Record microphone' }).click();
  await page.waitForFunction(() => Boolean(window.stopAtLimit));
  await page.evaluate(() => window.stopAtLimit());
  await page.getByText('Stopped at 60 minutes — saved', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Stopped at 60 minutes — saved', { exact: true }).waitFor();
  await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
  await animationsSettled(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('out/test-artifacts/phone-calls', { recursive: true });
  await page.screenshot({ path: `out/test-artifacts/phone-calls/limit-390-${theme}.png`, fullPage: true });
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`queued audio waits for Studio and retry does not upload it again ${width} ${theme}`, async t => {
  const { page, state } = await open(t, { width, theme });
  await page.getByLabel('Everyone was told').check();
  await page.getByLabel('Recording file').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav() });
  await page.getByLabel('Recording started').fill('2026-10-30T10:00');
  await page.getByLabel('Consent announced').fill('2026-10-30T09:59');
  await page.getByRole('button', { name: 'Save recording' }).click();
  let queued = false, transferred = false;
  await page.route('**/api/v1/call-sessions**', r => {
    const req = r.request();
    if (req.method() === 'PUT') { state.writes.push({ method: 'PUT' }); queued = true; }
    return r.fulfill({ json: { schema_version: 1, session_id: id, state: transferred ? 'transferred' : queued ? 'queued' : 'pending', transferred, filed: false } });
  });
  await page.getByRole('button', { name: 'Transfer recording' }).click();
  await page.locator('#phonePending').getByText('Uploaded — waiting for the Studio', { exact: true }).waitFor({ timeout: 3000 });
  await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
  await animationsSettled(page);
  await mkdir('.github/pr-evidence/WR572.S8.J35', { recursive: true });
  await page.screenshot({ path: `.github/pr-evidence/WR572.S8.J35/queued-${width}-${theme}.png`, fullPage: true });
  await page.getByRole('button', { name: /Check status/ }).click();
  assert.equal(state.writes.filter(w => w.method === 'PUT').length, 1);
  await page.locator('#phoneCalls[aria-busy=false]').waitFor();
  transferred = true;
  await page.getByRole('button', { name: 'Check status' }).click();
  await page.getByText('Transferred', { exact: true }).waitFor();
  assert.equal(await page.locator('audio').count(), 0);
});

test('expired upload offers transfer again and sends the saved audio', async t => {
  const { page, state } = await open(t);
  await page.getByLabel('Everyone was told').check();
  await page.getByLabel('Recording file').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav() });
  await page.getByLabel('Recording started').fill('2026-10-30T10:00');
  await page.getByLabel('Consent announced').fill('2026-10-30T09:59');
  await page.getByRole('button', { name: 'Save recording' }).click();
  let status = 'pending';
  await page.route('**/api/v1/call-sessions**', r => {
    if (r.request().method() === 'PUT') { state.writes.push({ method: 'PUT' }); status = 'queued'; }
    return r.fulfill({ json: { schema_version: 1, session_id: id, state: status, transferred: false, filed: false } });
  });
  await page.getByRole('button', { name: 'Transfer recording' }).click();
  await page.getByRole('button', { name: 'Check status' }).waitFor();
  await page.locator('#phoneCalls[aria-busy=false]').waitFor();
  status = 'expired';
  await page.getByRole('button', { name: 'Check status' }).click();
  await page.getByRole('button', { name: 'Transfer again' }).click();
  await page.getByRole('button', { name: 'Check status' }).waitFor();
  assert.equal(state.writes.filter(w => w.method === 'PUT').length, 2);
});

for (const [status, code, copy] of [
  [409, 'recording_mismatch', 'This recording does not match the upload already in progress.'],
  [409, 'audio_handoff_unavailable', 'An upload is already in progress or this recording does not match.'],
  [429, 'daily_admission_limit', 'Daily recording limit reached.'],
  [429, 'handoff_full', 'The upload queue is full.'],
  [429, 'upload_rate_limit', 'Too many uploads in a short time.'],
  [429, 'audio_handoff_unavailable', 'The upload queue is full or too many uploads were attempted.'],
  [503, 'phone_intake_unavailable', 'Call service unavailable.'],
]) test(`phone upload explains ${status} ${code}`, async t => {
  const { page } = await open(t);
  await page.getByLabel('Everyone was told').check();
  await page.getByLabel('Recording file').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav() });
  await page.getByLabel('Recording started').fill('2026-10-30T10:00');
  await page.getByLabel('Consent announced').fill('2026-10-30T09:59');
  await page.getByRole('button', { name: 'Save recording' }).click();
  await page.route('**/call-sessions/*/transfer', r => r.fulfill({ status, json: { error: code } }));
  await page.getByRole('button', { name: 'Transfer recording' }).click();
  await page.locator('#phoneNotice').getByText(copy, { exact: false }).waitFor();
});

test('unavailable upload state never resends saved audio', async t => {
  const { page, state } = await open(t);
  await page.getByLabel('Everyone was told').check();
  await page.getByLabel('Recording file').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav() });
  await page.getByLabel('Recording started').fill('2026-10-30T10:00');
  await page.getByLabel('Consent announced').fill('2026-10-30T09:59');
  await page.getByRole('button', { name: 'Save recording' }).click();
  await page.getByRole('button', { name: 'Transfer recording' }).click();
  await page.getByText('Pending transfer. Try again when the call service is available.').waitFor();
  await page.locator('#phoneCalls[aria-busy=false]').waitFor();
  await page.route('**/call-sessions/*', r => r.fulfill({ json: { schema_version: 1, session_id: id, state: 'pending', transferred: false, filed: false, upload_state_unavailable: true } }));
  await page.getByRole('button', { name: 'Transfer recording' }).click();
  await page.getByText('Upload status is unavailable. Your saved audio stays on this device.').waitFor();
  assert.equal(state.writes.filter(w => w.method === 'PUT').length, 1);
});

test('queued upload is checked automatically and clears audio after Studio transfer', async t => {
  const { page } = await open(t);
  await page.clock.install();
  await page.getByLabel('Everyone was told').check();
  await page.getByLabel('Recording file').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav() });
  await page.getByLabel('Recording started').fill('2026-10-30T10:00');
  await page.getByLabel('Consent announced').fill('2026-10-30T09:59');
  await page.getByRole('button', { name: 'Save recording' }).click();
  let queued = false, transferred = false, reads = 0;
  await page.route('**/api/v1/call-sessions**', r => {
    if (r.request().method() === 'PUT') queued = true;
    if (r.request().method() === 'GET') reads++;
    return r.fulfill({ json: { schema_version: 1, session_id: id, state: transferred ? 'transferred' : queued ? 'queued' : 'pending', transferred, filed: false } });
  });
  await page.getByRole('button', { name: 'Transfer recording' }).click();
  await page.getByRole('button', { name: 'Check status' }).waitFor();
  transferred = true;
  await page.clock.runFor(30000);
  await page.getByText('Transferred', { exact: true }).waitFor();
  assert.ok(reads >= 1);
  assert.equal(await page.locator('audio').count(), 0);
});

test('phone review shows the Studio hold and attention reasons', async t => {
  const { page } = await open(t, { review: true });
  let status = { state: 'held_review', reason: 'summary_repeats_transcript', open_questions: 2 };
  await page.route('**/api/v1/call-sessions**', r => r.fulfill({ json: { schema_version: 1, session_id: id, transferred: true, filed: false, ...status, report: null, actions: [], deal_updates: [] } }));
  const cases = [
    [{ state: 'held_review', reason: 'summary_repeats_transcript', open_questions: 2 }, 'Held for review', 'The summary repeated the transcript.'],
    [{ state: 'held_review', reason: 'transcript_unavailable', open_questions: 1 }, 'Held for review', 'The transcript is unavailable for review.'],
    [{ state: 'held_review', reason: 'open_review_questions', open_questions: 3 }, 'Held for review', '3 questions need your answer.'],
    [{ state: 'needs_attention', reason: 'transcript_unavailable', open_questions: 0 }, 'Needs attention', 'The transcript is unavailable.'],
    [{ state: 'needs_attention', reason: 'extraction_failed', open_questions: 0 }, 'Needs attention', 'The call could not be extracted.'],
    [{ state: 'needs_attention', reason: 'transient_ceiling', open_questions: 0 }, 'Needs attention', 'Processing was retried too long.'],
    [{ state: 'held_review', reason: 'budget', open_questions: 0 }, 'Held for review', "Held until tomorrow: today's processing budget is used."],
    [{ state: 'needs_attention', reason: 'unknown', open_questions: 0 }, 'Needs attention', 'This call needs attention before processing can continue.'],
    [{ state: 'transferred', reason: null, open_questions: 0 }, 'Processing', 'The call service is waiting for transfer or processing. Refresh to check again.'],
  ];
  for (const [payload, label, message] of cases) {
    status = payload;
    await page.reload();
    await page.getByText(label, { exact: true }).waitFor({ timeout: 3000 });
    await page.getByText(message, { exact: true }).waitFor({ timeout: 3000 });
  }
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`held call status at ${width} ${theme}`, async t => {
  const { page } = await open(t, { review: true, width, theme });
  await page.route('**/api/v1/call-sessions**', r => r.fulfill({ json: { schema_version: 1, session_id: id, state: 'held_review', reason: 'open_review_questions', open_questions: 3, transferred: true, filed: false, report: null, actions: [], deal_updates: [] } }));
  await page.reload();
  await page.getByText('3 questions need your answer.', { exact: true }).waitFor();
  await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
  await animationsSettled(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('.github/pr-evidence/WR572.S8.J43', { recursive: true });
  await page.screenshot({ path: `.github/pr-evidence/WR572.S8.J43/held-${width}-${theme}.png`, fullPage: true });
});

test('queued call shows a hold on status refresh and does not resend audio', async t => {
  const { page, state } = await open(t);
  await page.getByLabel('Everyone was told').check();
  await page.getByLabel('Recording file').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav() });
  await page.getByLabel('Recording started').fill('2026-10-30T10:00');
  await page.getByLabel('Consent announced').fill('2026-10-30T09:59');
  await page.getByRole('button', { name: 'Save recording' }).click();
  let status = 'pending';
  await page.route('**/api/v1/call-sessions**', r => {
    if (r.request().method() === 'PUT') { state.writes.push({ method: 'PUT' }); status = 'queued'; }
    return r.fulfill({ json: { schema_version: 1, session_id: id, state: status, reason: status === 'held_review' ? 'open_review_questions' : null, open_questions: 3, transferred: false, filed: false } });
  });
  await page.getByRole('button', { name: 'Transfer recording' }).click();
  await page.getByRole('button', { name: 'Check status' }).waitFor();
  status = 'held_review';
  await page.getByRole('button', { name: 'Check status' }).click();
  await page.locator('#phonePending').getByText('3 questions need your answer.', { exact: true }).waitFor();
  assert.equal(state.writes.filter(w => w.method === 'PUT').length, 1);
  assert.equal(await page.locator('audio').count(), 1);
  await page.reload();
  await page.locator('#phonePending').getByText('Held for review', { exact: true }).waitFor();
});
