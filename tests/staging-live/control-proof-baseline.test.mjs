import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareBrowserControlProofs, reviewedSourceDigests, unreviewedSources } from '../../scripts/e2e-staging/control-proofs.mjs';
import catalog from '../../contracts/e2e-staging-control-proofs.v1.json' with { type: 'json' };

const checkout = fileURLToPath(new URL('../../', import.meta.url));
const git = (args, options = {}) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', timeout: 30_000, ...options }).trim();

// The catalog check: every file a proof reviewed, and nothing else, still has
// the reviewed bytes in this checkout. It needs no history and no commit pin.
test('the checkout carries the exact reviewed bytes of every control-proof source', async () => {
  const current = await reviewedSourceDigests('HEAD', catalog.controls);
  assert.deepEqual(unreviewedSources(catalog.reviewed_sources, current), [],
    'reviewed source changed: re-review the proofs whose closure includes it, then npm run e2e:staging:repin-control-proofs -- HEAD --reviewed <path>');
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
