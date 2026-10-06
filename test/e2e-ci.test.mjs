import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { aggregateShards, runShard } from '../scripts/e2e-ci.mjs';
import { commit, plan, report, bundle, result } from './e2e-ci-fixtures.mjs';

test('complete disjoint shards produce an aggregate and preserve evidence paths', async () => {
  const aggregate = aggregateShards([bundle(1), bundle(2)], commit);
  assert.equal(aggregate.exitCode, 0);
  assert.equal(aggregate.report.run.summary.passed, 2);
  assert.equal(aggregate.report.run.usage.modelTokens, 4, 'count each first run once');
  assert.equal(aggregate.lastRun.run.results.length, 2);
  assert.equal(aggregate.lastRun.run.results[0].attempts[0].artifacts[0].path, 'shard-1/artifacts/one/video.webm');
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
    entries => { entries[0].receipt.error = 'ChatGPT login unavailable'; delete entries[0].first; delete entries[0].final; },
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
  await runShard({ shard: 1, root: directory, env: { SOURCE_COMMIT: commit }, execute: async (args) => {
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

test('configuration, infrastructure and interrupt failures do not launch a failed-test rerun', async () => {
  for (const code of [2, 3, 4, 130]) {
    const directory = await mkdtemp(join(tmpdir(), 'doctorcre-e2e-no-rerun-'));
    let starts = 0;
    const receipt = await runShard({ shard: 1, root: directory, env: { SOURCE_COMMIT: commit }, execute: async args => {
      if (args[0] === 'list') return { code: 0, stdout: JSON.stringify({ pairs: args.includes('--shard') ? [plan[0]] : plan }) };
      starts++;
      return { code };
    } });
    assert.equal(starts, 1);
    assert.equal(receipt.finalExit, code);
    assert.equal(receipt.rerun, undefined);
  }
});
