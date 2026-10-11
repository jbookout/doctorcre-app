import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { openDom } from '../../test/jsdom-harness.mjs';
import { mountMorningBrief } from '../../js/morning-brief.js';
import { prepareStagingRecords, stagingFixtureWriteGuard } from '../../scripts/e2e-staging/records.mjs';
import { sweepScreen } from '../../scripts/e2e-staging/controls.mjs';
import { sweep, assertSweepFixtureScope } from '../../scripts/e2e-staging/sweep.mjs';
import { installStagingGuard } from '../../scripts/e2e-staging/engine.mjs';
import { readSweepCheckpoint } from '../../scripts/e2e-staging/resume.mjs';
import { currentRun } from '../../scripts/e2e-staging/run-limits.mjs';
import { admitFixtureRun } from './fixture-admission.mjs';
import { STAGING_ORIGIN } from '../../scripts/e2e-staging/session.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

import { fakeAPI } from './record-fixture.mjs';
const checkout = fileURLToPath(new URL('../../', import.meta.url));
const release = { service: 'doctorcre-app', environment: 'staging', source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), carr_source_commit: contract.producer.source_commit };

// Browser seam adapter only. The safe handler comes from the actual app module.
async function morningPage(guard, counters) {
  const { window } = openDom('<button id="docMorning" hidden></button><button id="docOpen" hidden></button><nav><button id="unsupported">Unsupported operation</button></nav>', { url: STAGING_ORIGIN + '/', pretendToBeVisual: true, runScripts: 'dangerously' });
  window.CSS = { escape: value => value };
  window.Element.prototype.checkVisibility = function () { return !this.closest('[hidden],[inert],dialog:not([open])'); };
  window.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 });
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  const brief = mountMorningBrief({ document: window.document, window, automatic: false, getClient: async () => { throw new Error('Synthetic offline read'); } });
  const dialog = window.document.querySelector('#docMorningBrief');
  dialog.showModal();
  window.document.querySelector('#morningClose').addEventListener('click', () => counters.safe++);
  window.document.querySelector('#unsupported').onclick = () => counters.unsupported++;
  const context = { route: async () => {}, addInitScript: async () => {}, close: async () => { brief.dispose(); window.close(); } };
  await installStagingGuard(context, guard);
  const evaluate = async (fn, arg) => window.eval('(' + fn.toString() + ')')(arg);
  return Object.assign(new EventEmitter(), {
    context: () => context, url: () => window.location.href, isClosed: () => false,
    screenshot: async () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1sAAAAASUVORK5CYII=', 'base64'),
    evaluate, waitForLoadState: async () => {}, waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, ms)),
    locator: selector => ({
      evaluateAll: async (fn, arg) => window.eval('(' + fn.toString() + ')')([...window.document.querySelectorAll(selector)], arg),
      count: async () => window.document.querySelectorAll(selector).length,
      isVisible: async () => window.document.querySelector(selector)?.checkVisibility(),
      focus: async () => window.document.querySelector(selector).focus(),
      click: async () => window.document.querySelector(selector).click(),
    }),
  });
}

