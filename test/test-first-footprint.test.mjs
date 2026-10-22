import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('../scripts/test-first-footprint.mjs', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'test-first-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  git('init', '-q');
  git('config', 'user.name', 'Synthetic');
  git('config', 'user.email', 'synthetic@example.invalid');
  write('js/value.mjs', 'export const value = 1;\n');
  write('test/existing.test.mjs', "import test from 'node:test'; test('existing', () => { throw Error('UNRELATED-TEST-RAN'); });\n");
  const commit = () => {
    git('add', 'test');
    if (existsSync(join(root, 'js'))) git('add', 'js');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const base = commit();
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const run = (head = git('rev-parse', 'HEAD'), overrides = {}) => spawnSync(process.execPath, [checker], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...environment, BASE_SHA: base, HEAD_SHA: head, GITHUB_STEP_SUMMARY: join(root, 'summary.md'), ...overrides },
  });
  return { root, git, write, commit, base, run };
}

const regression = "import assert from 'node:assert/strict'; import test from 'node:test'; import { value } from '../js/value.mjs'; test('new value', () => assert.equal(value, 2));\n";

test('changed tests fail on exact base and pass on exact head without running untouched tests', t => {
  const f = fixture(t);
  f.write('js/value.mjs', 'export const value = 2;\n');
  f.write('test/value.test.mjs', regression);
  f.commit();
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const summary = readFileSync(join(f.root, 'summary.md'), 'utf8');
  assert.match(summary, /Base.*FAIL/);
  assert.match(summary, /Head.*PASS/);
  assert.doesNotMatch(result.stdout, /UNRELATED-TEST-RAN/);
  assert.equal(f.git('worktree', 'list', '--porcelain').split('worktree ').length - 1, 1);
});

test('tracked executable source without an extension triggers the comparison', t => {
  const f = fixture(t);
  f.write('js/value', 'export const value = 2;\n');
  f.write('test/value.test.mjs', regression.replace('../js/value.mjs', '../js/value'));
  f.git('config', 'core.fileMode', 'false');
  f.git('add', 'js/value');
  f.git('update-index', '--chmod=+x', 'js/value');
  f.commit();
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Base: \*\*FAIL/);
  assert.match(result.stdout, /Head: \*\*PASS/);
});

test('docs, configuration, deletion-only changes, and changes without tests skip the comparison', t => {
  for (const kind of ['docs', 'config', 'deletion', 'no-tests']) {
    const f = fixture(t);
    if (kind !== 'no-tests') f.write('test/value.test.mjs', regression);
    if (kind === 'docs') f.write('js/guide.md', 'documentation');
    if (kind === 'config') f.write('js/tool.config.mjs', 'export default {};\n');
    if (kind === 'deletion') f.git('rm', 'js/value.mjs');
    if (kind === 'no-tests') f.write('js/value.mjs', 'export const value = 2;\n');
    f.commit();
    const result = f.run();
    assert.equal(result.status, 0, kind + result.stdout + result.stderr);
    assert.match(result.stdout, /Skipped/);
    assert.doesNotMatch(result.stdout, /Subtest:|UNRELATED-TEST-RAN/);
  }
});

test('passing-on-base tests are rejected and a failing head stays rejected', t => {
  for (const [expected, baseStatus, headStatus] of [[1, 'PASS', 'FAIL'], [3, 'FAIL', 'FAIL'], [null, 'PASS', 'PASS']]) {
    const f = fixture(t);
    f.write('js/value.mjs', 'export const value = 2;\n');
    f.write('test/value.test.mjs', expected === null ? regression.replace('assert.equal(value, 2)', 'assert.ok(value)') : regression.replace('value, 2', `value, ${expected}`));
    f.commit();
    const result = f.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`Base: \\*\\*${baseStatus}`));
    assert.match(result.stdout, new RegExp(`Head: \\*\\*${headStatus}`));
    if (baseStatus === 'PASS') assert.match(result.stdout, /these tests don’t test the change/);
  }
});

