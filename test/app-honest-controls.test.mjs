import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountDocDock } from '../js/doc-dock.js';
import { createCallMode, CALL_MODE_URL } from '../js/call-mode.js';
import { createServer } from 'node:http';
import { extname } from 'node:path';
import { chromium } from 'playwright';
import { handleDoctorcreRequest } from '../src/worker.js';
import { appShellMarkup } from '../js/app-shell.js';
import { mountGlobalCallMode } from '../js/global-call-mode.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// Translation animations can round a 44px rectangle just below 44px. Read its
// settled geometry, preserving the exact touch-target floor without a sleep.
async function touchTargetBox(locator) {
  await locator.evaluate(async element => {
    const animations = [];
    for (let node = element; node; node = node.parentElement) {
      animations.push(...node.getAnimations().filter(animation =>
        animation.effect.getTiming().iterations !== Infinity));
    }
    await Promise.all(animations.map(animation => animation.finished));
  });
  return locator.boundingBox();
}

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
    assert.equal(new URL(link.href).pathname, '/doc-chats');
    assert.equal(doc.activeElement, link);
    ui.close();
    assert.equal(doc.activeElement, doc.querySelector('#docFab'));
  });
});

test('the Doc Chats dock action passes the Worker sign-in gate and serves the conversation list', async () => {
  await dock(async (window, ui) => {
    ui.open();
    const destination = window.document.querySelector('#docTranscript a').href;
    const gates = [], assets = [];
    const response = await handleDoctorcreRequest(new Request(destination), {
      CARR: { fetch: async (request) => { gates.push(new URL(request.url).pathname); return new Response('signed in'); } },
      ASSETS: { fetch: async (request) => {
        assets.push(new URL(request.url).pathname);
        return new Response(await read('conversations.html'), { headers: { 'content-type': 'text/html' } });
      } },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(gates, ['/conversations']);
    assert.deepEqual(assets, ['/conversations.html']);
    assert.match(await response.text(), /Doc Chats/);
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
  dom.window.document.getElementById('appShell').innerHTML = appShellMarkup('/deals');
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

for (const failure of ['rejection', 'late response', 'hung JSON']) {
  test(`the visible recorder recheck recovers from a startup ${failure} without reloading`, async () => {
    let requests = 0, resolveLate;
    await callSurface(() => {
      requests += 1;
      if (requests > 1) return Promise.resolve({ ok: true, json: async () => ({ state: 'idle' }) });
      if (failure === 'rejection') return Promise.reject(new Error('temporary outage'));
      if (failure === 'hung JSON') return Promise.resolve({ ok: true, json: () => new Promise(() => {}) });
      return new Promise(resolve => { resolveLate = resolve; });
    }, async (ui, doc, effects) => {
      assert.equal(await ui.checkEligibility(), false);
      unavailable(doc);
      const retry = doc.querySelector('#callModeRetry');
      assert.ok(retry, 'startup failure must offer a visible recheck');
      assert.equal(retry.hidden, false);
      assert.equal(retry.disabled, false);
      assert.equal(await ui.handleClick(retry), true);
      assert.equal(requests, 2);
      assert.equal(doc.querySelector('#callModeButton').hidden, false);
      assert.equal(retry.hidden, true);
      assert.deepEqual(effects, [], 'a recheck reads eligibility only');
      resolveLate?.({ ok: true, json: async () => ({ state: 'recording' }) });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(doc.querySelector('#callModeStop').hidden, true, 'late old response cannot replace the fresh idle snapshot');
    });
  });
}

test('a pending recorder recheck coalesces presses and remains retryable after another failure', async () => {
  let requests = 0, rejectProbe;
  await callSurface(() => {
    requests += 1;
    if (requests === 1) return Promise.reject(new Error('startup outage'));
    return new Promise((_, reject) => { rejectProbe = reject; });
  }, async (ui, doc) => {
    await ui.checkEligibility();
    const retry = doc.querySelector('#callModeRetry');
    const first = ui.handleClick(retry);
    const second = ui.handleClick(retry);
    assert.equal(retry.disabled, true);
    assert.equal(doc.querySelector('#callModeStarts').hidden, true);
    assert.equal(requests, 2);
    rejectProbe(new Error('still unavailable'));
    await Promise.all([first, second]);
    unavailable(doc);
    assert.equal(retry.hidden, false);
    assert.equal(retry.disabled, false);
  });
});

test('honest controls fit 390px and iPad in both motion settings with 44px touch targets', async () => {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
  const server = createServer(async (req, res) => {
    const response = await handleDoctorcreRequest(new Request(new URL(req.url, 'http://example.test')), {
      CARR: { fetch: async () => new Response('signed in') },
      ASSETS: { fetch: async (request) => {
        const path = new URL(request.url).pathname.slice(1);
        try {
          return new Response(await read(path), { headers: { 'content-type': types[extname(path)] || 'text/plain' } });
        } catch { return new Response('Missing fixture asset', { status: 404 }); }
      } },
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [390, 820]) for (const reducedMotion of ['reduce', 'no-preference']) {
      const page = await browser.newPage({ viewport: { width, height: 1180 }, reducedMotion });
      // Isolate these UI seams from unrelated backend boot and shell requests.
      await page.route(/\/(pipeline|app)\.js$/, route => route.fulfill({ contentType: 'text/javascript', body: '' }));
      await page.route(/https:\/\/.*/, route => route.abort());
      await page.goto(`${base}/deals?view=board`);
      await page.evaluate(async () => (await import('/js/doc-dock.js')).mountDocDock('Deals'));
      await page.locator('#docFab').click();
      assert.equal(await page.locator('#docForm').isVisible(), false);
      assert.equal(await page.locator('#docMic').isDisabled(), true);
      assert.match(await page.locator('#docTranscript').textContent(), /Doc cannot answer here yet/);
      for (const selector of ['#docFab', '#docChatClose', '#docTranscript a', '#docMic']) {
        const box = await touchTargetBox(page.locator(selector));
        assert.ok(box.width >= 44 && box.height >= 44, `${width}: ${selector} touch target ${JSON.stringify(box)}`);
      }
      const dockBox = await page.locator('#docChat').boundingBox();
      assert.ok(dockBox.x >= 0 && dockBox.x + dockBox.width <= width);
      if (reducedMotion === 'reduce') {
        assert.equal(await page.locator('#docChat').evaluate(el => getComputedStyle(el).animationName), 'none');
      }
      await page.locator('#docTranscript a').click();
      await page.waitForURL('**/doc-chats');
      await page.locator('#conversationList').waitFor({ state: 'attached' });

      await page.goto(`${base}/deals`);
      await page.evaluate(async () => {
        const { createCallMode } = await import('/js/call-mode.js');
        window.companionAvailable = false;
        window.callUi = createCallMode({ root: document, fetchImpl: async () => {
          if (!window.companionAvailable) throw new Error('unreachable');
          return { ok: true, json: async () => ({ state: 'idle' }) };
        } });
        document.addEventListener('click', event => window.callUi.handleClick(event.target));
        await window.callUi.checkEligibility();
      });
      assert.equal(await page.locator('#callModeButton').isVisible(), false);
      assert.match(await page.locator('#callModeAvailability').textContent(), /Call recording runs on the Mac with Quill/);
      const notice = await page.locator('#callModeAvailability').boundingBox();
      assert.ok(notice.x >= 0 && notice.x + notice.width <= width, `${width}: notice fits`);
      const retryBox = await page.locator('#callModeRetry').boundingBox();
      assert.ok(retryBox.width >= 44 && retryBox.height >= 44, `${width}: retry touch target`);
      assert.ok(retryBox.x >= 0 && retryBox.x + retryBox.width <= width, `${width}: retry fits`);
      await page.evaluate(() => { window.companionAvailable = true; });
      await page.locator('#callModeRetry').focus();
      await page.keyboard.press('Enter');
      await page.locator('#callModeButton').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#callModeRetry').isVisible(), false);
      assert.equal(await page.locator('#callModeButton').evaluate(el => el === document.activeElement), true);
      await page.evaluate(async () => {
        await window.callUi.open();
      });
      for (const selector of ['#callModeButton', '#callModeClose', '[data-call-mode-start]', '#callModeConsentRow', '#callModeStandalone']) {
        for (const locator of await page.locator(selector).all()) {
          const box = await touchTargetBox(locator);
          assert.ok(box.width >= 44 && box.height >= 44, `${width}: ${selector} touch target ${JSON.stringify(box)}`);
        }
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

// Pin the fractional translation that made CI intermittently report 43.999px.
test('Doc touch targets are measured after their entry animation settles', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 820, height: 1180 } });
    await page.setContent(`<style>${await read('css/system.css')} .doc-chat { top: 986.5px; bottom: auto; display: block; }</style><div class="doc-chat"><button class="btn">Dictate with Quill</button></div>`);
    await page.locator('.doc-chat').evaluate(el => {
      el.getAnimations().forEach(animation => animation.cancel());
      el.animate([{ transform: 'translateY(4.6646px)' }, { transform: 'translateY(4.6646px)' }], { duration: 500 });
    });
    const box = await touchTargetBox(page.locator('button'));
    assert.ok(box.height >= 44, `44px target reported as ${box.height}`);
  } finally { await browser.close(); }
});

test('shared Call Mode offers eligibility and a working retry without backend reads', async () => {
  const dom = new JSDOM(`<div id="appShell">${appShellMarkup('/leads')}</div>`);
  const previousFetch = globalThis.fetch;
  const requests = [];
  let reachable = false;
  globalThis.fetch = async url => {
    requests.push(String(url));
    if (String(url) !== `${CALL_MODE_URL}/api/state`) throw new Error('unexpected backend read');
    if (!reachable) throw new Error('unreachable');
    return { ok: true, json: async () => ({ state: 'idle' }) };
  };
  let call;
  try {
    call = await mountGlobalCallMode(dom.window.document);
    unavailable(dom.window.document);
    const retry = dom.window.document.getElementById('callModeRetry');
    assert.ok(retry && !retry.hidden);
    reachable = true;
    assert.equal(await call.handleClick(retry), true);
    assert.equal(dom.window.document.getElementById('callModeButton').hidden, false);
    assert.equal(retry.hidden, true);
    assert.deepEqual(requests, [`${CALL_MODE_URL}/api/state`, `${CALL_MODE_URL}/api/state`]);
  } finally { call?.dispose(); globalThis.fetch = previousFetch; dom.window.close(); }
});
