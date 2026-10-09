import assert from 'node:assert/strict';
import test from 'node:test';
import { openDom } from './jsdom-harness.mjs';
import { pressControl } from '../scripts/e2e-staging/controls.mjs';
import { canonicalIdentity, identityKey, traversalSnapshot, validateTraversal } from '../scripts/e2e-staging/traversal.mjs';

function syntheticPage(html) {
  const dom = openDom(html, { url: 'https://synthetic.invalid/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  window.Request = Request;
  window.Element.prototype.checkVisibility = function () {
    for (let element = this; element; element = element.parentElement) {
      const style = window.getComputedStyle(element);
      if (element.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return this.isConnected;
  };
  const listeners = new Map();
  const page = {
    url: () => window.location.href,
    evaluate: async (fn, arg) => window.eval('(' + fn.toString() + ')')(arg),
    waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, ms)),
    on: (name, fn) => listeners.set(name, fn),
    off: name => listeners.delete(name),
    locator: selector => ({
      count: async () => window.document.querySelectorAll(selector).length,
      isVisible: async () => window.document.querySelector(selector)?.checkVisibility(),
      focus: async () => window.document.querySelector(selector).focus(),
      click: async () => window.document.querySelector(selector).click(),
    }),
  };
  return { page, window, listeners };
}

for (const action of [
  "this.closest('section').hidden=true",
  "this.closest('section').style.display='none'",
]) test('dismissal remains measured after its visible dialog disappears: ' + action, async () => {
  const { page } = syntheticPage('<main><section role="dialog"><button id="dismiss" onclick="' + action + '">Dismiss</button></section></main>');
  const control = { selector: '#dismiss', role: 'button', name: 'Dismiss', inputType: null, href: null, disabled: false,
    identity: canonicalIdentity('synthetic-dismiss') };
  const result = await pressControl(page, control, { waitMs: 20 });
  assert.equal(result.status, 'OBSERVED');
  assert.ok(result.signals.includes('main DOM mutation'));
  const screen = { target: 'desktop', path: '/', in_progress: true,
    controls: [{ ...control, ...result, key: 'desktop///' + identityKey(control.identity) }] };
  screen.traversal = traversalSnapshot({ queue: [{ openers: [control], controls: [{ ...control,
    selector: '#next', name: 'Next', identity: canonicalIdentity('synthetic-next') }] }],
    active: null, destructive: [], pending: null, seen: new Set([control.identity]) });
  assert.equal(validateTraversal(screen), screen.traversal);
});

test('hidden rendering and unrelated visible timers cannot credit a dead control', async () => {
  const { page, window } = syntheticPage('<main><button id="dead" onclick="document.querySelector(\'#hidden\').textContent=\'Changed\'">Dead</button><output id="visible"></output><output id="hidden" hidden></output></main>');
  window.setTimeout(() => { window.document.querySelector('#visible').textContent = 'Unrelated'; }, 10);
  const result = await pressControl(page, { selector: '#dead', role: 'button' }, { waitMs: 30 });
  assert.equal(result.status, 'DEAD');
  assert.deepEqual(result.signals, []);
});

test('an asynchronous test counter does not gate the Save request', async () => {
  for (const awaitCounter of [true, false]) {
    const { page, window, listeners } = syntheticPage('<main><form onsubmit="event.preventDefault();saveStep()"><button id="save" type="submit">Save</button><output id="status"></output></form></main>');
    let attempts = 0, writes = 0;
    window.fixtureSaveAttempt = () => new window.Promise(resolve => {
      setTimeout(() => { attempts++; resolve(); }, 10);
    });
    window.fetch = url => {
      writes++;
      listeners.get('request')?.({ url: () => new URL(url, page.url()).href, method: () => 'POST' });
      return window.Promise.resolve({});
    };
    window.eval('async function saveStep(){' + (awaitCounter ? 'await ' : '') + 'fixtureSaveAttempt();await fetch("/mcp",{method:"POST"});document.querySelector("#status").textContent="Saved"}');
    const result = await pressControl(page, { selector: '#save', role: 'button' }, { waitMs: 30 });
    assert.equal(attempts, 1);
    assert.equal(writes, 1);
    assert.equal(window.document.querySelector('#status').textContent, 'Saved');
    assert.equal(result.status, awaitCounter ? 'DEAD' : 'OBSERVED');
    assert.equal(result.signals.includes('network request'), !awaitCounter);
  }
});
