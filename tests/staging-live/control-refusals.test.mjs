import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { openDom } from '../../test/jsdom-harness.mjs';
import { sweepScreen, SweepFailure, inventory } from '../../scripts/e2e-staging/controls.mjs';
import { createSweepRun } from '../../scripts/e2e-staging/resume.mjs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stagingFixtureWriteGuard } from '../../scripts/e2e-staging/records.mjs';
import { installStagingGuard, stagingWriteRefusals } from '../../scripts/e2e-staging/engine.mjs';
import * as sweepCaller from '../../scripts/e2e-staging/sweep.mjs';
import { STAGING_ORIGIN } from '../../scripts/e2e-staging/session.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import { RunLimitError } from '../../scripts/e2e-staging/run-limits.mjs';

// A DOM adapter for the browser boundary. No network or layout assertion runs.
function domPage(path, { context, handlers = [], nested = false } = {}) {
  const dom = openDom('<main><button id="morningClose" onclick="this.hidden=true">Dismiss morning brief</button><button id="later" onclick="document.querySelector(\'output\').textContent=\'Pressed\'">Later control</button><output></output></main>', {
    url: STAGING_ORIGIN + path, runScripts: 'dangerously', pretendToBeVisual: true,
  });
  const { window } = dom;
  for (const button of window.document.querySelectorAll('button')) button.addEventListener('click', () => handlers.push(button.id));
  if (nested) {
    window.document.querySelector('#later').onclick = () => {
      window.document.querySelector('output').textContent = 'Pressed';
      if (!window.document.querySelector('#nested')) {
        const child = window.document.createElement('button'); child.id = 'nested'; child.textContent = 'Nested';
        child.onclick = () => { handlers.push('nested'); child.textContent = 'Done'; };
        window.document.querySelector('main').append(child);
      }
    };
  }
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
    context: () => context || ({ close: async () => window.close() }),
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

async function fixture(t) {
  const output = await mkdtemp(join(tmpdir(), 'staging-control-scope-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const release = { source_commit: 'a'.repeat(40), carr_source_commit: contract.producer.source_commit };
  const path = join(output, 'staging-records-plan.json');
  await writeFile(path, JSON.stringify({ schema: 'doctorcre-staging-records-plan.v1', origin: STAGING_ORIGIN,
    state: 'complete', run: '40000000-0000-4000-8000-000000000001', release, records: {}, receipts: {} }), { mode: 0o600 });
  return { guard: stagingFixtureWriteGuard({ output, release, run: null, persist: (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 }) }), read: async () => JSON.parse(await readFile(path, 'utf8')),
    update: async edit => {
      const plan = JSON.parse(await readFile(path, 'utf8')); edit(plan);
      await writeFile(path, JSON.stringify(plan), { mode: 0o600 });
    },
    proveLocal: async (page, selectors) => {
      // These synthetic handlers only change the local DOM. The private plan,
      // not a page-provided label, supplies the reviewed effect declaration.
      const plan = JSON.parse(await readFile(path, 'utf8'));
      plan.browser_control_proofs ||= [];
      for (const control of await inventory(page)) if (selectors.includes(control.selector)) {
        plan.browser_control_proofs = plan.browser_control_proofs.filter(proof => proof.identity !== control.identity);
        plan.browser_control_proofs.push({ identity: control.identity, effects: [] });
      }
      await writeFile(path, JSON.stringify(plan), { mode: 0o600 });
    } };
}
async function guardedContext(guard) {
  const context = { close: async () => {}, addInitScript: async () => {}, route: async (_pattern, handler) => { context.dispatch = handler; } };
  await installStagingGuard(context, guard);
  context.refuse = () => context.dispatch({ request: () => ({ url: () => STAGING_ORIGIN + '/mcp', method: () => 'POST',
    postDataJSON: () => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'unsupported-operation', arguments: {} } }) }),
    fetch: () => assert.fail('unsupported operation must not forward'), fulfill: () => assert.fail('must abort'), abort: async () => {} });
  return context;
}

