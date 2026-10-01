import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountDocDock } from '../js/doc-dock.js';
import { createCallMode, CALL_MODE_URL } from '../js/call-mode.js';
import { createServer } from 'node:http';
import { extname } from 'node:path';
import { chromium } from 'playwright';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

async function dock(check) {
  const dom = new JSDOM(await read('pipeline.html'), { url: 'https://example.test/pipeline.html' });
  const previous = { document: globalThis.document, HTMLElement: globalThis.HTMLElement };
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  try { await check(dom.window, mountDocDock('Deals')); }
  finally { Object.assign(globalThis, previous); dom.window.close(); }
}

test('Doc offers the working conversation list and cannot render canned answers on submission', async () => {
  await dock((window, ui) => {
    const doc = window.document;
    ui.open();
    for (let i = 0; i < 6; i++) {
      doc.querySelector('#docInput').value = 'What is next?';
      doc.querySelector('#docForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
    }
    assert.match(doc.querySelector('#docTranscript').textContent, /Doc cannot answer here yet/);
    assert.doesNotMatch(doc.querySelector('#docChat').textContent, /prototype|demo|reminder for your review|five assignments/i);
    assert.equal(doc.querySelector('#docForm').hidden, true);
    const link = doc.querySelector('#docTranscript a');
    assert.equal(link.textContent, 'Open Doc Chats');
    assert.equal(new URL(link.href).pathname, '/conversations.html');
    assert.equal(doc.activeElement, link);
    ui.close();
    assert.equal(doc.activeElement, doc.querySelector('#docFab'));
  });
});

test('Dictate with Quill is disabled with a reason and never claims to listen without capture', async () => {
  await dock((window, ui) => {
    ui.open();
    const mic = window.document.querySelector('#docMic');
    mic.dispatchEvent(new window.Event('click'));
    assert.equal(mic.disabled, true);
    assert.match(window.document.querySelector('#docChat').textContent, /Dictation is not available here yet/);
    assert.doesNotMatch(window.document.querySelector('#docChat').textContent, /Listening/);
    assert.equal(mic.getAttribute('aria-pressed'), 'false');
  });
});

async function callSurface(fetchImpl, check) {
  const dom = new JSDOM(await read('index.html'));
  const effects = [];
  const ui = createCallMode({ root: dom.window.document, fetchImpl, eligibilityTimeoutMs: 20,
    client: () => { effects.push('client'); }, postCallClient: { getStatus: () => { effects.push('post-call'); } },
    setInterval: () => { effects.push('timer'); return 1; }, clearInterval: () => {} });
  try { await check(ui, dom.window.document, effects); }
  finally { ui.dispose(); dom.window.close(); }
}

function unavailable(doc) {
  assert.equal(doc.querySelector('#callModeButton').hidden, true);
  assert.match(doc.querySelector('#callModeAvailability').textContent, /Call recording runs on the Mac with Quill/);
  for (const id of ['callModeStarts', 'callModeConsentRow', 'callModeStop', 'callModeStandalone', 'postCallPanel']) {
    assert.equal(doc.getElementById(id).hidden, true, `${id} must not be offered`);
  }
}

for (const [name, fetchImpl] of [
  ['fails', async () => { throw new Error('unreachable'); }],
  ['times out even if fetch ignores abort', () => new Promise(() => {})],
  ['returns an HTTP error', async () => ({ ok: false, json: async () => ({ state: 'idle' }) })],
  ['returns an unrelated response', async () => ({ ok: true, json: async () => ({ ok: true }) })],
]) {
  test(`Call Mode has no dead controls when its probe ${name}`, async () => {
    await callSurface(fetchImpl, async (ui, doc, effects) => {
      assert.equal(await ui.checkEligibility(), false);
      unavailable(doc);
      doc.querySelector('#callModeConsent').checked = true;
      assert.equal(await ui.start('weekly_deal_call'), false);
      assert.deepEqual(effects, [], 'eligibility must not start timers or read backend/context/post-call');
    });
  });
}

test('Call Mode keeps controls hidden until the bounded probe succeeds and then shows the full idle controls', async () => {
  const requests = [];
  let resolve;
  await callSurface((url, init) => {
    requests.push({ url, init });
    return new Promise(r => { resolve = r; });
  }, async (ui, doc, effects) => {
    const ready = ui.checkEligibility();
    assert.equal(doc.querySelector('#callModeButton').hidden, true);
    assert.equal(doc.querySelector('#callModeStarts').hidden, true);
    resolve({ ok: true, json: async () => ({ state: 'idle' }) });
    assert.equal(await ready, true);
    for (const id of ['callModeButton', 'callModeStarts', 'callModeConsentRow', 'callModeStandalone']) {
      assert.equal(doc.getElementById(id).hidden, false, id);
    }
    assert.equal(doc.querySelector('#callModeAvailability').hidden, true);
    assert.equal(doc.querySelector('#callModeStop').hidden, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `${CALL_MODE_URL}/api/state`);
    assert.equal(requests[0].init.method, 'GET');
    assert.ok(requests[0].init.signal);
    assert.deepEqual(effects, []);
  });
});

test('a reachable recording companion retains Stop and elapsed recording controls', async () => {
  await callSurface(async () => ({ ok: true, json: async () => ({ state: 'recording', started_at: new Date().toISOString() }) }), async (ui, doc) => {
    assert.equal(await ui.checkEligibility(), true);
    assert.equal(doc.querySelector('#callModeStop').hidden, false);
    assert.equal(doc.querySelector('#callModeStarts').hidden, true);
    assert.match(doc.querySelector('#callModeState').textContent, /Recording live/);
  });
});

test('honest controls fit 390px and iPad in both motion settings with 44px touch targets', async () => {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://example.test').pathname.slice(1);
      if (path.includes('..')) throw new Error('Invalid path');
      res.setHeader('content-type', types[extname(path)] || 'text/plain');
      res.end(await read(path));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [390, 820]) for (const reducedMotion of ['reduce', 'no-preference']) {
      const page = await browser.newPage({ viewport: { width, height: 1180 }, reducedMotion });
      // Isolate these UI seams from unrelated backend boot and shell requests.
      await page.route(/\/(pipeline|app|app-shell)\.js$/, route => route.fulfill({ contentType: 'text/javascript', body: '' }));
      await page.route(/https:\/\/.*/, route => route.abort());
      await page.goto(`${base}/pipeline.html`);
      await page.evaluate(async () => (await import('/js/doc-dock.js')).mountDocDock('Deals'));
      await page.locator('#docFab').click();
      assert.equal(await page.locator('#docForm').isVisible(), false);
      assert.equal(await page.locator('#docMic').isDisabled(), true);
      assert.match(await page.locator('#docTranscript').textContent(), /Doc cannot answer here yet/);
      for (const selector of ['#docFab', '#docChatClose', '#docTranscript a', '#docMic']) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(box.width >= 44 && box.height >= 44, `${width}: ${selector} touch target`);
      }
      const dockBox = await page.locator('#docChat').boundingBox();
      assert.ok(dockBox.x >= 0 && dockBox.x + dockBox.width <= width);
      if (reducedMotion === 'reduce') {
        assert.equal(await page.locator('#docChat').evaluate(el => getComputedStyle(el).animationName), 'none');
      }
      await page.locator('#docTranscript a').click();
      await page.waitForURL('**/conversations.html');

      await page.goto(`${base}/index.html`);
      await page.evaluate(async () => {
        const { createCallMode } = await import('/js/call-mode.js');
        window.callUi = createCallMode({ root: document, fetchImpl: async () => { throw new Error('unreachable'); } });
        await window.callUi.checkEligibility();
      });
      assert.equal(await page.locator('#callModeButton').isVisible(), false);
      assert.match(await page.locator('#callModeAvailability').textContent(), /Call recording runs on the Mac with Quill/);
      const notice = await page.locator('#callModeAvailability').boundingBox();
      assert.ok(notice.x >= 0 && notice.x + notice.width <= width, `${width}: notice fits`);
      await page.evaluate(async () => {
        window.callUi.dispose();
        window.callUi = (await import('/js/call-mode.js')).createCallMode({ root: document,
          fetchImpl: async () => ({ ok: true, json: async () => ({ state: 'idle' }) }) });
        await window.callUi.checkEligibility();
        await window.callUi.open();
      });
      for (const selector of ['#callModeButton', '#callModeClose', '[data-call-mode-start]', '#callModeConsentRow', '#callModeStandalone']) {
        for (const locator of await page.locator(selector).all()) {
          const box = await locator.boundingBox();
          assert.ok(box.width >= 44 && box.height >= 44, `${width}: ${selector} touch target`);
        }
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
