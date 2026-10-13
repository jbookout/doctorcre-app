import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RUN_LIMITS, RunLimitError, directoryBytes, openRun } from '../../scripts/e2e-staging/run-limits.mjs';
import { writeReport } from '../../scripts/e2e-staging/report.mjs';
import { evidenceCapture, publishScreenshot } from '../../scripts/e2e-staging/evidence.mjs';
import { createSweepRun } from '../../scripts/e2e-staging/resume.mjs';
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

// Measured on the fixture app's Home screen at 1440x960: the full-page PNG the
// sweep used to keep for every press, and the viewport JPEG it keeps now.
const HOME_FULL_PAGE_PNG = 1_071_825, HOME_VIEWPORT_JPEG = 69_388;
// The 2026-10-12 staging run kept 49 files: one Home control per screenshot pair.
const HOME_CONTROLS = 41;

const release = { service: 'doctorcre-app', environment: 'staging', source_commit: 'a'.repeat(40), carr_source_commit: contract.producer.source_commit };
const code = expected => error => error instanceof RunLimitError && error.code === expected;
const row = index => ({ key: `staging-live///${index.toString(16).padStart(16, '0')}`, target: 'staging-live', path: '/', screen: 'Home and Dr. CRE',
  selector: `main [data-synthetic="${index}"]`, role: 'button', name: `Synthetic control ${index}`, openers: [], signals: ['dom'], status: 'OBSERVED' });
const homeScreen = controls => ({ name: 'Home and Dr. CRE', path: '/', surface: 'app', target: 'staging-live', reached: true, in_progress: true, controls });
const fakePage = () => {
  const calls = [];
  return { calls, screenshot: async options => { calls.push(options); return Buffer.alloc(options?.type === 'jpeg' ? HOME_VIEWPORT_JPEG : HOME_FULL_PAGE_PNG, 7); } };
};

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'doctorcre-evidence-bytes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = openRun(root, { limits: { ...RUN_LIMITS, ...overrides }, runId: 'synthetic-evidence-bytes', events: null });
  t.after(() => run.dispose());
  return { root, run };
}

test('passing evidence is a viewport JPEG; only failures keep the full-page PNG', () => {
  for (const status of ['OBSERVED', 'DISABLED']) {
    const capture = evidenceCapture(status);
    assert.equal(capture.extension, 'jpg');
    assert.equal(capture.options.type, 'jpeg');
    assert.ok(!capture.options.fullPage, `${status} must not capture the full page`);
    assert.ok(capture.options.quality <= 50);
  }
  for (const status of ['DEAD', 'ERROR', 'UNREACHABLE'])
    assert.deepEqual(evidenceCapture(status), { extension: 'png', options: { fullPage: true } });
  const sweep = createSweepRun({ targets: [{ name: 'staging-live', surface: 'app' }], routedScreens: [{ path: '/', name: 'Home and Dr. CRE', surface: 'app' }] });
  assert.match(sweep.evidencePaths('/synthetic/output', '/synthetic/private', 'OBSERVED').publishedFile, /\.jpg$/);
  assert.match(sweep.evidencePaths('/synthetic/output', '/synthetic/private', 'DEAD').publishedFile, /\.png$/);
});

test('a published screenshot is charged once and retained once', async t => {
  const { root, run } = await fixture(t);
  const sweep = createSweepRun({ targets: [{ name: 'staging-live', surface: 'app' }], routedScreens: [{ path: '/', name: 'Home and Dr. CRE', surface: 'app' }] });
  const page = fakePage(), before = run.snapshot().artifactBytes, beforeDisk = directoryBytes(root);
  const published = await publishScreenshot({ page, budget: run, paths: sweep.evidencePaths(root, join(root, 'private', 'screenshots'), 'OBSERVED') });
  assert.deepEqual(page.calls, [{ type: 'jpeg', quality: 40 }]);
  assert.equal((await stat(published)).size, HOME_VIEWPORT_JPEG);
  // The ledger first absorbs any retained bytes (its own run-budget.json), then charges the capture once.
  assert.equal(run.snapshot().artifactBytes, Math.max(before, beforeDisk) + HOME_VIEWPORT_JPEG, 'charged once');
  assert.equal(directoryBytes(join(root, 'evidence')), HOME_VIEWPORT_JPEG);
  assert.equal(directoryBytes(join(root, 'private')), 0, 'no private copy is retained');
});

test('unchanged checkpoint rewrites add no artifact bytes', async t => {
  const { root, run } = await fixture(t);
  const screens = [homeScreen(Array.from({ length: 200 }, (_, index) => row(index)))];
  await writeReport(root, { run, release, screens, expectedScreens: 1 });
  const charged = run.snapshot().artifactBytes, checkpoint = (await stat(join(root, 'controls.json'))).size;
  for (let index = 0; index < 20; index++) await writeReport(root, { run, release, screens, expectedScreens: 1 });
  // The live directory briefly holds the staged and retained checkpoint, which the
  // ledger absorbs once; coverage.md's measurement time drifts a few bytes per rewrite.
  // Charging every rewrite in full would cost 20 checkpoints here.
  assert.ok(run.snapshot().artifactBytes - charged < checkpoint + 20 * 64, `20 rewrites of a ${checkpoint}-byte checkpoint charged ${run.snapshot().artifactBytes - charged} bytes`);
});

test('a replacement is charged its growth and cannot exceed the ceiling', async t => {
  const { root, run } = await fixture(t, { artifactBytes: 64 * 1024, artifactMetadataBytes: 1_024 });
  const target = join(root, 'checkpoint.json'), stage = join(root, 'stage.json');
  await run.writeFile(target, 'x'.repeat(10_000), writeFile);
  const charged = run.snapshot().artifactBytes;
  await run.writeFile(stage, 'y'.repeat(12_000), writeFile, { replaces: target });
  const growth = run.snapshot().artifactBytes - charged;
  assert.ok(growth >= 2_000 && growth < 2_000 + 1_024, `replacement charged ${growth} bytes`);
  await assert.rejects(run.writeFile(stage, 'z', writeFile, { replaces: join(tmpdir(), 'outside.json') }), code('artifact-path-refused'));
  await assert.rejects(run.writeFile(join(root, 'next.json'), 'z'.repeat(64 * 1024), writeFile, { replaces: stage }), code('artifact-byte-limit'));
});

test('a Home screen of measured controls finishes inside the artifact ceiling', async t => {
  const { root, run } = await fixture(t);
  const sweep = createSweepRun({ targets: [{ name: 'staging-live', surface: 'app' }], routedScreens: [{ path: '/', name: 'Home and Dr. CRE', surface: 'app' }] });
  const page = fakePage(), controls = [];
  for (let index = 0; index < HOME_CONTROLS; index++) {
    const control = row(index);
    control.evidence_path = await publishScreenshot({ page, budget: run, paths: sweep.evidencePaths(root, join(root, 'private', 'screenshots'), control.status) });
    controls.push(control);
    await writeReport(root, { run, release, screens: [homeScreen(controls)], expectedScreens: 1 });
  }
  const state = run.snapshot();
  assert.equal(state.stopReason, null);
  // Before this change each press charged two full-page PNGs plus every report rewrite (about 2.2 MB) and stopped near 30 presses.
  assert.ok(state.artifactBytes / HOME_CONTROLS < 1.2 * HOME_VIEWPORT_JPEG, `${Math.round(state.artifactBytes / HOME_CONTROLS)} bytes per press`);
  assert.equal(JSON.parse(await readFile(join(root, 'controls.json'), 'utf8')).screens[0].controls.length, HOME_CONTROLS);
});
