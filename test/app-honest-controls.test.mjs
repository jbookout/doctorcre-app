import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountDocPresence } from '../js/doc-presence.js';
import { createDocContext } from '../js/doc-context-model.js';
import { createCallMode, CALL_MODE_URL } from '../js/call-mode.js';
import { startFixture } from '../scripts/fixture-http.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { loadFixtureAssets } from '../scripts/fixture-assets.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { componentDocument, chromium, animationsSettled, settles } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { handleDoctorcreRequest } from '../src/worker.js';
import { appShellMarkup } from '../js/navigation.js';
import { mountGlobalCallMode } from '../js/global-call-mode.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

async function touchTargetBox(locator) {
  await animationsSettled(locator.page());
  return locator.boundingBox();
}

test('shared Doc shows unavailable reads, keeps Chats reachable and offers no unsupported input', async () => {
  const dom = new JSDOM('<main id="appMainSlot"></main>', { url:'https://example.test/deals' });
  const context = createDocContext({ page:'deals' });
  let ui;
  try {
    ui = mountDocPresence({ document:dom.window.document, window:dom.window, context,
      client:{ listDocSuggestions:async () => { throw new Error('unavailable'); } } });
    const doc = dom.window.document;
    doc.querySelector('#docDetail').showModal = function () { this.open = true; };
    ui.open();
    await settles(() => assert.match(doc.querySelector('#docSuggestions').textContent, /Unavailable/));
    // The read-only search bar is Doc's one supported input; nothing else may accept input.
    assert.equal(doc.querySelector('#docDetail form:not(#docCommandForm), #docMic, #docInput'), null);
    assert.ok(doc.querySelector('#docCommandForm'));
    assert.doesNotMatch(doc.querySelector('#docPresence').textContent, /Listening|prototype|demo/i);
    const link = doc.querySelector('.doc-chats-link[href="/doc-chats"]');
    assert.equal(new URL(link.href).pathname, '/doc-chats');
    const destination = link.href;
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
  } finally { ui?.dispose(); dom.window.close(); }
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
  assert.match(doc.querySelector('#callModeAvailability').textContent, /^Call recorder offline$/);
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

for (const finished of ['ready_to_extract', 'filed']) {
  test(`a finished call (${finished}) leaves Start available for the next call`, async () => {
    await callSurface(async () => ({ ok: true, json: async () => ({ state: finished, session: '2026.10.26-1031' }) }), async (ui, doc) => {
      assert.equal(await ui.checkEligibility(), true);
      assert.equal(doc.querySelector('#callModeStarts').hidden, false);
      assert.equal(doc.querySelector('#callModeConsentRow').hidden, false);
      assert.equal(doc.querySelector('#callModeStop').hidden, true);
    });
  });
}

test('a held newest recording leaves Start available with review wording', async () => {
  await callSurface(async () => ({ ok: true, json: async () => ({ state: 'held_review', session: 'synthetic-held-call' }) }), async (ui, doc) => {
    assert.equal(await ui.checkEligibility(), true);
    assert.equal(doc.querySelector('#callModeStarts').hidden, false);
    assert.equal(doc.querySelector('#callModeConsentRow').hidden, false);
    assert.equal(doc.querySelector('#callModeStop').hidden, true);
    assert.equal(doc.querySelector('#callModeTimer').textContent, 'Waiting for your review');
    assert.equal(doc.querySelector('#callModeState').textContent, 'An earlier recording is waiting for your review. You can start another call.');
    for (const button of doc.querySelectorAll('[data-call-mode-start]')) assert.equal(button.disabled, false);
  });
});

test('a call Quill is still transcribing keeps Start hidden', async () => {
  await callSurface(async () => ({ ok: true, json: async () => ({ state: 'transcribing', session: '2026.10.26-1031' }) }), async (ui, doc) => {
    assert.equal(await ui.checkEligibility(), true);
    assert.equal(doc.querySelector('#callModeStarts').hidden, true);
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

test('honest controls fit 320px, 390px and iPad in both motion settings with 44px touch targets', async t => {
  const root=temporaryDirectory('honest-controls-snapshot-',t);
  const {manifest}=await buildArtifact({root:process.cwd(),outDir:root});
  const snapshot=await loadFixtureAssets({root:`${root}/site`,manifest:new Map(manifest.files.map(row=>['/'+row.path,row.path]))});
  const routes=new Map();
  for(const path of [...snapshot.keys(),'/deals','/doc-chats','/auth/session','/api/system-work/session']) {
    const response=await handleDoctorcreRequest(new Request('https://example.test'+path),{
      CARR:{fetch:async()=>new Response('signed in')},
      ASSETS:{fetch:async request=>{
        const entry=snapshot.get(new URL(request.url).pathname);
        return entry?new Response(entry.body,{headers:{'content-type':entry.contentType}}):new Response('Missing fixture asset',{status:404});
      }}
    });
    routes.set(path,{status:response.status,headers:Object.fromEntries(response.headers),contentType:response.headers.get('content-type')||'application/octet-stream',body:Buffer.from(await response.arrayBuffer())});
  }
  const server=await startFixture({routes});
  t.after(()=>server.close());
  const base=server.origin;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [320, 390, 820]) for (const reducedMotion of ['reduce', 'no-preference']) {
      const page = await browser.newPage({ viewport: { width, height: 1180 }, reducedMotion });
      // Isolate these UI seams from unrelated backend boot and shell requests.
      await page.route(/\/(pipeline|app)\.js$/, route => route.fulfill({ contentType: 'text/javascript', body: '' }));
      await page.route(/https:\/\/.*/, route => route.abort());
      let companionAvailable = false;
      await page.route('http://127.0.0.1:4682/**', route => route.fulfill({ status:companionAvailable ? 200 : 503, json:{state:'idle'} }));
      await page.goto(`${base}/deals?view=board`);
      await page.locator('#selfAvatar').click();
      await page.keyboard.press('Tab');
      const accountFocus = await page.locator('#accountMenu :focus-visible').evaluate(el => {
        const style = getComputedStyle(el);
        return { outline: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
      });
      assert.deepEqual(accountFocus, { outline: 'solid', width: '2px', color: 'rgb(245, 127, 41)' }, `${width}: account keyboard focus stays visible alongside recorder availability`);
      await page.keyboard.press('Escape');
      if (width <= 760) await page.locator('#selfAvatar').click();
      const docTarget = await touchTargetBox(page.locator('#docOpen'));
      assert.ok(docTarget.width >= 44 && docTarget.height >= 44);
      await page.locator('#docOpen').click();
      assert.equal(await page.locator('#docDetail form:not(#docCommandForm), #docMic, #docInput').count(), 0);
      assert.equal(await page.locator('#docCommandForm').count(), 1);
      assert.match(await page.locator('#docSuggestions').textContent(), /Unavailable|Updating/);
      for (const selector of ['#docClose', '.doc-chats-link']) {
        for (const locator of await page.locator(selector).all()) {
          const box = await touchTargetBox(locator);
          assert.ok(box.width >= 44 && box.height >= 44, `${width}: ${selector} touch target ${JSON.stringify(box)}`);
        }
      }
      const dockBox = await page.locator('#docDetail').boundingBox();
      assert.ok(dockBox.x >= 0 && dockBox.x + dockBox.width <= width);
      await page.locator('.doc-chats-link[href="/doc-chats"]').click();
      await page.waitForURL('**/doc-chats');
      await page.locator('#conversationList').waitFor({ state: 'attached' });

      await page.goto(`${base}/deals`);
      if (width <= 760) await page.locator('#selfAvatar').click();
      await page.locator('#callModeRetry:enabled').waitFor({ state:'visible' });
      assert.equal(await page.locator('#callModeButton').isVisible(), false);
      assert.match(await page.locator('#callModeAvailability').textContent(), /^Call recorder not connected$/);
      const notice = await page.locator('#callModeAvailability').boundingBox();
      assert.ok(notice.x >= 0 && notice.x + notice.width <= width, `${width}: notice fits`);
      const retryBox = await page.locator('#callModeRetry').boundingBox();
      assert.ok(retryBox.width >= 44 && retryBox.height >= 44, `${width}: retry touch target`);
      assert.ok(retryBox.x >= 0 && retryBox.x + retryBox.width <= width, `${width}: retry fits`);
      companionAvailable = true;
      await page.locator('#callModeRetry').focus();
      await page.keyboard.press('Enter');
      await page.locator('#callModeButton').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#callModeRetry').isVisible(), false);
      assert.equal(await page.locator('#callModeButton').evaluate(el => el === document.activeElement), true);
      await page.locator('#callModeButton').click();
      await page.locator('#callModeDialog[open]').waitFor();
      await page.locator('#callModeStarts').waitFor({ state: 'visible' });
      for (const selector of ['#callModeClose', '[data-call-mode-start]', '#callModeConsentRow', '#callModeStandalone']) {
        for (const locator of await page.locator(selector).all()) {
          const box = await touchTargetBox(locator);
          const style = await locator.evaluate(el => { const s=getComputedStyle(el); return {minWidth:s.minWidth,minHeight:s.minHeight,transform:s.transform}; });
          assert.ok(box.width >= 44 && box.height >= 44, `${width}: ${selector} touch target ${JSON.stringify({box,style})}`);
        }
      }
      const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(n=>n.getBoundingClientRect().right>innerWidth+1&&getComputedStyle(n).position!=='fixed').map(n=>({tag:n.tagName,id:n.id,class:n.className,right:n.getBoundingClientRect().right})).slice(0,12));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: ${JSON.stringify(overflow)}`);
      await page.close();
    }
  } finally { await browser.close(); await server.close(); }
});

// Pin the fractional translation that made CI intermittently report 43.999px.
test('touch targets are measured after their entry animation settles', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 820, height: 1180 } });
    await componentDocument(page, 'http://localhost', {html: `<style>${await read('css/tokens.css')}${await read('css/system.css')} .doc-chat { top: 986.5px; bottom: auto; display: block; }</style><div class="doc-chat"><button class="btn">Dictate with Quill</button></div>`});
    await page.locator('.doc-chat').evaluate(el => {
      el.getAnimations().forEach(animation => animation.cancel());
      el.animate([{ transform: 'translateY(4.6646px)' }, { transform: 'translateY(4.6646px)' }], { duration: 500 });
    });
    const box = await touchTargetBox(page.locator('button'));
    assert.ok(box.height >= 44, `44px target reported as ${box.height}`);
  } finally { await browser.close(); }
});

for (const reachable of [true, false]) test(`shared Call Mode tolerates shell removal while the companion probe ${reachable ? 'succeeds' : 'fails'}`, async () => {
  const dom = new JSDOM(`<div id="appShell">${appShellMarkup('/leads')}</div>`);
  const doc = dom.window.document, previousFetch = globalThis.fetch;
  let finish;
  globalThis.fetch = () => new Promise((resolve, reject) => { finish = () => reachable
    ? resolve({ ok: true, json: async () => ({ state: 'idle' }) }) : reject(new Error('unreachable')); });
  try {
    const call = await mountGlobalCallMode(doc);
    const checking = call.checkEligibility();
    doc.body.replaceChildren(doc.createElement('main'));
    finish();
    await checking;
    call.dispose();
    assert.equal(doc.querySelector('#callModeButton'), null);
  } finally { globalThis.fetch = previousFetch; dom.window.close(); }
});

test('shared Call Mode does not add a dialog after the shell disappears during a recording probe', async () => {
  const dom = new JSDOM(`<div id="appShell">${appShellMarkup('/leads')}</div>`);
  const doc = dom.window.document, previousFetch = globalThis.fetch;
  const button = doc.getElementById('callModeButton');
  Object.defineProperty(button, 'hidden', { set(value) {
    if (!value) queueMicrotask(() => doc.body.replaceChildren(doc.createElement('main')));
  } });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ state: 'recording' }) });
  let call;
  try {
    call = await mountGlobalCallMode(doc);
    await call.checkEligibility();
    assert.equal(doc.getElementById('callModeDialog'), null);
  } finally { call?.dispose(); globalThis.fetch = previousFetch; dom.window.close(); }
});

test('shared Call Mode builds its dialog on first open, not at page load', async () => {
  const dom = new JSDOM(`<div id="appShell">${appShellMarkup('/leads')}</div>`);
  const doc = dom.window.document;
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
    call = await mountGlobalCallMode(doc);
    assert.equal(doc.getElementById('callModeDialog'), null, 'no dialog markup at page load');
    assert.equal(doc.getElementById('callModeButton').hidden, true);
    assert.match(doc.getElementById('callModeAvailability').textContent, /^Call recorder not connected$/);
    const retry = doc.getElementById('callModeRetry');
    assert.ok(retry && !retry.hidden);
    assert.deepEqual(requests, [], 'mounting never contacts the optional recorder');
    assert.equal(await call.handleClick(retry), true);
    assert.equal(doc.getElementById('callModeAvailability').textContent, 'Call recorder offline');
    reachable = true;
    assert.equal(await call.handleClick(retry), true);
    assert.equal(doc.getElementById('callModeButton').hidden, false);
    assert.equal(retry.hidden, true);
    assert.equal(doc.getElementById('callModeDialog'), null, 'a recheck does not build the dialog');
    assert.deepEqual(requests, [`${CALL_MODE_URL}/api/state`, `${CALL_MODE_URL}/api/state`]);
    doc.defaultView.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    await call.open({ session: '2026.10.26-1031' }).catch(() => {});
    assert.equal(doc.querySelectorAll('#callModeDialog').length, 1, 'first open builds the dialog once');
    await call.open({ session: '2026.10.26-1031' }).catch(() => {});
    assert.equal(doc.querySelectorAll('#callModeDialog').length, 1, 'later opens reuse it');
  } finally { call?.dispose(); globalThis.fetch = previousFetch; dom.window.close(); }
});

test('shared Call Mode connects explicitly before showing an existing recording', async () => {
  const dom = new JSDOM(`<div id="appShell">${appShellMarkup('/leads')}</div>`);
  const doc = dom.window.document, previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ state: 'recording', started_at: new Date().toISOString() }) });
  let call;
  try {
    call = await mountGlobalCallMode(doc);
    assert.equal(doc.querySelectorAll('#callModeDialog').length, 0);
    assert.equal(doc.getElementById('callModeButton').hidden, true);
    assert.equal(await call.checkEligibility(), true);
    assert.equal(doc.querySelectorAll('#callModeDialog').length, 1);
    assert.ok(doc.getElementById('callModeButton').classList.contains('recording'));
  } finally { call?.dispose(); globalThis.fetch = previousFetch; dom.window.close(); }
});


test('held recording review keeps the next call available on desktop and phone in both themes', async () => {
  const server = await fixtureServer();
  const browser = await chromium.launch({ headless: true });
  const evidence = new URL('../.github/pr-evidence/WR638.S1.J19/', import.meta.url);
  await mkdir(evidence, { recursive: true });
  try {
    for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
      await page.addInitScript(theme => localStorage.setItem('dealroom-theme', theme), theme);
      await page.route(/\/(pipeline|app)\.js$/, route => route.fulfill({ contentType: 'text/javascript', body: '' }));
      let starts = 0;
      await page.route('http://127.0.0.1:4682/**', route => {
        if (route.request().url().endsWith('/api/start')) {
          starts += 1;
          assert.deepEqual(route.request().postDataJSON(), { mode: 'other_call', consent_confirmed: true });
          return route.fulfill({ json: { state: 'recording', session: 'synthetic-new-call', started_at: new Date().toISOString() } });
        }
        return route.fulfill({ json: { state: 'held_review', session: 'synthetic-held-call' } });
      });
      await page.goto(`${server.origin}/deals`);
      await page.evaluate(async () => {
        const { mountGlobalCallMode } = await import('/js/global-call-mode.js');
        const call = await mountGlobalCallMode(document);
        await call.open();
      });
      await page.locator('#callModeDialog[open]').waitFor();
      assert.equal(await page.locator('#callModeTimer').textContent(), 'Waiting for your review');
      assert.equal(await page.locator('#callModeState').textContent(), 'An earlier recording is waiting for your review. You can start another call.');
      for (const button of await page.locator('[data-call-mode-start]').all()) {
        assert.equal(await button.isVisible(), true);
        assert.equal(await button.isEnabled(), true);
      }
      const panel = await page.locator('#callModeDialog').boundingBox();
      assert.ok(panel.x >= 0 && panel.x + panel.width <= width, 'Call Mode fits the viewport');
      await animationsSettled(page);
      await page.screenshot({ path: new URL(`held-${width}-${theme}.png`, evidence).pathname });
      await page.locator('#callModeConsent').check();
      await page.locator('[data-call-mode-start="other_call"]').click();
      await page.getByText('Recording live', { exact: true }).waitFor();
      assert.equal(starts, 1, 'one consented Start reaches the synthetic companion');
      await page.close();
    }
  } finally { await browser.close(); await server.close(); }
});