test('production admission skips an unproved context before handlers, while later controls retain evidence and nested discovery', async t => {
  const { guard, read, proveLocal } = await fixture(t);
  for (const path of ['/', '/control-room', '/deals']) {
    let opened = 0;
    const handlers = [], captured = [], screen = { path, name: 'Synthetic morning brief', surface: 'app' };
    const result = await sweepScreen({ screen, target: 'desktop', waitMs: 20,
      freshPage: async () => {
        const context = await guardedContext(guard);
        // The first measurement cannot prove its bootstrap operation. Inventory
        // and subsequent contexts are clean; the aggregate retains this refusal.
        if (++opened === 2) await context.refuse();
        const page = domPage(path, { context, handlers, nested: true });
        await proveLocal(page, ['#later']);
        const click = page.locator;
        page.locator = selector => {
          const locator = click(selector), press = locator.click;
          locator.click = async () => { await press(); await proveLocal(page, ['#later', '#nested']); };
          return locator;
        };
        return page;
      },
      admit: sweepCaller.assertSweepFixtureScope,
      evidence: async (page, row) => {
        await sweepCaller.assertSweepFixtureScope(page);
        assert.equal(row.status, 'OBSERVED');
        captured.push(row.selector); return 'synthetic.png';
      },
    });
    assert.equal(handlers.filter(id => id === 'morningClose').length, 0);
    assert.ok(handlers.includes('later'));
    assert.ok(handlers.includes('nested'));
    assert.ok(captured.includes('#later'));
    assert.ok(captured.includes('#nested'));
    assert.ok(!captured.includes('#morningClose'));
    assert.equal(result.failure, null);
    assert.equal(result.controls[0].status, 'ERROR');
    assert.deepEqual(result.controls[0].failure, { phase: 'fixture-scope', code: 'write-scope-unproved' });
    assert.equal(result.controls[1].evidence_path, 'synthetic.png');
    const run = createSweepRun({ targets: [{ name: 'desktop', surface: 'app' }], routedScreens: [screen] });
    run.record(result); assert.equal(run.verdict([]).completed, false);
    await assert.rejects(guard.assertCoverage(), /write-coverage-incomplete/);
  }
  assert.ok((await read()).browser_write_refusals.length >= 3);
});

test('production admission refuses an unsupported handler before it runs and retains later and nested observations', async t => {
  const { guard, read, proveLocal } = await fixture(t);
  const captured = [], handlers = [], clicks = [];
  let opened = 0;
  const result = await sweepScreen({ screen: { path: '/', name: 'Synthetic', surface: 'app' }, target: 'desktop', waitMs: 20,
    freshPage: async () => {
      const context = await guardedContext(guard);
      const page = domPage('/', { context, handlers, nested: true });
      await proveLocal(page, ['#later']);
      const measurement = ++opened;
      const locator = page.locator;
      page.locator = selector => {
        const current = locator(selector), click = current.click;
        current.click = async () => {
          clicks.push({ measurement, selector });
          await click();
          if (selector === '#morningClose') await context.refuse();
          await proveLocal(page, ['#later', '#nested']);
        };
        return current;
      };
      return page;
    }, admit: sweepCaller.assertSweepFixtureScope,
    evidence: async (page, row) => { await sweepCaller.assertSweepFixtureScope(page); captured.push(row.selector); return 'synthetic.png'; },
  });
  assert.equal(handlers.filter(id => id === 'morningClose').length, 0);
  assert.equal(clicks.filter(row => row.measurement === 2).length, 0);
  assert.equal(clicks.filter(row => row.measurement === 3 && row.selector === '#later').length, 1);
  assert.ok(handlers.includes('later'));
  assert.ok(handlers.includes('nested'));
  assert.equal(result.controls[0].status, 'ERROR');
  assert.equal(result.controls[0].evidence_path, undefined);
  assert.equal(result.controls[1].status, 'OBSERVED');
  assert.equal(result.controls[1].evidence_path, 'synthetic.png');
  assert.ok(captured.includes('#nested'));
  assert.equal(result.failure, null);
  assert.ok((await read()).browser_write_refusals.length >= 1);
  await assert.rejects(guard.assertCoverage(), /write-coverage-incomplete/);
});

test('context refusal readers use the guard history, including bounded operation metadata', async t => {
  const { guard, read } = await fixture(t), context = await guardedContext(guard);
  await context.refuse();
  assert.deepEqual(stagingWriteRefusals(context), (await read()).browser_write_refusals);
});

