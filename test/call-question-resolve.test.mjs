import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { createCallMode } from '../js/call-mode.js';
import { CALL_MODE_URL, CALL_MODE_HEADER } from '../js/post-call-client.js';
import { createPostCallClient } from '../js/post-call-review-client.js';

async function review(t, fetchImpl) {
  const dom = new JSDOM(await readFile(new URL('../index.html', import.meta.url), 'utf8'));
  const ui = createCallMode({ root: dom.window.document, client: () => ({}),
    fetchImpl, postCallClient: createPostCallClient({ fetchImpl }), setInterval: () => 1, clearInterval: () => {} });
  t.after(() => { ui.dispose(); dom.window.close(); });
  ui.state.eligibility = 'available';
  ui.state.postCall = { ...ui.state.postCall, session: 'demo-session', status: 'review_ready',
    report: { review_questions: [{ id: 'demo-question', question: 'Which suite?', resolved: false }] } };
  ui.render();
  return { ui, doc: dom.window.document };
}

test('resolving a review question renders the returned resolution read-only', async t => {
  const requests = [];
  const { ui, doc } = await review(t, async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return { ok: true, json: async () => ({ questions: [{ id: 'demo-question', question: 'Which suite?',
      resolved: true, resolution: 'Suite 200 <confirmed>' }], status: { state: 'filed' } }) };
  });
  const field = doc.querySelector('[data-question-resolution]');
  assert.ok(field, 'Unresolved questions offer a resolution field');
  field.value = 'Suite 200 <confirmed>';
  field.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
  await ui.handleClick(doc.querySelector('[data-resolve-question]'));
  assert.deepEqual(requests, [{ url: `${CALL_MODE_URL}/api/post-call/questions/demo-question/resolve`,
    body: { session: 'demo-session', resolution: 'Suite 200 <confirmed>' },
    headers: { 'content-type': 'application/json', ...CALL_MODE_HEADER } }]);
  assert.match(doc.querySelector('#postCallReport').textContent, /Suite 200 <confirmed>/);
  assert.equal(doc.querySelector('[data-resolve-question]'), null);
  assert.equal(doc.querySelector('#postCallReport confirmed'), null);
  assert.equal(ui.state.postCall.status, 'filed');
});

test('an already resolved question shows a plain notice and refreshes the report', async t => {
  const requests = [];
  const { ui, doc } = await review(t, async (url, init) => {
    requests.push(init.method || 'GET');
    return init.method === 'POST'
      ? { ok: false, status: 409, json: async () => ({ error: 'already_resolved' }) }
      : { ok: true, json: async () => ({ status: { state: 'filed' }, report: {
        review_questions: [{ id: 'demo-question', question: 'Which suite?', resolved: true, resolution: 'Suite 300' }] } }) };
  });
  const field = doc.querySelector('[data-question-resolution]');
  field.value = 'Suite 200';
  field.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
  await ui.handleClick(doc.querySelector('[data-resolve-question]'));
  assert.deepEqual(requests, ['POST', 'GET']);
  assert.match(doc.querySelector('#postCallReport').textContent, /Already resolved/);
  assert.match(doc.querySelector('#postCallReport').textContent, /Suite 300/);
  assert.equal(doc.querySelector('[data-resolve-question]'), null);
});

test('empty and whitespace-only resolution text keeps Resolve disabled and sends nothing', async t => {
  const requests = [];
  const { ui, doc } = await review(t, async (...args) => { requests.push(args); });
  assert.equal(doc.querySelector('[data-resolve-question]').disabled, true);
  const field = doc.querySelector('[data-question-resolution]');
  field.value = '   ';
  field.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
  assert.equal(doc.querySelector('[data-resolve-question]').disabled, true);
  await ui.handleClick(doc.querySelector('[data-resolve-question]'));
  assert.deepEqual(requests, []);
  field.value = 'Suite 200';
  field.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
  assert.equal(doc.querySelector('[data-resolve-question]').disabled, false);
  field.value = '';
  field.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
  assert.equal(doc.querySelector('[data-resolve-question]').disabled, true);
});

