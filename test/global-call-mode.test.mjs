import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountGlobalCallMode } from '../js/global-call-mode.js';

for (const state of ['idle', 'recording']) test(`session revocation retires a pending ${state} companion probe`, async t => {
  const dom = new JSDOM('<button id="callModeButton"></button><p id="callModeAvailability"></p><button id="callModeRetry"></button>');
  t.after(() => dom.window.close());
  let finish;
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { finish = resolve; }));
  const mounting = mountGlobalCallMode(dom.window.document);
  dom.window.dispatchEvent(new dom.window.Event('doctorcre-session-invalidated'));
  dom.window.document.body.replaceChildren();
  finish(new Response(JSON.stringify({ state }), { headers: { 'content-type': 'application/json' } }));
  const call = await mounting;
  assert.equal(dom.window.document.body.childElementCount, 0);
  assert.equal(await call.checkEligibility(), false);
  assert.equal(await call.open(), false);
  assert.equal(dom.window.document.body.childElementCount, 0);
});

for (const result of ['idle', 'recording', 'unavailable']) {
  test(`session invalidation retires an initial Call Mode probe returning ${result}`, async t => {
    const dom = new JSDOM('<button id="callModeButton"></button><span id="callModeAvailability"></span><button id="callModeRetry"></button>');
    t.after(() => dom.window.close());
    let release;
    const response = new Promise(resolve => { release = resolve; });
    t.mock.method(globalThis, 'fetch', () => response);
    const pending = mountGlobalCallMode(dom.window.document);
    dom.window.dispatchEvent(new dom.window.Event('doctorcre-session-invalidated'));
    dom.window.document.body.innerHTML = '<main>Session ended</main>';
    release(result === 'unavailable' ? Response.error() : Response.json({ state: result }));
    const call = await pending;
    assert.equal(dom.window.document.body.innerHTML, '<main>Session ended</main>');
    assert.equal(await call.checkEligibility(), false);
    assert.equal(await call.open(), false);
    assert.equal(globalThis.fetch.mock.calls.length, 1, 'a retired mount cannot contact the companion again');
  });
}

test('explicit disposal retires a pending Call Mode retry', async t => {
  const dom = new JSDOM('<button id="callModeButton"></button><span id="callModeAvailability"></span><button id="callModeRetry"></button>');
  t.after(() => dom.window.close());
  let release;
  const response = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ state: 'idle' }));
  const call = await mountGlobalCallMode(dom.window.document);
  globalThis.fetch.mock.mockImplementation(() => response);
  const retry = call.checkEligibility();
  call.dispose();
  dom.window.document.body.innerHTML = '<main>Session ended</main>';
  release(Response.json({ state: 'recording' }));
  assert.equal(await retry, false);
  assert.equal(dom.window.document.body.innerHTML, '<main>Session ended</main>');
  assert.equal(await call.checkEligibility(), false);
  assert.equal(await call.open(), false);
  assert.equal(globalThis.fetch.mock.calls.length, 2);
});

test('session invalidation cancels a pending Call Mode open before it starts a timer', async t => {
  const dom = new JSDOM('<button id="callModeButton"></button><span id="callModeAvailability"></span><button id="callModeRetry"></button>');
  t.after(() => dom.window.close());
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  const location = globalThis.location;
  globalThis.location = new URL('https://app.doctorcre.com');
  t.after(() => {
    if (location === undefined) delete globalThis.location;
    else globalThis.location = location;
  });
  let reads = 0, release, reached;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reached = resolve; });
  const timers = t.mock.method(globalThis, 'setInterval', () => 123);
  t.mock.method(globalThis, 'clearInterval', () => {});
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).endsWith('/api/state')) {
      if (++reads === 3) { reached(); return held; }
      return Response.json({ state: 'idle' });
    }
    return Response.json({ status: 'filed' });
  });
  const call = await mountGlobalCallMode(dom.window.document);
  t.after(() => call.dispose());
  const opening = call.open({ session: 'synthetic-review' });
  await started;
  dom.window.dispatchEvent(new dom.window.Event('doctorcre-session-invalidated'));
  dom.window.document.body.innerHTML = '<main>Session ended</main>';
  release(Response.json({ state: 'idle' }));
  assert.equal(await opening, false);
  assert.equal(timers.mock.calls.length, 0, 'a retired open cannot start another timer');
  assert.equal(dom.window.document.body.innerHTML, '<main>Session ended</main>');
});
