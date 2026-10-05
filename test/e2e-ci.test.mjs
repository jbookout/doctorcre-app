import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { github } from '@e2e-dev/github';
import { aggregateShards, runShard, publishAggregate } from '../scripts/e2e-ci.mjs';

const commit = 'a'.repeat(40);
const pair = (name) => ({ file: `tests/agent/${name}.e2e.ts`, title: name, target: 'chromium', disposition: 'run', kind: 'test' });
const plan = [pair('one'), pair('two')];
function result(name, status = 'passed', selected = true) {
  return { id: name, testId: `${pair(name).file}::${name}`, kind: 'test', declarationIndex: name === 'one' ? 0 : 1,
    titlePath: [name], file: pair(name).file, source: { file: pair(name).file, line: 1, column: 1 }, targetId: 'chromium', platform: 'web', agent: 'default', repeat: 0,
    status, selected, attempts: selected ? [{ id: `${name}-attempt`, index: 0, status, startedAt: '2026-10-05T00:00:00.000Z', durationMs: 1,
      steps: [{ id: `${name}-step`, index: 0, kind: 'agent', api: 'agent.act', label: 'fixture action', status, source: {file: pair(name).file, line: 1, column: 1}, startedAt: '2026-10-05T00:00:00.000Z', durationMs: 1, events: [], artifacts: [] }],
      artifacts: [{ id: `${name}-video`, kind: 'video', mediaType: 'video/webm', path: `${name}/video.webm`, redaction: 'not-required', producer: { kind: 'attempt' } }], secondaryErrors: [], cleanup: { status: 'passed' } }] : [] };
}
function report(shard, status = 'passed', rerun = false) {
  const name = shard === 1 ? 'one' : 'two';
  const results = plan.map(p => result(p.title, p.title === name ? status : 'skipped', p.title === name));
  return { schemaVersion: 'report-1', run: { id: `01900000-0000-7000-8000-00000000000${shard}`, specVersion: '0.1', runner: { name: 'e2e', version: '0.17.0' },
    project: { id: 'doctorcre-app', configDigest: 'b'.repeat(64) }, vcs: { commit, dirty: false }, environment: { ci: true }, targets: [{ id: 'chromium' }],
    status: status === 'passed' ? 'passed' : 'failed', exitCode: status === 'passed' ? 0 : 1,
    startedAt: '2026-10-05T00:00:00.000Z', finishedAt: `2026-10-05T00:00:0${rerun ? 2 : 1}.000Z`, results, serialGroups: [], errors: [], limits: {}, usage: { modelTokens: 2 },
    summary: { discovered: 2, selected: 1, executed: 1, passed: status === 'passed' ? 1 : 0, failed: status === 'failed' ? 1 : 0, interrupted: 0, flaky: 0, skipped: status === 'skipped' ? 1 : 0 } } };
}
const bundle = (shard) => ({ receipt: { schema: 'doctorcre-e2e-shard.v1', shard, total: 2, commit, startedAt: '2026-10-05T00:00:00.000Z', plan, selected: [plan[shard - 1]], firstExit: 0, finalExit: 0 }, first: report(shard), final: report(shard) });

test('complete disjoint shards produce one aggregate reporter call and preserve evidence paths', async () => {
  const aggregate = aggregateShards([bundle(1), bundle(2)], commit);
  assert.equal(aggregate.exitCode, 0);
  assert.equal(aggregate.lastRun.run.results.length, 2);
  assert.equal(aggregate.lastRun.run.results[0].attempts[0].artifacts[0].path, 'shard-1/artifacts/one/video.webm');
  const calls = [];
  const rows = await publishAggregate(aggregate, { onRunFinished: async (run) => { calls.push(run); return [{ label: 'GitHub', text: 'updated fixture' }]; } }, '/fixture');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].lastRun, aggregate.lastRun);
  assert.equal(rows.length, 1);
});

test('the gate rejects missing, overlapping, stale, malformed, skipped and cancelled evidence', () => {
  for (const mutate of [
    entries => entries.pop(),
    entries => { entries[1].receipt.shard = 1; },
    entries => { entries[0].first.run.vcs.commit = 'c'.repeat(40); },
    entries => { entries[0].first.run.summary.passed = 9; },
    entries => { entries[0].receipt.startedAt = '2026-10-06T00:00:00.000Z'; },
    entries => { entries[0].first.run.results = []; },
    entries => { entries[0].final.run.results[0].status = 'skipped'; },
    entries => { entries[0].receipt.finalExit = 130; },
    entries => { entries[0].receipt.error = 'Missing repository secret OPENAI_API_KEY'; delete entries[0].first; delete entries[0].final; },
    entries => { entries[0].first.run.results[0].attempts[0].artifacts[0].path = '../escape'; },
    entries => { entries[0].final.run.results[0].attempts[0].steps = []; },
    entries => { entries[0].final.run.errors.push({ category: 'test', code: 'HOOK_FAILED', message: 'fixture', phase: 'afterAll' }); },
    entries => { entries[0].final.run.carried = { results: [result('one', 'failed')], serialGroups: [], errors: [] }; },
  ]) {
    const entries = [bundle(1), bundle(2)]; mutate(entries);
    assert.notEqual(aggregateShards(entries, commit).exitCode, 0);
  }
});

