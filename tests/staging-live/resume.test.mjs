import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSweepRun } from '../../scripts/e2e-staging/resume.mjs';
import { writeReport, sweepFindings } from '../../scripts/e2e-staging/report.mjs';
import { persistSweepReport } from '../../scripts/e2e-staging/sweep.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40), carr_source_commit: contract.producer.source_commit };
const targets = [{ name: 'desktop', surface: 'app', viewport: { width: 1440, height: 960 } }, { name: 'phone', surface: 'app', viewport: { width: 390, height: 844 } }];
const routedScreens = [{ name: 'Home', path: '/', surface: 'app' }, { name: 'Charts', path: '/?view=charts', surface: 'app' }];
const screen = (target = 'desktop', path = '/', count = 1) => ({
  ...routedScreens.find(row => row.path === path), target, reached: true, exhausted: false, failure: null,
  controls: Array.from({ length: count }, (_, index) => ({
    key: `${target}/${path}/${String(index).padStart(16, '0')}`, target, path, screen: routedScreens.find(row => row.path === path).name,
    selector: `#control${index}`, name: `Control ${index}`, role: 'button', openers: [], status: 'OBSERVED', signals: ['main DOM mutation'], evidence_path: `/synthetic/old/${index}.png`,
  })),
});
const run = prior => createSweepRun({ targets, routedScreens, prior });

test('resume retains complete screens and archives all 99 interrupted rows when retrying', () => {
  const complete = screen(), partial = screen('desktop', '/?view=charts', 99);
  partial.failure = { phase: 'session-preflight', code: 'session-preflight-failed', openers: ['Record'] };
  const prior = { release, screens: [complete, partial] }, preserved = structuredClone(prior);
  const state = run(prior);
  state.assertRelease(release);
  assert.deepEqual(state.pending.map(({ target, screen }) => [target.name, screen.path]), [['desktop', '/?view=charts'], ['phone', '/'], ['phone', '/?view=charts']]);
  assert.equal(state.snapshot().expectedScreens, 4);
  assert.equal(state.verdict([]).completed, false);
  state.record(screen('desktop', '/?view=charts', 2));
  const snapshot = state.snapshot();
  assert.deepEqual(snapshot.screens.find(row => row.target === 'desktop' && row.path === '/'), complete);
  assert.equal(snapshot.screens.find(row => row.path === '/?view=charts').controls.length, 2);
  assert.equal(snapshot.history.length, 1);
  assert.deepEqual(snapshot.history[0], { screen: partial, findings: sweepFindings([partial]) });
  assert.equal(snapshot.history[0].screen.controls.length, 99);
  assert.equal(new Set(snapshot.screens.map(row => `${row.target}|${row.path}`)).size, snapshot.screens.length);
  assert.deepEqual(prior, preserved);
  assert.throws(() => state.record(complete), /complete screen/);
});

test('resume refuses malformed, duplicate and unknown checkpoint pairs and source drift', () => {
  const base = { release, screens: [screen()] };
  const variants = [
    {}, { ...base, screens: null }, { ...base, screens: [screen(), screen()] },
    { ...base, screens: [{ ...screen(), target: 'unknown' }] },
    { ...base, screens: [{ ...screen(), path: '/?view=unplanned' }] },
    { ...base, screens: [{ ...screen(), surface: 'board' }] },
    { ...base, screens: [{ ...screen(), reached: 'yes' }] },
    { ...base, screens: [{ ...screen(), controls: null }] },
    { ...base, screens: [{ ...screen(), controls: [{ ...screen().controls[0], status: 'UNKNOWN' }] }] },
    { ...base, screens: [{ ...screen(), controls: [...screen().controls, ...screen().controls] }] },
    { ...base, history: [{}] }, { ...base, release: { ...release, environment: 'production' } },
  ];
  for (const prior of variants) assert.throws(() => run(prior), /checkpoint/);
  const state = run(base);
  for (const current of [{ ...release, source_commit: 'b'.repeat(40) }, { ...release, carr_source_commit: 'c'.repeat(40) }, { ...release, environment: 'production' }]) assert.throws(() => state.assertRelease(current), /source pair/);
});

