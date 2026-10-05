import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { github } from '@e2e-dev/github';

const config = 'e2e.ci.config.ts';
const pass = new Set(['passed', 'flaky']);
const failed = new Set(['failed', 'timed-out']);
const pairKey = row => JSON.stringify([row.file, row.titlePath?.join(' ') ?? row.title, row.target ?? row.targetId]);
const keys = rows => rows.map(pairKey).sort();
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + '\n');

function execute(args, root, env) {
  return new Promise(resolveRun => {
    const list = args[0] === 'list';
    const child = spawn(process.execPath, ['node_modules/e2e/dist/cli/bin.js', ...args], {
      cwd: root, env: { ...env, CI: '1', E2E_TELEMETRY_DISABLED: '1' }, stdio: list ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    let stdout = '';
    child.stdout?.on('data', bytes => { stdout += bytes; });
    child.on('error', error => resolveRun({ code: 3, error: error.message }));
    child.on('close', code => resolveRun({ code: code ?? 130, stdout }));
  });
}

export async function runShard({ shard, root = process.cwd(), env = process.env, execute: run = (args) => execute(args, root, env) }) {
  assert.ok(shard === 1 || shard === 2, 'shard must be 1 or 2');
  assert.match(env.SOURCE_COMMIT ?? '', /^[a-f0-9]{40}$/, 'SOURCE_COMMIT must bind the checked-out source');
  const output = `.e2e/ci/shard-${shard}`;
  const directory = join(root, output);
  await mkdir(directory, { recursive: true });
  const receipt = { schema: 'doctorcre-e2e-shard.v1', shard, total: 2, commit: env.SOURCE_COMMIT, startedAt: new Date().toISOString(), firstExit: 2, finalExit: 2 };
  try {
    const collect = async (slice = []) => {
      const listed = await run(['list', '--config', config, '--reporter', 'json', ...slice]);
      assert.equal(listed.code, 0, 'test collection failed');
      const pairs = JSON.parse(listed.stdout).pairs;
      assert.ok(Array.isArray(pairs) && pairs.length > 0, 'test plan is empty');
      return pairs.filter(row => row.disposition === 'run');
    };
    receipt.plan = await collect();
    receipt.selected = await collect(['--shard', `${shard}/2`]);
    if (!env.OPENAI_API_KEY) throw Error('Missing repository secret OPENAI_API_KEY');
    const common = ['--config', config, '--output', output, '--retries', '0', '--reporter', 'list,junit,markdown'];
    receipt.firstExit = (await run(['run', ...common, '--shard', `${shard}/2`])).code;
    receipt.finalExit = receipt.firstExit;
    await copyFile(join(directory, 'report.json'), join(directory, 'first.json'));
    if (receipt.firstExit === 1) {
      receipt.rerun = true;
      receipt.finalExit = (await run(['run', ...common, '--last-failed'])).code;
    }
  } catch (error) {
    receipt.error = error.message;
    receipt.finalExit = receipt.finalExit || 2;
    console.error(`e2e shard ${shard}: ${error.message}`);
  }
  await save(join(directory, 'receipt.json'), receipt);
  return receipt;
}

function summary(results) {
  const value = { discovered: results.length, selected: 0, executed: 0, passed: 0, failed: 0, interrupted: 0, flaky: 0, skipped: 0 };
  for (const row of results.filter(row => row.selected)) {
    value.selected++;
    if (row.attempts.length || row.serialGroupId && row.status !== 'skipped') value.executed++;
    value[failed.has(row.status) ? 'failed' : row.status]++;
  }
  return value;
}

// Validate the report fields consumed by the gate and the public reporter.
function validate(report, commit) {
  assert.equal(report?.schemaVersion, 'report-1', 'unsupported report contract');
  const run = report.run;
  assert.equal(run.vcs?.commit, commit, 'report source commit differs');
  assert.equal(run.vcs?.dirty, false, 'report source is dirty');
  assert.ok(run.project?.id && /^[a-f0-9]{64}$/.test(run.project.configDigest), 'invalid report project');
  assert.ok(Array.isArray(run.results) && Array.isArray(run.errors) && Array.isArray(run.serialGroups), 'malformed report');
  assert.ok([0, 1, 2, 3, 4, 130].includes(run.exitCode), 'invalid report exit code');
  assert.ok(['passed', 'failed', 'blocked', 'error', 'interrupted'].includes(run.status), 'invalid run status');
  const ids = new Set();
  for (const row of [...run.results, ...(run.carried?.results ?? [])]) {
    assert.ok(row.id && row.testId && row.targetId && row.file && Array.isArray(row.titlePath), 'invalid result identity');
    assert.ok(['passed', 'flaky', 'failed', 'timed-out', 'interrupted', 'skipped'].includes(row.status), 'invalid result status');
    assert.ok(Array.isArray(row.attempts), 'missing result attempts');
    for (const attempt of row.attempts) assert.ok(Array.isArray(attempt.steps) && Array.isArray(attempt.artifacts), 'malformed attempt');
  }
  for (const row of run.results) { assert.ok(!ids.has(row.id), 'duplicate result'); ids.add(row.id); }
  assert.deepEqual(run.summary, summary(run.results), 'report summary disagrees with results');
  const checkPaths = value => {
    if (!value || typeof value !== 'object') return;
    if ('mediaType' in value && value.path !== undefined) assert.match(value.path, /^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\/\/)[^\0]+$/, 'unsafe artifact path');
    for (const child of Object.values(value)) checkPaths(child);
  };
  checkPaths(run);
}

function prefixed(report, shard) {
  const copy = structuredClone(report);
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if ('mediaType' in value && value.path !== undefined) value.path = `shard-${shard}/artifacts/${value.path}`;
    for (const child of Object.values(value)) visit(child);
  };
  visit(copy);
  return copy;
}

