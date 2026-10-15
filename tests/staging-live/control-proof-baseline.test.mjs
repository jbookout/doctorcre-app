import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { citationMismatches, families } from './catalog-families.mjs';
import { prepareBrowserControlProofs, reviewedSourceDigests, unreviewedSources } from '../../scripts/e2e-staging/control-proofs.mjs';
import catalog from '../../contracts/e2e-staging-control-proofs.v1.json' with { type: 'json' };
import contract from '../../contracts/e2e-staging.v1.json' with { type: 'json' };

const checkout = fileURLToPath(new URL('../../', import.meta.url));
const git = (args, options = {}) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', timeout: 30_000, ...options }).trim();

test('the session and control-proof contracts pin the same CARR producer', () => {
  assert.equal(catalog.carr_source_commit, contract.producer.source_commit);
});

// The catalog check: every file a proof reviewed, and nothing else, still has
// the reviewed bytes in this checkout. It needs no history and no commit pin.
test('the checkout carries the exact reviewed bytes of every control-proof source', async () => {
  const current = await reviewedSourceDigests('HEAD', catalog.controls);
  assert.deepEqual(unreviewedSources(catalog.reviewed_sources, current), [],
    'reviewed source changed: re-review the proofs whose closure includes it, then npm run e2e:staging:repin-control-proofs -- HEAD --reviewed <path>');
});

// A digest rebind proves the bytes were re-pinned, not that each review still
// cites the code that defines its control.
test('every review citation names the line that defines its control', () => {
  const read = path => readFileSync(join(checkout, path), 'utf8');
  assert.deepEqual(citationMismatches(catalog.controls, read), [],
    'move the family source in catalog-families.mjs, then node tests/staging-live/compile-control-catalog.mjs <family>');
  const row = catalog.controls.find(entry => entry.review.family === 'account-menu');
  const avatar = families.find(family => family.id === 'account-menu');
  const [file, line] = avatar.source.split(':');
  const elsewhere = file === 'js/app-shell.js' ? 'js/navigation.js' : 'js/app-shell.js';
  const cite = source => citationMismatches([{ ...row, review: { ...row.review, source } }], read).filter(problem => problem.startsWith(row.identity));
  assert.equal(cite(`${elsewhere}:${line}`).length, 1, 'a citation in another file is refused');
  assert.equal(cite(`${file}:${Number(line) + 1}`).length, 1, 'a line that does not define the control is refused');
  assert.equal(cite(`${file}:9999`).length, 1, 'a line past the end of the file is refused');
});

// A commit equal to HEAD except for one file, written to the object store only.
async function commitWith(t, path, text) {
  const dir = await mkdtemp(join(tmpdir(), 'control-proof-index-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index'), GIT_AUTHOR_NAME: 'Synthetic Test', GIT_AUTHOR_EMAIL: 'synthetic@example.test',
    GIT_COMMITTER_NAME: 'Synthetic Test', GIT_COMMITTER_EMAIL: 'synthetic@example.test' };
  git(['read-tree', 'HEAD'], { env });
  git(['update-index', '--add', '--cacheinfo', `100644,${git(['hash-object', '-w', '--stdin'], { input: text })},${path}`], { env });
  return git(['commit-tree', git(['write-tree'], { env }), '-p', 'HEAD', '-m', 'Synthetic change'], { env });
}
const prepare = source_commit => prepareBrowserControlProofs({ service: 'doctorcre-app', environment: 'staging', source_commit,
  carr_source_commit: catalog.carr_source_commit });

test('preparation admits proofs across unrelated changes and refuses a changed reviewed source', async t => {
  const reviewed = catalog.controls[0].review.source.replace(/:\d+(?::\d+)?$/, '');
  assert.ok(reviewed in catalog.reviewed_sources && !('README.md' in catalog.reviewed_sources));
  const unrelated = await prepare(await commitWith(t, 'README.md', git(['show', 'HEAD:README.md']) + '\nUnrelated change.\n'));
  assert.equal(unrelated.preparation.state, 'prepared');
  assert.equal(unrelated.proofs.length, catalog.controls.length);
  const changed = await prepare(await commitWith(t, reviewed, git(['show', `HEAD:${reviewed}`]) + '\n// Unreviewed change.\n'));
  assert.equal(changed.preparation.state, 'unreviewed-source');
  assert.deepEqual(changed.preparation.unreviewed_sources, [reviewed]);
  assert.deepEqual(changed.proofs, []);
});
