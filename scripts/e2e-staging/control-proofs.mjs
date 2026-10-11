import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalIdentity } from './traversal.mjs';
import catalog from '../../contracts/e2e-staging-control-proofs.v1.json' with { type: 'json' };

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const sha = text => createHash('sha256').update(text).digest('hex');
// Only the harness, its tests and this catalog can change without re-reviewing
// app behavior. The Worker, all build inputs and contracts remain bound.
const applicationSource = tree => tree.split('\0').filter(row => {
  const path = row.slice(row.indexOf('\t') + 1);
  return row && !path.startsWith('scripts/e2e-staging/') && !path.startsWith('tests/staging-live/') &&
    !['test/staging-control-visibility.test.mjs', 'contracts/e2e-staging-control-proofs.v1.json'].includes(path);
}).map(row => row + '\0').join('');

// Record preparation runs this before installing any browser guard. No page
// is accepted here and no grant is inferred from a discovered control.
export async function prepareBrowserControlProofs(release, { signal } = {}) {
  const preparation = { schema: catalog.schema, release: { ...release },
    reviewed_source_commit: catalog.reviewed_source_commit, catalog_sha256: sha(JSON.stringify(catalog)),
    state: 'unreviewed-source' };
  const empty = () => ({ preparation, proofs: [] });
  if (catalog.schema !== 'doctorcre-staging-control-proofs.v1' ||
      !/^[a-f0-9]{40}$/.test(release?.source_commit || '') ||
      release.carr_source_commit !== catalog.carr_source_commit ||
      !Array.isArray(catalog.controls) || !catalog.controls.length) return empty();
  let tree;
  try {
    ({ stdout: tree } = await execute('git', ['ls-tree', '-r', '-z', release.source_commit],
      { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, signal }));
  } catch { signal?.throwIfAborted(); return empty(); }
  if (sha(applicationSource(tree)) !== catalog.application_source_sha256) return empty();
  const identities = new Set();
  for (const proof of catalog.controls) {
    if (typeof proof?.identity !== 'string' || !proof.identity.startsWith('[') ||
        identities.has(proof.identity) || !Array.isArray(proof.effects) || !proof.review?.policy) return empty();
    identities.add(proof.identity);
  }
  preparation.state = 'prepared';
  return { preparation, proofs: catalog.controls.map(({ identity, effects }) =>
    ({ identity: canonicalIdentity(identity), effects: structuredClone(effects), release: { ...release } })) };
}