function errorReport(commit) {
  return { schemaVersion: 'report-1', run: { id: '01900000-0000-7000-8000-000000000000', specVersion: '0.1', runner: { name: 'e2e', version: '0.17.0' },
    status: 'error', exitCode: 2, startedAt: new Date().toISOString(), project: { id: 'doctorcre-app', configDigest: '0'.repeat(64) },
    environment: { ci: true, trustNoticeShown: false, os: process.platform, arch: process.arch, runtime: process.version }, vcs: { commit, dirty: false },
    targets: [], serialGroups: [], results: [], errors: [], summary: summary([]), limits: {}, usage: {} } };
}

export function aggregateShards(bundles, commit) {
  const errors = [];
  const before = [], current = [];
  const verified = [];
  try {
    assert.equal(bundles.length, 2, 'both shard receipts are required');
    assert.deepEqual(bundles.map(entry => entry.receipt?.shard).sort(), [1, 2], 'shards must be distinct');
    assert.deepEqual(keys(bundles[0].receipt.plan), keys(bundles[1].receipt.plan), 'shards collected different suites');
    assert.deepEqual(keys(bundles.flatMap(entry => entry.receipt.selected)), keys(bundles[0].receipt.plan), 'shards do not cover the complete suite');
    assert.ok(bundles[0].receipt.plan.some(row => row.file.startsWith('tests/agent/')), 'suite contains no agent tests');
  } catch (error) { errors.push(error.message); }
  for (const bundle of bundles) {
    try {
      const { receipt, first, final } = bundle;
      assert.equal(receipt.schema, 'doctorcre-e2e-shard.v1', 'unsupported shard receipt');
      assert.equal(receipt.commit, commit, 'receipt source commit differs');
      assert.equal(receipt.total, 2, 'unexpected shard count');
      assert.ok(!receipt.error, receipt.error);
      validate(first, commit); validate(final, commit);
      assert.ok(Number.isFinite(Date.parse(receipt.startedAt)) && Date.parse(first.run.startedAt) >= Date.parse(receipt.startedAt), 'report predates this shard invocation');
      assert.ok(Date.parse(final.run.startedAt) >= Date.parse(first.run.startedAt), 'rerun predates first pass');
      assert.deepEqual(first.run.project, final.run.project, 'rerun project differs');
      assert.deepEqual(first.run.project, bundles.find(entry => entry.first)?.first.run.project, 'shard projects differ');
      assert.equal(first.run.exitCode, receipt.firstExit, 'first exit disagrees with report');
      assert.equal(final.run.exitCode, receipt.finalExit, 'final exit disagrees with report');
      if (receipt.rerun) assert.equal(receipt.firstExit, 1, 'only a test failure can rerun');
      else assert.deepEqual(first, final, 'report changed without a failed-test rerun');
      assert.deepEqual(keys(first.run.results.filter(row => row.selected)), keys(receipt.selected), 'shard skipped a planned test');
      const planned = new Set(keys(receipt.selected));
      assert.ok(keys(final.run.results.filter(row => row.selected)).every(key => planned.has(key)), 'rerun selected another shard\'s tests');
      assert.equal(final.run.exitCode, 0, 'shard failed or was cancelled');
      assert.equal(final.run.status, 'passed', 'shard did not pass');
      assert.equal(final.run.errors.length, 0, 'shard has run or hook errors');
      assert.equal(final.run.carried?.results?.length ?? 0, 0, 'rerun still owes results');
      assert.equal(final.run.carried?.errors?.length ?? 0, 0, 'rerun still owes hook errors');
      const initial = first.run.results.filter(row => row.selected);
      for (const old of initial) {
        const row = final.run.results.find(row => row.id === old.id && row.selected) ?? old;
        assert.ok(pass.has(row.status), 'required test did not pass');
        const owner = row === old ? first.run : final.run;
        const steps = row.serialGroupId
          ? (owner.serialGroups.find(group => group.id === row.serialGroupId)?.attempts ?? []).filter(attempt => attempt.status === 'passed').flatMap(attempt => attempt.members.filter(member => member.testId === row.testId && member.status === 'passed').flatMap(member => member.steps))
          : row.attempts.filter(attempt => attempt.status === 'passed').flatMap(attempt => attempt.steps);
        assert.ok(steps.length > 0, 'required test contains no passing attempt evidence');
        if (old.file.startsWith('tests/agent/')) assert.ok(steps.some(step => step.kind === 'agent' && step.api === 'agent.act' && step.status === 'passed'), 'agent test contains no passed action evidence');
      }
      before.push(prefixed(first, receipt.shard));
      const next = prefixed(final, receipt.shard);
      if (!receipt.rerun) {
        next.run.results = next.run.results.map(row => ({ ...row, selected: false, attempts: [] }));
        next.run.serialGroups = [];
        next.run.usage = {};
      }
      current.push(next);
      verified.push(receipt.shard);
    } catch (error) { errors.push(`shard ${bundle.receipt?.shard ?? '?'}: ${error.message}`); }
  }
  const combine = reports => {
    const document = structuredClone(reports[0] ?? errorReport(commit));
    document.run.results = reports.flatMap(report => report.run.results.filter(row => row.selected));
    document.run.serialGroups = reports.flatMap(report => report.run.serialGroups);
    document.run.errors = reports.flatMap(report => report.run.errors);
    document.run.summary = summary(document.run.results);
    document.run.usage = {};
    for (const report of reports) for (const [name, value] of Object.entries(report.run.usage)) document.run.usage[name] = (document.run.usage[name] ?? 0) + value;
    return document;
  };
  const lastRun = combine(before);
  const report = combine(current);
  for (const [name, value] of Object.entries(lastRun.run.usage)) report.run.usage[name] = (report.run.usage[name] ?? 0) + value;
  report.run.startedAt = lastRun.run.startedAt;
  // Include unselected placeholders so the reporter folds untouched first-pass results.
  const currentIds = new Set(report.run.results.map(row => row.id));
  report.run.results.push(...lastRun.run.results.filter(row => !currentIds.has(row.id)).map(row => ({ ...row, selected: false, attempts: [] })));
  const exitCode = errors.length || verified.length !== 2 ? 1 : 0;
  report.run.status = exitCode ? 'failed' : 'passed'; report.run.exitCode = exitCode;
  report.run.errors.push(...errors.map(message => ({ category: 'test', code: 'CI_EVIDENCE_INVALID', message, retryable: false, phase: 'report' })));
  report.run.summary = summary(report.run.results);
  return { report, lastRun, exitCode };
}