test('full planned union is required even when every measured pair is complete', () => {
  const routes = Array.from({ length: 30 }, (_, index) => ({ name: `Workspace ${index}`, path: `/workspace${index}`, surface: 'app' }));
  const first = { ...screen(), name: routes[0].name, path: routes[0].path, controls: [{ ...screen().controls[0], key: 'desktop//workspace0/0000000000000000', path: routes[0].path, screen: routes[0].name }] };
  const state = createSweepRun({ targets, routedScreens: routes, prior: { release, screens: [first] } });
  assert.equal(state.snapshot().expectedScreens, 60);
  assert.equal(state.snapshot().expectedExplorations, 90);
  assert.equal(state.pending.length, 59);
  assert.equal(state.verdict([]).completed, false);
});

test('historical DEAD keeps its stable allowlist key after a later successful retry', () => {
  const partial = screen();
  partial.controls[0].status = 'DEAD';
  partial.failure = { phase: 'session-preflight', code: 'session-preflight-failed', openers: [] };
  const state = run({ release, screens: [partial] });
  for (const { target, screen: planned } of state.pending) state.record(screen(target.name, planned.path));
  assert.equal(state.verdict([]).completed, true);
  assert.deepEqual(state.verdict([]).newDeadControls, [partial.controls[0].key]);
  assert.deepEqual(state.verdict([{ key: partial.controls[0].key, reason: 'Tracked synthetic DEAD' }]).newDeadControls, []);
  assert.throws(() => state.verdict([{ key: partial.controls[0].key, reason: '' }]), /reason/);
  const again = run({ release, ...state.snapshot() });
  assert.equal(again.pending.length, 0);
  assert.deepEqual(again.snapshot().history, state.snapshot().history);
  assert.deepEqual(again.verdict([]).newDeadControls, [partial.controls[0].key]);
  const deadOnly = screen(); deadOnly.controls[0].status = 'DEAD';
  assert.ok(!run({ release, screens: [deadOnly] }).pending.some(({ target, screen }) => target.name === 'desktop' && screen.path === '/'));
});

