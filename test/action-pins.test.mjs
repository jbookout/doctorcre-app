import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkActionPins } from '../scripts/check-action-pins.mjs';

const sha = '1'.repeat(40);
const workflow = steps => `name: Probe\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n${steps}\n`;
async function fixture(t, ref = sha, manifest = true) {
  const root = await mkdtemp(join(tmpdir(), 'app-action-pins-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await writeFile(join(root, '.github/workflows/ci.yml'), `jobs:\n  test:\n    steps:\n      - uses: actions/checkout@${ref}\n`);
  if (manifest) await writeFile(join(root, '.github/action-pins.json'), JSON.stringify({
    schema: 'workflow-action-provenance.v1', actions: { 'actions/checkout': {
      sha, canonical_tag_sha: sha, tag: 'v7.0.1', runtime: 'node24', metadata_blob: '2'.repeat(40),
      release_url: 'https://github.com/actions/checkout/releases/tag/v7.0.1',
      tag_url: 'https://api.github.com/repos/actions/checkout/git/refs/tags/v7.0.1',
    } },
  }));
  return root;
}
test('action pins accept the recorded immutable release and reject drift and floating refs', async t => {
  await checkActionPins(await fixture(t));
  for (const ref of ['3'.repeat(40), 'v4', '${{ inputs.action }}', `${sha}@v7`]) {
    await assert.rejects(checkActionPins(await fixture(t, ref)), /ci.yml.*actions\/checkout/);
  }
});
test('every workflow is checked, including newly added YAML files', async t => {
  const root = await fixture(t);
  const extra = join(root, '.github/workflows/new.yaml');
  await writeFile(extra, workflow('      - uses: actions/checkout@v7'));
  await assert.rejects(checkActionPins(root), /new.yaml.*immutable/);
  await writeFile(extra, workflow(`      - uses: unknown/action@${sha}`));
  await assert.rejects(checkActionPins(root), /no recorded provenance/);
});
test('the current provenance policy rejects altered release and runtime evidence', async t => {
  const root = await fixture(t);
  const path = join(root, '.github/action-pins.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  for (const bad of [
    { runtime: 'node20' }, { canonical_tag_sha: 'f'.repeat(40) },
    { release_url: 'https://example.invalid/release' }, { tag_url: 'https://example.invalid/tag' },
    { metadata_blob: 'invalid' }, { tag: 'v7' },
  ]) {
    const changed = structuredClone(manifest);
    Object.assign(changed.actions['actions/checkout'], bad);
    await writeFile(path, JSON.stringify(changed));
    await assert.rejects(checkActionPins(root), assert.AssertionError);
  }
});
test('the CLI runs without npm dependencies and returns a failure for pin drift', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'scripts'));
  const script = join(root, 'scripts/check-action-pins.mjs');
  await copyFile(new URL('../scripts/check-action-pins.mjs', import.meta.url), script);
  const run = () => spawnSync(process.execPath, [script], { cwd: tmpdir(), encoding: 'utf8' });
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /pins match/);
  await writeFile(join(root, '.github/workflows/ci.yml'), workflow('      - uses: actions/checkout@v7'));
  const invalid = run();
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /ci.yml.*immutable/);
});
test('an unreadable pin manifest or empty workflow inventory cannot pass', async t => {
  await assert.rejects(checkActionPins(await fixture(t, sha, false)));
  const root = await mkdtemp(join(tmpdir(), 'app-empty-workflows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await writeFile(join(root, '.github/action-pins.json'), '{"schema":"workflow-action-provenance.v1","actions":{}}');
  await assert.rejects(checkActionPins(root), /no workflows/);
});
test('quoted action refs work and commented uses lines do not count', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.github/workflows/ci.yml'), workflow(`      # - uses: actions/checkout@v4\n      - uses: "actions/checkout@${sha}" # immutable`));
  await checkActionPins(root);
});
test('CI checks pins before dependency and browser setup while retaining the full suite', async () => {
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.ok(ci.includes('run: npm run ci:fast'));
  assert.ok(ci.indexOf('run: npm run ci:fast') < ci.indexOf('- uses: actions/setup-node'));
  assert.ok(ci.indexOf('run: npm run ci:fast') < ci.indexOf('run: npm ci'));
  assert.ok(ci.indexOf('run: npm run ci:fast') < ci.indexOf('run: npx playwright install'));
  assert.match(ci, /run: npm test/);
});

for (const [name, source, valid] of [
  ['block floating', workflow('      - uses: actions/checkout@v7'), false],
  ['single-quoted floating value', workflow("      - uses: 'actions/checkout@v7'"), false],
  ['double-quoted floating value', workflow('      - uses: "actions/checkout@v7"'), false],
  ['flow step floating', workflow('      - { uses: actions/checkout@v7 }'), false],
  ['single-quoted uses key', workflow("      - 'uses': actions/checkout@v7"), false],
  ['double-quoted uses key', workflow('      - "uses": actions/checkout@v7'), false],
  ['block reusable floating', 'jobs:\n  test:\n    uses: octo-org/example/.github/workflows/reuse.yml@main\n', false],
  ['flow reusable floating', 'jobs:\n  test: { uses: octo-org/example/.github/workflows/reuse.yml@main }\n', false],
  ['block docker floating', workflow('      - uses: docker://alpine:latest'), false],
  ['flow docker floating', workflow('      - { uses: "docker://alpine:latest" }'), false],
  ['local action', workflow('      - uses: ./.github/actions/local'), true],
  ['pinned block', workflow(`      - uses: actions/checkout@${sha}`), true],
  ['pinned quoted', workflow(`      - uses: "actions/checkout@${sha}"`), true],
  ['uses in run scalar', workflow('      - run: |\n          uses: actions/checkout@v7'), true],
  ['local composite with floating child', workflow('      - uses: ./.github/actions/composite'), false],
]) {
  test(`review regression: ${name}`, async t => {
    const root = await fixture(t);
    await mkdir(join(root, '.github/actions/local'), { recursive: true });
    await writeFile(join(root, '.github/actions/local/action.yml'), 'name: Local\nruns: { using: node24, main: index.js }\n');
    await mkdir(join(root, '.github/actions/composite'), { recursive: true });
    await writeFile(join(root, '.github/actions/composite/action.yml'), 'name: Composite\nruns:\n  using: composite\n  steps:\n    - uses: actions/checkout@v7\n');
    await writeFile(join(root, '.github/workflows/ci.yml'), source);
    if (valid) await checkActionPins(root);
    else await assert.rejects(checkActionPins(root));
  });
}

test('Docker references require a full SHA-256 digest', async t => {
  const root = await fixture(t);
  for (const ref of [`docker://alpine@sha256:${'a'.repeat(64)}`, 'docker://alpine@sha256:abc', 'docker://alpine']) {
    await writeFile(join(root, '.github/workflows/ci.yml'), workflow(`      - uses: ${ref}`));
    if (ref.endsWith('a'.repeat(64))) await checkActionPins(root);
    else await assert.rejects(checkActionPins(root), /immutable digest/);
  }
});

test('local action directories ending in .yaml still load action metadata', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'local.yaml'));
  await writeFile(join(root, 'local.yaml/action.yaml'), `runs: { using: composite, steps: [{ uses: actions/checkout@${sha} }] }\n`);
  await writeFile(join(root, '.github/workflows/ci.yml'), workflow('      - uses: ./local.yaml'));
  await checkActionPins(root);
});