export function publishAggregate(aggregate, reporter = github({ key: 'DoctorCRE' }), root = process.cwd()) {
  return reporter.onRunFinished({ report: aggregate.report, lastRun: aggregate.lastRun, status: aggregate.report.run.status,
    exitCode: aggregate.exitCode, projectRoot: root, reportPath: join(root, '.e2e/ci/aggregate.json'), artifactsRoot: join(root, '.e2e/ci') }, AbortSignal.timeout(60_000));
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === 'shard') process.exitCode = (await runShard({ shard: Number(argument) })).finalExit;
  else if (command === 'collect') {
    const entries = await readdir(argument).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const shard of [1, 2]) {
      const name = `e2e-shard-${shard}-${process.env.SOURCE_COMMIT}-${process.env.GITHUB_RUN_ATTEMPT}`;
      if (entries.includes(name)) await cp(join(argument, name), `.e2e/ci/shard-${shard}`, { recursive: true, errorOnExist: true, force: false });
    }
  } else if (command === 'aggregate') {
    const bundles = [];
    for (const shard of [1, 2]) {
      const dir = resolve('.e2e/ci', `shard-${shard}`);
      try { bundles.push({ receipt: await json(join(dir, 'receipt.json')), first: await json(join(dir, 'first.json')).catch(() => undefined), final: await json(join(dir, 'report.json')).catch(() => undefined) }); }
      catch { bundles.push({ receipt: { shard, error: 'missing shard receipt' } }); }
    }
    const aggregate = aggregateShards(bundles, process.env.SOURCE_COMMIT);
    if (process.env.JOURNEYS_RESULT !== 'success') {
      aggregate.exitCode = 1;
      aggregate.report.run.status = 'failed'; aggregate.report.run.exitCode = 1;
      aggregate.report.run.errors.push({ category: 'test', code: 'PRODUCT_PROOF_FAILED', message: `Exact-source journeys job: ${process.env.JOURNEYS_RESULT ?? 'missing result'}`, retryable: false, phase: 'report' });
    }
    await mkdir('.e2e/ci', { recursive: true });
    await save('.e2e/ci/aggregate.json', aggregate.report);
    const rows = await publishAggregate(aggregate);
    for (const row of rows ?? []) console.log(`${row.label}: ${row.text}`);
    process.exitCode = aggregate.exitCode;
  } else throw Error('usage: node scripts/e2e-ci.mjs shard <1|2> | collect <downloads> | aggregate');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
