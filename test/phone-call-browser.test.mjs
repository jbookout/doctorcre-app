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
    const session = { schema_version: 1, session_id: id, state: state.transferred ? 'ready_review' : state.sessionState || 'queued', transferred: state.transferred, filed: false, sha256: createHash('sha256').update(wav()).digest('hex') };
    if (path.endsWith('/report')) return r.fulfill({ json: { ...session, report: state.transferred ? { summary: 'Synthetic Clinic will review the revised proposal.', decisions: [], open_questions: ['Who agreed to send the proposal?'] } : null,
      actions: state.transferred ? [{ id: 'action-1', assignee: 'joe', action: 'Send revised proposal', due_on: null, status: 'pending' }] : [],
      deal_updates: state.transferred ? [{ id: 'update-1', kind: 'next_step', status: 'pending', payload: { text: 'Review revised proposal', evidence_quote: 'We will review it.' } }] : [] } });
    return r.fulfill({ json: req.method() === 'PUT' && !state.transferred ? { ...session, state: 'queued', queued: true, retry_after_seconds: state.retrySeconds || 0 } : session });
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
  await page.getByText('Waiting for the Studio', { exact: true }).waitFor();
  assert.equal(state.writes.some(r => r.method === 'PUT'), true);
  state.allowTransfer = true;
  state.transferred = true;
  await page.getByRole('button', { name: 'Check upload' }).click();
  await page.locator('#phoneReview').getByText('Ready for review', { exact: true }).waitFor();
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

test('a mismatched transfer receipt keeps the audio available after reload', async t => {
  const { page } = await open(t);
  await page.getByLabel('Everyone was told').check();
  await page.getByLabel('Recording file').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav() });
  await page.getByLabel('Recording started').fill('2026-10-30T10:00');
  await page.getByLabel('Consent announced').fill('2026-10-30T09:59');
  await page.getByRole('button', { name: 'Save recording' }).click();
  await page.getByRole('button', { name: 'Transfer recording' }).waitFor();
  await page.route('**/call-sessions/*/transfer', r => r.fulfill({ json: { schema_version: 1, session_id: id, state: 'transferred', transferred: true, filed: false, sha256: 'f'.repeat(64) } }));
  await page.getByRole('button', { name: 'Transfer recording' }).click();
  await page.getByText('Transfer could not be verified. Saved audio has been kept.', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Transfer recording' }).waitFor();
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

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`expired upload retains audio and uploads again at ${width} ${theme}`, async t => {
  const { page, state } = await open(t, { width, theme });
  await page.getByLabel('Everyone was told').check();
  await page.getByLabel('Recording file').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav() });
  await page.getByLabel('Recording started').fill('2026-10-30T10:00');
  await page.getByLabel('Consent announced').fill('2026-10-30T09:59');
  await page.getByRole('button', { name: 'Save recording' }).click();
  await page.getByRole('button', { name: 'Transfer recording' }).click();
  await page.getByText('Waiting for the Studio', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Check upload' }).click();
  await page.locator('#phoneCalls[aria-busy=false]').waitFor();
  assert.equal(state.writes.filter(r => r.method === 'PUT').length, 1, 'queued checks never resend audio');
  state.sessionState = 'expired';
  await page.reload();
  await page.getByText('Expired — upload again', { exact: true }).waitFor();
  assert.equal(await page.locator('audio').count(), 1);
  await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
  await animationsSettled(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('out/test-artifacts/phone-uploads', { recursive: true });
  await page.getByRole('button', { name: 'Upload again', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `out/test-artifacts/phone-uploads/${width}-${theme}.png` });
  state.allowTransfer = true;
  await page.getByRole('button', { name: 'Upload again', exact: true }).click();
  await page.locator('#phoneReview').getByText('Ready for review', { exact: true }).waitFor();
  assert.equal(await page.locator('audio').count(), 0);
  assert.equal(state.writes.filter(r => r.method === 'PUT').length, 2);
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
    await page.getByText(/Recording paused when the phone locked.*saved up to/).waitFor();
    await page.reload();
    await page.getByText(/Recording paused when the phone locked.*saved up to/).waitFor();
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

for (const [sessionState, label] of Object.entries({ pending: 'Pending transfer', queued: 'Waiting for the Studio', expired: 'Expired — upload again', transferred: 'Received by the Studio', ready_review: 'Ready for review', filed: 'Filed', needs_attention: 'Needs attention on the Studio', held_review: 'Held for review' })) test(`review displays ${sessionState}`, async t => {
  const { page } = await open(t, { review: true, sessionState });
  await page.locator('#phoneReview').getByText(label, { exact: true }).waitFor();
  if (['needs_attention', 'held_review'].includes(sessionState)) assert.equal(await page.locator('[data-transfer]').count(), 0);
});

test('queued upload waits for the server retry interval', async t => {
  const { page, state } = await open(t, { retrySeconds: 60 });
  await page.getByLabel('Everyone was told').check();
  await page.getByLabel('Recording file').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav() });
  await page.getByLabel('Recording started').fill('2026-10-30T10:00');
  await page.getByLabel('Consent announced').fill('2026-10-30T09:59');
  await page.getByRole('button', { name: 'Save recording' }).click();
  await page.getByRole('button', { name: 'Transfer recording' }).click();
  await page.getByText('Waiting for the Studio', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Check upload' }).isDisabled(), true);
  await page.reload();
  await page.getByText('Waiting for the Studio', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Check upload' }).isDisabled(), true);
  assert.equal(await page.locator('audio').count(), 1);
  assert.equal(state.writes.filter(r => r.method === 'PUT').length, 1);
});