test('invocations publish disjoint control evidence while native Playwright owns traces', async t => {
  const output = await mkdtemp(join(tmpdir(), 'staging-resume-evidence-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const privateRoot = join(output, 'synthetic-private');
  await mkdir(join(output, 'evidence', 'sweep'), { recursive: true });
  const old = join(output, 'evidence', 'sweep', '00001-OBSERVED.png');
  await writeFile(old, 'Original synthetic PNG');
  const first = run().evidencePaths(output, privateRoot, 'OBSERVED');
  const second = run().evidencePaths(output, privateRoot, 'OBSERVED');
  assert.notEqual(first.png, second.png);
  assert.equal(first.trace, undefined);
  assert.equal(second.trace, undefined);
  assert.notEqual(first.publishedPNG, second.publishedPNG);
  for (const [index, paths] of [first, second].entries()) {
    await mkdir(paths.privateDir, { recursive: true }); await mkdir(paths.publicDir, { recursive: true });
    await writeFile(paths.png, `Private synthetic PNG ${index}`);
    await writeFile(paths.publishedPNG, `Scrubbed synthetic PNG ${index}`);
  }
  assert.equal(await readFile(old, 'utf8'), 'Original synthetic PNG');
  assert.equal(await readFile(first.publishedPNG, 'utf8'), 'Scrubbed synthetic PNG 0');
  assert.equal(await readFile(second.publishedPNG, 'utf8'), 'Scrubbed synthetic PNG 1');
});

test('exploration report input carries immutable resume history and the full denominator', async t => {
  const output = await mkdtemp(join(tmpdir(), 'staging-resume-explore-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const partial = screen(); partial.failure = { phase: 'load', code: 'network-idle-failed', openers: [] };
  const state = run({ release, screens: [partial] }); state.record(screen());
  const snapshot = state.snapshot();
  const explorationState = run({ release, ...snapshot }); explorationState.assertRelease(release);
  await writeReport(output, { ...explorationState.snapshot(), release, explorations: [{ target: 'desktop', screen: 'Home', agent: 'synthetic-reviewer', steps: 1, status: 'completed' }] });
  assert.equal(JSON.parse(await readFile(join(output, 'controls.json'), 'utf8')).history.length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'findings.json'), 'utf8')), snapshot.history[0].findings);
  assert.match(await readFile(join(output, 'coverage.md'), 'utf8'), /1\/4 screens reached/);
  assert.match(await readFile(join(output, 'coverage.md'), 'utf8'), /1\/6 goals attempted/);
});

test('sweep resumes retain completed model goals and findings for both pending and complete plans', async t => {
  for (const pending of [false, true]) for (const legacy of [false, true]) {
    await t.test((pending ? 'pending ' : 'complete ') + (legacy ? 'legacy' : 'canonical'), async t => {
      const output = await mkdtemp(join(tmpdir(), 'staging-retain-model-'));
      t.after(() => rm(output, { recursive: true, force: true }));
      const initial = run();
      for (const { target, screen: planned } of initial.pending) {
        const measured = screen(target.name, planned.path);
        if (pending && target.name === 'desktop' && planned.path === '/') measured.in_progress = true;
        initial.record(measured);
      }
      const goal = { target: 'desktop', screen: 'Home', agent: 'synthetic-reviewer', steps: 8, status: 'completed' };
      const finding = { id: 'model-synthetic-1', source: 'explore:synthetic-reviewer', title: 'Retained model finding', evidence_path: '/synthetic/model.png' };
      await writeReport(output, { ...initial.snapshot(), release, explorations: [goal], findings: [finding] });
      const checkpoint = JSON.parse(await readFile(join(output, 'controls.json'), 'utf8'));
      if (legacy) {
        delete checkpoint.explorations; delete checkpoint.findings;
        await writeFile(join(output, 'controls.json'), JSON.stringify(checkpoint));
      } else {
        // Derived files may be interrupted between renames; the checkpoint wins.
        await writeFile(join(output, 'explorations.json'), 'broken derived JSON');
        await writeFile(join(output, 'findings.json'), 'broken derived JSON');
      }
      const resumed = run(checkpoint);
      assert.equal(resumed.pending.length, pending ? 1 : 0);
      for (const { target, screen: planned } of resumed.pending) resumed.record(screen(target.name, planned.path));
      await persistSweepReport(output, resumed, { release, complete: true, findings: [], needs_restore: [] });
      assert.deepEqual(JSON.parse(await readFile(join(output, 'explorations.json'), 'utf8')), [goal]);
      assert.deepEqual(JSON.parse(await readFile(join(output, 'findings.json'), 'utf8')), [finding]);
      assert.match(await readFile(join(output, 'coverage.md'), 'utf8'), /1\/6 goals attempted/);
      assert.deepEqual(JSON.parse(await readFile(join(output, 'controls.json'), 'utf8')).explorations, [goal]);
      await persistSweepReport(output, resumed, { release, complete: true, findings: [], needs_restore: [] });
      assert.deepEqual(JSON.parse(await readFile(join(output, 'findings.json'), 'utf8')), [finding]);
    });
  }
});

test('incremental checkpoints retain interrupted DEAD rows without archiving every update', () => {
  const partial = screen(); partial.in_progress = true; partial.controls[0].status = 'DEAD';
  const state = run();
  state.record(partial);
  assert.equal(state.verdict([]).completed, false);
  state.record({ ...partial, controls: [...partial.controls, screen('desktop', '/', 2).controls[1]] });
  assert.equal(state.snapshot().history.length, 0);
  const interrupted = state.snapshot();
  const retry = run({ release, ...interrupted });
  assert.ok(retry.pending.some(row => row.target.name === 'desktop' && row.screen.path === '/'));
  retry.record(screen());
  const snapshot = retry.snapshot();
  assert.equal(snapshot.history.length, 1);
  assert.equal(snapshot.history[0].screen.controls.length, 2);
  assert.deepEqual(retry.verdict([]).newDeadControls, [partial.controls[0].key]);
  retry.record(screen('desktop', '/?view=charts'));
  assert.equal(retry.snapshot().history.length, 1);
});
