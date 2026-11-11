import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import * as proof from '../scripts/prove-calendar-meeting-end-time.mjs';
const { prove } = proof;

test('acceptance recordings retain producer timestamps and response flags', () => {
  assert.ok(proof.calendarRecordings, 'producer-recorded calendar responses are required');
  const { provenance, records } = proof.calendarRecordings;
  assert.equal(provenance.function, 'calendarSection');
  assert.match(provenance.source_commit, /^[a-f0-9]{40}$/);
  assert.match(provenance.source_sha256, /^[a-f0-9]{64}$/);
  assert.equal(records.length, 12);
  for (const { response } of records) {
    assert.equal(response.source, 'outlook_local_store');
    assert.equal(response.malformed_items, undefined);
    assert.ok(Array.isArray(response.notes));
    for (const item of response.items) {
      for (const key of ['start', 'end']) assert.match(item[key], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      for (const key of ['all_day', 'time_changed', 'schedule_conflict']) assert.equal(typeof item[key], 'boolean');
      assert.equal(item.schedule_conflict, item.schedule_conflicts.length > 0);
    }
  }
});
const exec = promisify(execFile);

test('proof CLI accepts a working-tree fixture and rejects a broken deployed module', async t => {
  const out = temporaryDirectory('meeting-proof-cli-');
  t.after(() => rm(out, { recursive: true, force: true }));
  await buildArtifact({ root: process.cwd(), outDir: out });
  const args = ['scripts/prove-calendar-meeting-end-time.mjs', '--fixture-root', join(out, 'site')];
  const pass = await exec(process.execPath, args);
  const receipt = JSON.parse(pass.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.evidence, 'local_fixture');
  assert.equal(receipt.production_acceptance, 'insufficient_evidence');
  assert.equal(receipt.observations.length, 4);
  const engine = { async launch(options) {
    const browser = await chromium.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])] });
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...args) => {
      const page = await newPage(...args);
      const evaluate = page.evaluate.bind(page);
      page.evaluate = async (fn, arg) => {
        if (fn === proof.observe) await evaluate(() => {
          const NativeObserver = window.ResizeObserver;
          window.ResizeObserver = class extends NativeObserver {
            constructor(callback) {
              super((entries, observer) => setTimeout(() => callback(entries, observer), 100));
            }
          };
        });
        return evaluate(fn, arg);
      };
      return page;
    };
    return browser;
  } };
  const delayedResize = await prove({ fixtureRoot: join(out, 'site'), engine });
  assert.ok(delayedResize.observations.every(observation => observation.checks.every(check => check.pass)),
    'resize assertions wait for layout delivery when resize callbacks arrive after animation frames');
  await writeFile(join(out, 'site/js/ui-calendar-panels.generated.js'), 'export async function mountCalendarPanels() { throw Error("broken fixture module"); }');
  await assert.rejects(exec(process.execPath, args), error => {
    assert.equal(error.code, 1);
    assert.match(JSON.parse(error.stdout).error, /broken fixture module/);
    return true;
  });
});

for (const mode of ['stalled evaluation', 'late launch']) test(`proof closes acquired browser after ${mode}`, async t => {
  const root = temporaryDirectory('meeting-proof-timeout-');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'js'), { recursive: true });
  await writeFile(join(root, 'js/ui-calendar-panels.generated.js'), '');
  t.after(() => rm(root, { recursive: true, force: true }));
  let owned, acquisition, evaluating = false;
  t.after(async () => { await acquisition?.catch(() => {}); await owned?.close(); });
  const engine = { launch(options) {
    acquisition = (async () => {
      owned = await chromium.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS], timeout: 10000 });
      if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 100));
      else {
        const newPage = owned.newPage.bind(owned);
        owned.newPage = async (...args) => {
          const page = await newPage(...args);
          page.evaluate = () => { evaluating = true; return new Promise(() => {}); };
          return page;
        };
      }
      return owned;
    })();
    return acquisition;
  } };
  await assert.rejects(prove({ fixtureRoot: root, timeoutMs: mode === 'late launch' ? 40 : 3000, engine }), error => error.exitCode === 78);
  await acquisition;
  await new Promise(resolve => setTimeout(resolve, 100));
  if (mode === 'stalled evaluation') assert.equal(evaluating, true);
  assert.equal(owned.isConnected(), false, 'zero surviving owned browser processes');

});

