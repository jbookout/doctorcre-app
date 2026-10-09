import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { openDom } from '../../test/jsdom-harness.mjs';
import { sweepScreen, SweepFailure } from '../../scripts/e2e-staging/controls.mjs';
import { createSweepRun } from '../../scripts/e2e-staging/resume.mjs';
import { RunLimitError } from '../../scripts/e2e-staging/run-limits.mjs';

// A DOM adapter for the browser boundary. No network or layout assertion runs.
function domPage(path) {
  const dom = openDom('<main><button id="morningClose" onclick="this.hidden=true">Dismiss morning brief</button><button id="later" onclick="document.querySelector(\'output\').textContent=\'Pressed\'">Later control</button><output></output></main>', {
    url: 'https://fixture.example.test' + path, runScripts: 'dangerously', pretendToBeVisual: true,
  });
  const { window } = dom;
  window.CSS = { escape: value => value };
  window.Element.prototype.checkVisibility = function () { return !this.closest('[hidden],[inert]'); };
  window.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 });
  const evaluate = async (fn, arg, all = false) => {
    window.argument = arg;
    try { return window.eval(`(${fn})(${all ? 'window.elements,' : ''}window.argument)`); }
    finally { delete window.argument; delete window.elements; }
  };
  const page = new EventEmitter();
  return Object.assign(page, {
    url: () => window.location.href, isClosed: () => false,
    context: () => ({ close: async () => window.close() }),
    evaluate, waitForLoadState: async () => {},
    waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, ms)),
    locator: selector => ({
      evaluateAll: (fn, arg) => {
        window.elements = [...window.document.querySelectorAll(selector)];
        return evaluate(fn, arg, true);
      },
      count: async () => window.document.querySelectorAll(selector).length,
      isVisible: async () => window.document.querySelector(selector)?.checkVisibility(),
      focus: async () => window.document.querySelector(selector).focus(),
      click: async () => window.document.querySelector(selector).click(),
    }),
  });
}

test('an unproved morning dismiss retains its ERROR and continues later controls on all three run-3 screens', async () => {
  for (const path of ['/', '/control-room', '/deals']) {
    const captured = [], screen = { path, name: 'Synthetic morning brief', surface: 'app' };
    const result = await sweepScreen({ screen, target: 'desktop', waitMs: 20, freshPage: async () => domPage(path),
      evidence: async (_page, row) => {
        captured.push(row.selector);
        if (row.selector === '#morningClose') throw new SweepFailure('fixture-scope', 'write-scope-unproved');
        return 'synthetic.png';
      },
    });
    assert.deepEqual(captured, ['#morningClose', '#later']);
    assert.equal(result.failure, null);
    assert.equal(result.controls[0].status, 'ERROR');
    assert.deepEqual(result.controls[0].failure, { phase: 'fixture-scope', code: 'write-scope-unproved' });
    assert.equal(result.controls[1].status, 'OBSERVED');
    const run = createSweepRun({ targets: [{ name: 'desktop', surface: 'app' }], routedScreens: [screen] });
    run.record(result);
    assert.equal(run.verdict([]).completed, false, 'continuing cannot erase an unproved control');
  }
});

test('a leads measurement navigation stopped by the request ceiling retains the run-limit reason', async () => {
  let opened = 0;
  const result = await sweepScreen({ screen: { path: '/leads', name: 'Synthetic leads', surface: 'app' }, target: 'desktop', waitMs: 20,
    freshPage: async () => {
      if (opened++) throw new RunLimitError('http-request-limit');
      return domPage('/leads');
    },
  });
  assert.equal(opened, 2, 'no replacement measurement is started after the limit');
  assert.equal(result.reached, true, 'the inventory document was reached before the ceiling');
  assert.equal(result.controls.length, 0);
  assert.equal(result.failure.phase, 'run-limit');
  assert.equal(result.failure.code, 'http-request-limit');
});
