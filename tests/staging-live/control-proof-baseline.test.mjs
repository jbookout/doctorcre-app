import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applicationSourceFingerprint } from '../../scripts/e2e-staging/control-proofs.mjs';
import catalog from '../../contracts/e2e-staging-control-proofs.v1.json' with { type: 'json' };

const checkout = fileURLToPath(new URL('../../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });

// Re-pinning starts from this pair, so the digest must describe the reviewed
// commit. Moving application_source_sha256 alone (as #212, #214 and #215 did)
// blesses unreviewed handler changes and makes every later re-pin refuse main.
test('the catalog digest is the application fingerprint of reviewed_source_commit', () => {
  const commit = catalog.reviewed_source_commit;
  assert.match(commit, /^[a-f0-9]{40}$/);
  // CI checks out one commit; the reviewed commit is public history.
  try { git('cat-file', '-e', `${commit}^{commit}`); }
  catch { git('fetch', '--quiet', '--no-tags', '--depth=1', 'origin', commit); }
  assert.equal(applicationSourceFingerprint(git('ls-tree', '-r', '-z', commit)), catalog.application_source_sha256,
    'application_source_sha256 moved without reviewed_source_commit: re-pin both from a reviewed commit, never the digest alone');
});