test('a passed failed-test rerun remains foldable with its first failure, while unresolved debt fails', () => {
  const entries = [bundle(1), bundle(2)];
  entries[0].first = report(1, 'failed'); entries[0].receipt.firstExit = 1; entries[0].receipt.rerun = true;
  entries[0].final = report(1, 'passed', true);
  const aggregate = aggregateShards(entries, commit);
  assert.equal(aggregate.exitCode, 0);
  assert.equal(aggregate.lastRun.run.results[0].status, 'failed');
  assert.equal(aggregate.report.run.results[0].status, 'passed');
  entries[0].final.run.results[0].selected = false;
  assert.notEqual(aggregateShards(entries, commit).exitCode, 0);
});

test('a rerun cannot absorb another shard\'s tests', () => {
  const entries = [bundle(1), bundle(2)];
  entries[0].first = report(1, 'failed'); entries[0].receipt.firstExit = 1; entries[0].receipt.rerun = true;
  entries[0].final = report(1, 'passed', true);
  entries[0].final.run.results = [result('one'), result('two')];
  entries[0].final.run.summary = { discovered: 2, selected: 2, executed: 2, passed: 2, failed: 0, interrupted: 0, flaky: 0, skipped: 0 };
  assert.notEqual(aggregateShards(entries, commit).exitCode, 0);
});

test('only a test failure reruns, and rerun omits shard slicing while preserving first report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doctorcre-e2e-ci-'));
  const calls = [];
  await runShard({ shard: 1, root: directory, env: { OPENAI_API_KEY: 'synthetic-test-only', SOURCE_COMMIT: commit }, execute: async (args) => {
    calls.push(args);
    if (args[0] === 'list') return { code: 0, stdout: JSON.stringify({ pairs: args.includes('--shard') ? [plan[0]] : plan }) };
    const rerun = args.includes('--last-failed');
    await writeFile(join(directory, '.e2e/ci/shard-1/report.json'), JSON.stringify(report(1, rerun ? 'passed' : 'failed', rerun)));
    return { code: rerun ? 0 : 1 };
  } });
  const runs = calls.filter(args => args[0] === 'run');
  assert.equal(runs.length, 2);
  assert.ok(runs[0].includes('--shard'));
  assert.ok(runs[1].includes('--last-failed'));
  assert.equal(runs[1].includes('--shard'), false);
  assert.equal(JSON.parse(await readFile(join(directory, '.e2e/ci/shard-1/first.json'))).run.status, 'failed');
});

test('missing model secret fails by name before starting a test', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doctorcre-e2e-missing-secret-'));
  const receipt = await runShard({ shard: 1, root: directory, env: { SOURCE_COMMIT: commit }, execute: async args => {
    assert.equal(args[0], 'list'); return { code: 0, stdout: JSON.stringify({ pairs: args.includes('--shard') ? [plan[0]] : plan }) };
  } });
  assert.equal(receipt.finalExit, 2);
  assert.match(receipt.error, /Missing repository secret OPENAI_API_KEY/);
});

test('configuration, infrastructure and interrupt failures do not launch a failed-test rerun', async () => {
  for (const code of [2, 3, 4, 130]) {
    const directory = await mkdtemp(join(tmpdir(), 'doctorcre-e2e-no-rerun-'));
    let starts = 0;
    const receipt = await runShard({ shard: 1, root: directory, env: { OPENAI_API_KEY: 'synthetic-test-only', SOURCE_COMMIT: commit }, execute: async args => {
      if (args[0] === 'list') return { code: 0, stdout: JSON.stringify({ pairs: args.includes('--shard') ? [plan[0]] : plan }) };
      starts++;
      return { code };
    } });
    assert.equal(starts, 1);
    assert.equal(receipt.finalExit, code);
    assert.equal(receipt.rerun, undefined);
  }
});

test('the installed GitHub reporter folds reruns and updates one stable comment through its public callback', async t => {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'fixture/doctorcre', GITHUB_RUN_ID: '1', GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_WORKFLOW: 'e2e', GITHUB_JOB: 'agent-gate', GITHUB_REF: 'refs/pull/1/merge', GITHUB_SHA: commit, GITHUB_TOKEN: 'synthetic-test-only', GITHUB_STEP_SUMMARY: '' };
  const previous = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  Object.assign(process.env, env);
  let comment;
  const methods = [];
  globalThis.fetch = async (_url, options) => {
    methods.push(options.method);
    if (options.method === 'GET') return Response.json(comment ? [{ id: 1, body: comment }] : []);
    comment = JSON.parse(options.body).body;
    return Response.json({ html_url: 'https://github.com/fixture/doctorcre/pull/1#issuecomment-1' });
  };
  const entries = [bundle(1), bundle(2)];
  entries[0].first = report(1, 'failed'); entries[0].receipt.firstExit = 1; entries[0].receipt.rerun = true; entries[0].final = report(1, 'passed', true);
  await publishAggregate(aggregateShards(entries, commit), github({ key: 'DoctorCRE' }), '/fixture');
  assert.match(comment, /1 flaky, 1 passed/);
  assert.match(comment, /Evidence: \[video\].*#artifacts/);
  const marker = comment.split('\n')[0];
  await publishAggregate(aggregateShards([bundle(1), bundle(2)], commit), github({ key: 'DoctorCRE' }), '/fixture');
  assert.equal(comment.split('\n')[0], marker);
  assert.deepEqual(methods, ['GET', 'POST', 'GET', 'PATCH']);
  assert.match(comment, /2 passed/);
  await publishAggregate(aggregateShards([], commit), github({ key: 'DoctorCRE' }), '/fixture');
  assert.match(comment, /CI_EVIDENCE_INVALID/);
  assert.equal(methods.at(-1), 'PATCH');
});