test('endpoint CLI admits only equal or descendant releases with complete evidence', async t => {
  const root = temporaryDirectory('meeting-release-', t);
  await buildArtifact({ root: process.cwd(), outDir: root });
  const { startFixture } = await import('../scripts/fixture-http.mjs');
  const { appAssetSnapshot } = await import('../scripts/fixture-app-assets.mjs');
  const assets = await appAssetSnapshot(join(root, 'site'));
  const script = join(process.cwd(), 'scripts/prove-calendar-meeting-end-time.mjs');
  const git = async (...args) => (await exec('git', args, { cwd: root })).stdout.trim();
  await git('init', '-q');
  const tree = await git('hash-object', '-w', '-t', 'tree', '/dev/null');
  const commit = async (message, parent) => (await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], { cwd: root })).stdout.trim();
  const older = await commit('older');
  const expected = await commit('expected', older);
  const descendant = await commit('descendant', expected);
  const unrelated = await commit('unrelated');
  const run = async args => {
    try { return { code: 0, ...await exec(process.execPath, [script, ...args], { cwd: root, timeout: 45000 }) }; }
    catch (error) { return error; }
  };
  for (const [name, source, code] of [['equal', expected, 0], ['descendant', descendant, 0], ['older', older, 78], ['unrelated', unrelated, 78], ['unknown', '1'.repeat(40), 78], ['missing identity', null, 78]]) {
    await t.test(name, async () => {
      const fixture = await startFixture({ assets, routes: new Map([['/app-release', { contentType: 'application/json', body: JSON.stringify(source ? { service: 'doctorcre-app', environment: 'production', source_commit: source } : {}) }]]) });
      try {
        const result = await run(['--origin', fixture.origin, '--expected-commit', expected]);
        assert.equal(result.code, code, result.stdout);
        const receipt = JSON.parse(result.stdout);
        assert.equal(receipt.ok, code === 0);
        if (code === 0) assert.equal(receipt.observations.length, 4);
        else assert.equal(fixture.requests.some(request => request.target.startsWith('/js/')), false, 'refuse before browser evidence');
      } finally { await fixture.close(); }
    });
  }
  await t.test('expected commit is required', async () => {
    assert.equal((await run(['--origin', 'http://127.0.0.1:1'])).code, 78);
  });
  await t.test('all arguments are parsed in either order', async () => {
    const fixture = await startFixture({ assets, routes: new Map([['/app-release', { contentType: 'application/json', body: JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: expected }) }]]) });
    try {
      assert.equal((await run(['--expected-commit', expected, '--origin', fixture.origin])).code, 0);
      assert.equal((await run(['--origin', fixture.origin, '--expected-commit', expected, '--unknown', 'value'])).code, 1);
    } finally { await fixture.close(); }
  });
  await t.test('release reads and browser work share one deadline', async () => {
    const release = { contentType: 'application/json', body: JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: expected }) };
    for (const routes of [
      new Map([['/app-release', { ...release, hold: 'release' }]]),
      new Map([['/app-release', { sequence: [release, { ...release, hold: 'after' }] }]]),
    ]) {
      const fixture = await startFixture({ assets, routes });
      try {
        const result = await run(['--origin', fixture.origin, '--expected-commit', expected, '--timeout-ms', '5000']);
        assert.equal(result.code, 78, result.stdout);
        if (routes.get('/app-release').sequence) assert.equal(fixture.requests.filter(request => request.target === '/app-release').length, 2);
      } finally { await fixture.close(); }
    }
  });
  await t.test('changed release cannot prove a stable deployment', async () => {
    const identity = source_commit => ({ contentType: 'application/json', body: JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit }) });
    const fixture = await startFixture({ assets, routes: new Map([['/app-release', { sequence: [identity(expected), identity(descendant)] }]]) });
    try { assert.equal((await run(['--origin', fixture.origin, '--expected-commit', expected])).code, 78); }
    finally { await fixture.close(); }
  });
  await t.test('containing release with broken asset is an assertion failure', async () => {
    const broken = new Map(assets);
    broken.set('/js/ui-calendar-panels.generated.js', { contentType: 'text/javascript', body: 'export async function mountCalendarPanels() { throw Error("broken contained module"); }' });
    const fixture = await startFixture({ assets: broken, routes: new Map([['/app-release', { contentType: 'application/json', body: JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: expected }) }]]) });
    try {
      const result = await run(['--origin', fixture.origin, '--expected-commit', expected]);
      assert.equal(result.code, 1);
      assert.match(JSON.parse(result.stdout).error, /broken contained module/);
    } finally { await fixture.close(); }
  });
});