test('production record preparation admits the reviewed app handler into the screen sweep and refuses unsupported handlers', async t => {
  admitFixtureRun(t);
  assert.equal(release.source_commit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), 'synthetic release uses the checkout HEAD, including depth-1 clones');
  const output = await mkdtemp(join(tmpdir(), 'staging-prepared-control-proofs-'));
  const previous = { E2E_V2_OUTPUT: process.env.E2E_V2_OUTPUT, E2E_RUN_ID: process.env.E2E_RUN_ID };
  process.env.E2E_V2_OUTPUT = output; process.env.E2E_RUN_ID = 'synthetic-proof-preparation';
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const run = currentRun(output);
  t.after(async () => { run.dispose(); await rm(output, { recursive: true, force: true }); });
  const api = fakeAPI(output, { sourceRelease: release });
  const setup = await prepareStagingRecords(output, { ...api, run });
  const guard = stagingFixtureWriteGuard({ output, release: setup.release, run });
  const counters = { safe: 0, unsupported: 0 }, captured = [];
  const result = await sweepScreen({ screen: { path: '/', name: 'Synthetic morning brief', surface: 'app' }, target: 'staging-live', waitMs: 20,
    freshPage: () => morningPage(guard, counters), admit: assertSweepFixtureScope,
    evidence: async (page, row) => { await assertSweepFixtureScope(page); captured.push(row.selector); return 'screenshots/reviewed-control.png'; },
  });
  const safe = result.controls.find(row => row.selector === '#morningClose');
  const unsupported = result.controls.find(row => row.selector === '#unsupported');
  console.log(JSON.stringify({ safe: safe?.status, safeEvidence: safe?.evidence_path ?? null, counters }));
  assert.equal(safe?.status, 'OBSERVED');
  assert.equal(safe.evidence_path, 'screenshots/reviewed-control.png');
  assert.equal(counters.safe, 1, 'the app-owned close handler executes exactly once');
  assert.ok(captured.includes('#morningClose'));
  assert.equal(unsupported?.status, 'SKIPPED');
  assert.deepEqual(unsupported.execution, { press_attempted: false, handler_executions: 0 });
  await guard.assertCoverage();
  assert.equal(unsupported?.evidence_path, undefined);
  assert.equal(counters.unsupported, 0, 'unsupported handler was never executed');
  const path = join(output, 'staging-records-plan.json');
  const prepared = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(prepared.browser_control_proof_preparation.state, 'prepared');
  assert.deepEqual(prepared.browser_control_proof_preparation.release, {
    source_commit: release.source_commit, carr_source_commit: release.carr_source_commit,
  });
  for (const kind of ['missing', 'wrong-app-source', 'wrong-carr-source', 'changed-live-identity']) await t.test(kind, async () => {
    const plan = structuredClone(prepared);
    if (kind === 'missing') plan.browser_control_proofs = [];
    if (kind === 'wrong-app-source') for (const proof of plan.browser_control_proofs) proof.release.source_commit = 'b'.repeat(40);
    if (kind === 'wrong-carr-source') for (const proof of plan.browser_control_proofs) proof.release.carr_source_commit = 'b'.repeat(40);
    await writeFile(path, JSON.stringify(plan), { mode: 0o600 });
    const denied = { safe: 0, unsupported: 0 };
    const guard = stagingFixtureWriteGuard({ output, release, run });
    const result = await sweepScreen({ screen: { path: '/', name: 'Synthetic morning brief', surface: 'app' }, target: 'staging-live', waitMs: 20,
      freshPage: async () => {
        const page = await morningPage(guard, denied);
        if (kind === 'changed-live-identity') await page.evaluate(() => document.querySelector('#morningClose').setAttribute('aria-label', 'Changed close action'));
        return page;
      }, admit: assertSweepFixtureScope,
      evidence: async () => assert.fail('refused handlers must not receive evidence'),
    });
    assert.equal(result.controls.find(row => row.selector === '#morningClose')?.status, 'SKIPPED');
    assert.deepEqual(denied, { safe: 0, unsupported: 0 });
    console.log(JSON.stringify({ kind, counters: denied }));
  });
  await t.test('sweep entrypoint prepares its own proofs and publishes evidence before the capped fixture stops', async () => {
    const unprepared = structuredClone(prepared);
    delete unprepared.browser_control_proofs; delete unprepared.browser_control_proof_preparation;
    await writeFile(path, JSON.stringify(unprepared), { mode: 0o600 });
    const counts = { safe: 0, unsupported: 0 };
    await assert.rejects(sweep({ targetName: 'staging-live', session: api.session, requestFactory: api.requestFactory,
      freshPage: async ({ screen, fixtureGuard }) => {
        if (screen.path !== '/') { run.stop('stop-signal'); run.check(); }
        return morningPage(fixtureGuard, counts);
      },
    }), /stop-signal/);
    const checkpoint = await readSweepCheckpoint(output);
    const home = checkpoint.screens.find(row => row.target === 'staging-live' && row.path === '/');
    const observed = home.controls.find(row => row.selector === '#morningClose');
    assert.equal(observed.status, 'OBSERVED');
    assert.ok(observed.evidence_path.endsWith('.png'));
    assert.ok((await readFile(observed.evidence_path)).length > 0);
    assert.equal(home.controls.find(row => row.selector === '#unsupported').status, 'SKIPPED');
    assert.deepEqual(counts, { safe: 1, unsupported: 0 });
    console.log(JSON.stringify({ entrypoint: 'sweep', counters: counts, evidence: observed.evidence_path }));
  });

});