test('the base run uses the exact target revision when it has advanced beyond the merge base', t => {
  const f = fixture(t);
  f.git('switch', '-qc', 'feature');
  f.write('js/value.mjs', 'export const value = 2;\n');
  f.write('test/value.test.mjs', regression.replace('assert.equal(value, 2)', 'assert.notEqual(value, 1)'));
  const head = f.commit();
  f.git('switch', '-qc', 'target', f.base);
  f.write('js/value.mjs', 'export const value = 3;\n');
  const advancedBase = f.commit();
  const result = f.run(head, { BASE_SHA: advancedBase });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Base: \*\*PASS/);
  assert.match(result.stdout, /Head: \*\*PASS/);
  assert.match(result.stdout, /these tests don’t test the change/);
});

test('base setup failure cannot masquerade as a failing test and head still runs', t => {
  const f = fixture(t);
  f.write('package.json', JSON.stringify({ scripts: { pretest: 'node -e "process.exit(7)"' } }));
  f.git('add', 'package.json');
  const base = f.commit();
  f.write('package.json', JSON.stringify({ scripts: { pretest: 'node -e "process.exit(0)"' } }));
  f.git('add', 'package.json');
  f.write('js/value.mjs', 'export const value = 2;\n');
  f.write('test/value.test.mjs', regression);
  f.commit();
  const result = f.run(undefined, { BASE_SHA: base });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Base: \*\*ERROR/);
  assert.match(result.stdout, /Head: \*\*PASS/);
});

test('modified tests use PR head content, exact head ignores the current checkout, and test arguments stay inert', t => {
  const f = fixture(t);
  f.write('test/existing.test.mjs', regression);
  f.write('test/value $(touch marker).test.mjs', regression);
  f.write('js/value.mjs', 'export const value = 2;\n');
  const head = f.commit();
  f.write('js/value.mjs', 'export const value = 99;\n');
  f.commit();
  const result = f.run(head);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Changed test files: 2/);
  assert.throws(() => readFileSync(join(f.root, 'marker')), { code: 'ENOENT' });
});

test('revision inputs reject expressions and missing commits', t => {
  const f = fixture(t);
  for (const BASE_SHA of ['main', '$(touch marker)', 'f'.repeat(40)]) {
    const result = f.run(f.base, { BASE_SHA });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /rejected/);
  }
  assert.throws(() => readFileSync(join(f.root, 'marker')), { code: 'ENOENT' });
});

test('the required CI test context fails for every unsuccessful footprint result', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const parsed = JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load(STDIN.read))'], { input: workflow, encoding: 'utf8' }));
  const footprint = parsed.jobs['test-first'];
  assert.ok(footprint, 'test-first job exists');
  const comparison = footprint.steps.find(step => step.name === 'Compare changed tests on base and head');
  assert.equal(comparison.env.BASE_SHA, '${{ github.event.pull_request.base.sha || inputs.test_first_base }}');
  assert.equal(comparison.env.HEAD_SHA, '${{ github.event.pull_request.head.sha || github.sha }}');
  const checkout = footprint.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.event.pull_request.head.sha || github.sha }}');
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.match(parsed.jobs.test.if, /always\(\)/);
  assert.doesNotMatch(parsed.jobs.test.if, /cancelled\(\)/, 'cancelled prerequisites must still reach the aggregate');
  assert.deepEqual(parsed.jobs.test.needs, ['test-first']);
  const aggregate = parsed.jobs.test.steps[0];
  assert.equal(aggregate.env.TEST_FIRST_RESULT, '${{ needs.test-first.result }}');
  for (const status of ['success', 'failure', 'cancelled', 'skipped']) {
    const result = spawnSync('bash', ['-e', '-c', aggregate.run], { env: { ...process.env, TEST_FIRST_RESULT: status } });
    assert.equal(result.status, status === 'success' ? 0 : 1, status);
  }
});
