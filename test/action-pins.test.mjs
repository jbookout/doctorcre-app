import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkActionPins } from '../scripts/check-action-pins.mjs';

const sha = '1'.repeat(40);
async function fixture(ref = sha, manifest = true) {
  const root = await mkdtemp(join(tmpdir(), 'app-action-pins-'));
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await writeFile(join(root, '.github/workflows/ci.yml'), `jobs:\n  test:\n    steps:\n      - uses: actions/checkout@${ref}\n`);
  if (manifest) await writeFile(join(root, '.github/action-pins.json'), JSON.stringify({
    schema: 'workflow-action-provenance.v1', actions: { 'actions/checkout': {
      sha, canonical_tag_sha: sha, tag: 'v4.2.2', runtime: 'node20', metadata_blob: '2'.repeat(40),
      release_url: 'https://github.com/actions/checkout/releases/tag/v4.2.2',
    } },
  }));
  return root;
}
test('action pins accept the recorded immutable release and reject drift and floating refs', async () => {
  await checkActionPins(await fixture());
  for (const ref of ['3'.repeat(40), 'v4', '${{ inputs.action }}']) {
    await assert.rejects(checkActionPins(await fixture(ref)), /ci.yml.*actions\/checkout/);
  }
});
test('an unreadable pin manifest or empty workflow inventory cannot pass', async () => {
  await assert.rejects(checkActionPins(await fixture(sha, false)));
  const root = await mkdtemp(join(tmpdir(), 'app-empty-workflows-'));
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await writeFile(join(root, '.github/action-pins.json'), '{"schema":"workflow-action-provenance.v1","actions":{}}');
  await assert.rejects(checkActionPins(root), /no workflows/);
});
test('quoted action refs work and commented uses lines do not count', async () => {
  const root = await fixture();
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