test('unquoted dates outside action refs do not change pin validation', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.github/workflows/ci.yml'), `env: { DATE: 2026-01-01 }\n${workflow(`      - uses: actions/checkout@${sha}`)}`);
  await checkActionPins(root);
});

test('nested local composites and reusable workflows retain pin enforcement', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'outer'));
  await mkdir(join(root, 'inner'));
  await writeFile(join(root, 'outer/action.yml'), 'runs: { using: composite, steps: [{ uses: ./inner }] }\n');
  const inner = join(root, 'inner/action.yaml');
  await writeFile(inner, 'runs: { using: composite, steps: [{ uses: actions/checkout@v7 }] }\n');
  await writeFile(join(root, '.github/workflows/ci.yml'), 'jobs: { test: { uses: ./.github/workflows/reuse.yml } }\n');
  await writeFile(join(root, '.github/workflows/reuse.yml'), workflow('      - uses: ./outer'));
  await assert.rejects(checkActionPins(root), /inner.*immutable/);
  await writeFile(inner, `runs: { using: composite, steps: [{ uses: actions/checkout@${sha} }, { uses: ./outer }] }\n`);
  await checkActionPins(root);
});

test('YAML aliases are checked and malformed YAML and object tags fail closed', async t => {
  const root = await fixture(t);
  const path = join(root, '.github/workflows/ci.yml');
  await writeFile(path, workflow('      - &step { uses: actions/checkout@v7 }\n      - *step'));
  await assert.rejects(checkActionPins(root), /immutable/);
  for (const source of ['jobs: [', '!ruby/object:Object {}', workflow('      - uses: null')]) {
    await writeFile(path, source);
    await assert.rejects(checkActionPins(root));
  }
});

test('local action symlinks cannot escape the repository and missing metadata fails closed', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await writeFile(join(outside, 'action.yml'), 'runs: { using: composite, steps: [] }\n');
  await symlink(outside, join(root, 'outside'), 'dir');
  await writeFile(join(root, '.github/workflows/ci.yml'), workflow('      - uses: ./outside'));
  await assert.rejects(checkActionPins(root), /inside repository/);
  await mkdir(join(root, 'empty'));
  await writeFile(join(root, '.github/workflows/ci.yml'), workflow('      - uses: ./empty'));
  await assert.rejects(checkActionPins(root), /ENOENT/);
});