test('an opener whose prospective proof was withdrawn runs no replay handler and preserves the traversal failure', async t => {
  const { guard, proveLocal, update } = await fixture(t);
  const handlers = [];
  let opened = 0;
  const result = await sweepScreen({ screen: { path: '/', name: 'Synthetic', surface: 'app' }, target: 'desktop', waitMs: 20,
    freshPage: async () => {
      const context = await guardedContext(guard);
      if (++opened > 2) await update(plan => { plan.browser_control_proofs = []; });
      const page = domPage('/', { context, handlers, nested: true });
      // Only the local opener participates in this traversal.
      await page.evaluate(() => document.querySelector('#morningClose').remove());
      if (opened <= 2) await proveLocal(page, ['#later']);
      return page;
    }, admit: sweepCaller.assertSweepFixtureScope,
  });
  assert.deepEqual(handlers, ['later']);
  assert.equal(result.failure.phase, 'fixture-scope');
  assert.equal(result.failure.code, 'write-scope-unproved');
  assert.ok(result.traversal);
});

test('control admission validates prospective effects against fixture ownership without dispatch or intent', async t => {
  const deal = '40000000-0000-4000-8000-000000000010';
  const args = { deal, text: 'Synthetic note', idempotency_key: '40000000-0000-4000-8000-000000000011' };
  for (const kind of ['local', 'read', 'write', 'unsupported', 'foreign', 'shape', 'duplicate', 'missing', 'source']) {
    await t.test(kind, async t => {
      const { guard, read, update } = await fixture(t), context = await guardedContext(guard);
      const page = domPage('/', { context });
      t.after(() => page.evaluate(() => window.close()));
      const control = (await inventory(page))[0];
      await update(plan => {
        plan.records.deal = { id: deal }; plan.receipts.deal = { deal_id: deal };
        const effects = kind === 'local' ? [] : kind === 'read' ? [{ operation: 'morning-brief', arguments: {} }]
          : [{ operation: kind === 'unsupported' ? 'unsupported-operation' : 'add-deal-note', arguments: {
            ...args, ...(kind === 'foreign' ? { deal: '40000000-0000-4000-8000-000000000012' } : {}),
            ...(kind === 'shape' ? { unexpected: true } : {}),
          } }];
        plan.browser_control_proofs = [{ identity: control.identity, effects }];
        if (kind === 'duplicate') plan.browser_control_proofs.push(plan.browser_control_proofs[0]);
        if (kind === 'missing') delete plan.browser_control_proofs;
        if (kind === 'source') plan.release.source_commit = 'b'.repeat(40);
      });
      if (['local', 'read', 'write'].includes(kind)) {
        await sweepCaller.assertSweepFixtureScope(page, control);
        await guard.assertCoverage();
      } else {
        await assert.rejects(sweepCaller.assertSweepFixtureScope(page, control), error => error.failure?.code === 'write-scope-unproved');
        await assert.rejects(guard.assertCoverage());
        assert.equal(stagingWriteRefusals(context).length, kind === 'source' ? 0 : 1);
      }
      const plan = await read();
      assert.equal(plan.browser_write_attempts?.length || 0, 0, 'admission must not consume a write key or dispatch');
      assert.equal(plan.browser_write_refusals?.some(row => row.forwarded) || false, false);
    });
  }
});

test('an exact plan proof cannot admit a control after its live identity changes', async t => {
  const { guard, proveLocal } = await fixture(t), context = await guardedContext(guard);
  const page = domPage('/', { context });
  t.after(() => page.evaluate(() => window.close()));
  await proveLocal(page, ['#later']);
  const control = (await inventory(page)).find(row => row.selector === '#later');
  await page.evaluate(() => document.querySelector('#later').textContent = 'Changed action');
  await assert.rejects(sweepCaller.assertSweepFixtureScope(page, control), error => error.failure?.code === 'write-scope-unproved');
});

test('production scope refusal returns a bounded failure without changing the evidence row', async t => {
  const { guard } = await fixture(t), context = await guardedContext(guard);
  await context.refuse();
  const row = { status: 'OBSERVED', reason: null };
  await assert.rejects(() => sweepCaller.assertSweepFixtureScope({ context: () => context }, row), error => {
    assert.ok(error instanceof SweepFailure); return true;
  });
  assert.deepEqual(row, { status: 'OBSERVED', reason: null });
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
