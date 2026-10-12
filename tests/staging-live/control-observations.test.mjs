import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openDom } from '../../test/jsdom-harness.mjs';
import { pressControl } from '../../scripts/e2e-staging/controls.mjs';

function fixture(handler, idle) {
  const { window } = openDom('<main><button id="action">Action</button><dialog id="dialog" open></dialog><output id="noise"></output></main>', { url: 'https://synthetic.invalid/', runScripts: 'dangerously', pretendToBeVisual: true });
  window.Element.prototype.checkVisibility = function () { return !this.closest('[hidden]'); };
  window.Request = Request;
  window.document.querySelector('#action').onclick = () => handler(window);
  if (idle) window.setTimeout(() => idle(window), 10);
  const page = Object.assign(new EventEmitter(), {
    url: () => window.location.href,
    evaluate: async (fn, arg) => window.eval('(' + fn.toString() + ')')(arg),
    waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, ms)),
    locator: selector => ({ count: async () => window.document.querySelectorAll(selector).length,
      isVisible: async () => true, focus: async () => window.document.querySelector(selector).focus(),
      click: async () => window.document.querySelector(selector).click() }),
  });
  window.fetch = async (url, init = {}) => {
    page.emit('request', { url: () => new URL(url, window.location.href).href, method: () => init.method || 'GET', postDataJSON: () => JSON.parse(init.body) });
    return { ok: true };
  };
  page.close = () => window.close();
  return page;
}
const observations = [{ selector: '#dialog', attribute: 'open', transitions: [{ from: '', to: null }] }];
const press = page => pressControl(page, { selector: '#action', role: 'button' }, { waitMs: 25, observations });
test('specific dialog-close effect passes only after its open attribute is removed', async () => {
  const result = await press(fixture(win => win.document.querySelector('#dialog').removeAttribute('open')));
  assert.equal(result.status, 'OBSERVED');
  assert.equal(result.proof_observation.passed, true);
});
const read = win => win.fetch('/mcp', { method: 'POST', body: JSON.stringify({ method: 'tools/call', params: { name: 'morning-brief' } }) });
const apiEffect = [{ request: { path: '/mcp', method: 'POST', operation: 'morning-brief' } }];
test('API proof requires both a causal request and matching transport metadata', async () => {
  for (const mode of ['correct', 'noop', 'wrong-operation', 'wrong-origin', 'wrong-method', 'missing-transport', 'idle']) {
    const page = fixture(win => {
      if (mode === 'correct' || mode === 'missing-transport') return read(win);
      if (mode.startsWith('wrong')) return win.fetch(mode === 'wrong-origin' ? 'https://other.invalid/mcp' : '/mcp', {
        method: mode === 'wrong-method' ? 'GET' : 'POST', body: JSON.stringify({ method: 'tools/call', params: { name: mode === 'wrong-operation' ? 'find' : 'morning-brief' } }) });
    }, mode === 'idle' ? read : undefined);
    if (mode === 'missing-transport') page.emit = () => false;
    try {
      const result = await pressControl(page, { selector: '#action', role: 'button' }, { waitMs: 25, observations: apiEffect });
      assert.equal(result.status, mode === 'correct' ? 'OBSERVED' : 'DEAD', mode);
    } finally { page.close(); }
  }
});
test('no-op and unrelated DOM/focus effects fail the reviewed dialog-close proof', async () => {
  for (const handler of [() => {}, win => { win.document.querySelector('#noise').textContent = 'Noise'; win.document.querySelector('#noise').tabIndex = 0; win.document.querySelector('#noise').focus(); }]) {
    const result = await press(fixture(handler));
    assert.equal(result.status, 'DEAD');
    assert.equal(result.proof_observation.passed, false);
  }
});
test('unrelated timer cannot satisfy the expected effect for a no-op handler', async () => {
  const result = await press(fixture(() => {}, win => win.document.querySelector('#dialog').removeAttribute('open')));
  assert.equal(result.status, 'DEAD');
});
test('already satisfied postcondition and missing effect node fail', async () => {
  for (const handler of [win => win.document.querySelector('#dialog').remove(), () => {}]) {
    const page = fixture(handler);
    await page.evaluate(() => document.querySelector('#dialog').removeAttribute('open'));
    assert.equal((await press(page)).status, 'DEAD');
  }
});
