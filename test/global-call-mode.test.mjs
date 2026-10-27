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
