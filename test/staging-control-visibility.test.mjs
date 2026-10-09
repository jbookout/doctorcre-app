import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { pressControl } from '../scripts/e2e-staging/controls.mjs';
import { canonicalIdentity, identityKey, traversalSnapshot, validateTraversal } from '../scripts/e2e-staging/traversal.mjs';

function syntheticPage(t, html) {
  const dom = new JSDOM(html, { url: 'https://synthetic.invalid/', runScripts: 'dangerously', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
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
  return { page, window };
}

for (const action of [
  "this.closest('section').hidden=true",
  "this.closest('section').style.display='none'",
]) test('dismissal remains measured after its visible dialog disappears: ' + action, async t => {
  const { page } = syntheticPage(t, '<main><section role="dialog"><button id="dismiss" onclick="' + action + '">Dismiss</button></section></main>');
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

test('hidden rendering and unrelated visible timers cannot credit a dead control', async t => {
  const { page, window } = syntheticPage(t, '<main><button id="dead" onclick="document.querySelector(\'#hidden\').textContent=\'Changed\'">Dead</button><output id="visible"></output><output id="hidden" hidden></output></main>');
  window.setTimeout(() => { window.document.querySelector('#visible').textContent = 'Unrelated'; }, 10);
  const result = await pressControl(page, { selector: '#dead', role: 'button' }, { waitMs: 30 });
  assert.equal(result.status, 'DEAD');
  assert.deepEqual(result.signals, []);
});