test('a report read started during Resolve cannot restore the old unresolved question', async t => {
  let finishResolve, finishRead;
  const { ui, doc } = await review(t, (url, init) => new Promise(resolve => {
    if (init.method === 'POST') finishResolve = resolve;
    else finishRead = resolve;
  }));
  const field = doc.querySelector('[data-question-resolution]');
  field.value = 'Suite 200';
  field.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
  const resolving = ui.handleClick(doc.querySelector('[data-resolve-question]'));
  const reading = ui.refreshPostCall();
  finishResolve({ ok: true, json: async () => ({ questions: [{ id: 'demo-question', question: 'Which suite?',
    resolved: true, resolution: 'Suite 200' }], status: { state: 'filed' } }) });
  await resolving;
  finishRead({ ok: true, json: async () => ({ status: 'review_ready', report: {
    review_questions: [{ id: 'demo-question', question: 'Which suite?', resolved: false }] } }) });
  await reading;
  assert.match(doc.querySelector('#postCallReport').textContent, /Resolved · Suite 200/);
  assert.equal(doc.querySelector('[data-resolve-question]'), null);
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`review question resolution at ${width}px in ${theme}`, async t => {
    const server = await fixtureServer(); t.after(() => server.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 960 }, reducedMotion: 'reduce' });
    const dialog = (await readFile(new URL('../index.html', import.meta.url), 'utf8'))
      .match(/<dialog id="callModeDialog"[\s\S]*?<\/dialog>/)[0];
    const questions = [
      { id: 'demo-question', question: 'Which suite did the partners choose?', resolved: false },
      { id: 'demo-reviewed', question: 'Who will follow up?', resolved: true, resolution: 'Joe will call the landlord.' },
    ];
    await page.route(`${server.origin}/question-review`, route => route.fulfill({ contentType: 'text/html',
      body: `<html data-theme="${theme}"><head><meta charset="utf-8"><link rel="stylesheet" href="/css/app.css"><link rel="stylesheet" href="/css/app-shell.css"></head><body>${dialog}</body></html>` }));
    await page.route(`${server.origin}/api/post-call/questions/demo-question/resolve`, async route => {
      const body = route.request().postDataJSON();
      assert.deepEqual(body, { session: 'demo-session', resolution: 'Suite 200' });
      questions[0] = { ...questions[0], resolved: true, resolution: body.resolution };
      await route.fulfill({ json: { questions, status: { state: 'filed' } } });
    });
    await page.goto(`${server.origin}/question-review`);
    await page.evaluate(async questions => {
      const { createCallMode } = await import('/js/call-mode.js');
      const { createPostCallClient } = await import('/js/post-call-review-client.js');
      const ui = createCallMode({ root: document, client: () => ({}),
        fetchImpl: (url, init) => fetch(new URL(url).pathname, init),
        postCallClient: createPostCallClient({ loopbackUrl: location.origin }) });
      ui.state.eligibility = 'available';
      ui.state.postCall = { ...ui.state.postCall, session: 'demo-session', status: 'review_ready',
        report: { review_questions: questions } };
      ui.render();
      document.querySelector('#callModeDialog').showModal();
      document.addEventListener('click', event => ui.handleClick(event.target));
    }, questions);
    const button = page.getByRole('button', { name: 'Resolve', exact: true });
    assert.equal(await button.isDisabled(), true);
    await page.getByRole('textbox', { name: 'Resolution' }).fill('Suite 200');
    assert.equal(await button.isEnabled(), true);
    const card = page.locator('.post-call-card.question').first();
    await card.scrollIntoViewIfNeeded();
    assert.equal(await card.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await mkdir('out/test-artifacts/call-question-resolve', { recursive: true });
    await page.screenshot({ path: `out/test-artifacts/call-question-resolve/${width}-${theme}-pending.png`, fullPage: true });
    await button.click();
    await card.getByText('Resolved', { exact: true }).waitFor();
    assert.match(await card.textContent(), /Suite 200/);
    assert.equal(await page.getByRole('textbox').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Resolve', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `out/test-artifacts/call-question-resolve/${width}-${theme}-resolved.png`, fullPage: true });
  });
}
