import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountGlobalCallMode } from '../js/global-call-mode.js';

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
