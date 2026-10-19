import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkActionPins } from '../scripts/check-action-pins.mjs';

const sha = '1'.repeat(40);
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
  await writeFile(extra, 'steps:\n  - uses: actions/checkout@v7\n');
  await assert.rejects(checkActionPins(root), /new.yaml.*immutable/);
  await writeFile(extra, `steps:\n  - uses: unknown/action@${sha}\n`);
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
test('the CLI runs without dependencies and returns a failure for pin drift', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'scripts'));
  const script = join(root, 'scripts/check-action-pins.mjs');
  await copyFile(new URL('../scripts/check-action-pins.mjs', import.meta.url), script);
  const run = () => spawnSync(process.execPath, [script], { cwd: tmpdir(), encoding: 'utf8' });
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /pins match/);
  await writeFile(join(root, '.github/workflows/ci.yml'), 'steps:\n  - uses: actions/checkout@v7\n');
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
  await writeFile(join(root, '.github/workflows/ci.yml'), `steps:\n  # - uses: actions/checkout@v4\n  - uses: "actions/checkout@${sha}" # immutable\n  - uses: './local-action'\n`);
  await checkActionPins(root);
});
test('CI checks pins before dependency and browser setup while retaining the full suite', async () => {
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.ok(ci.includes('run: npm run ci:fast'));
  assert.ok(ci.indexOf('run: npm run ci:fast') < ci.indexOf('run: npm ci'));
  assert.ok(ci.indexOf('run: npm run ci:fast') < ci.indexOf('run: npx playwright install'));
  assert.match(ci, /run: npm test/);
});
