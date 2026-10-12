import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import catalog from '../../contracts/e2e-staging-control-proofs.v1.json' with { type: 'json' };

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const sha = text => createHash('sha256').update(text).digest('hex');
const validDOMObservation = effect =>
  effect && typeof effect.selector === 'string' && effect.selector.length > 0 &&
  (effect.attribute === '$presence' || typeof effect.attribute === 'string' && /^[a-z][a-z0-9-]*$/.test(effect.attribute)) &&
  Object.keys(effect).every(key => ['selector', 'attribute', 'transitions'].includes(key)) &&
  Array.isArray(effect.transitions) && effect.transitions.length > 0 && effect.transitions.every(transition =>
    transition && Object.keys(transition).length === 2 &&
    [transition.from, transition.to].every(value => effect.attribute === '$presence' ? typeof value === 'boolean' : value === null || typeof value === 'string') && transition.from !== transition.to);
const validRequestObservation = effect => effect && Object.keys(effect).length === 1 && effect.request &&
  Object.keys(effect.request).length === 3 && effect.request.path === '/mcp' && effect.request.method === 'POST' &&
  typeof effect.request.operation === 'string' && /^[a-z][a-z0-9-]+$/.test(effect.request.operation);
export const validControlObservations = observations => Array.isArray(observations) && observations.length > 0 &&
  observations.every(effect => validDOMObservation(effect) || validRequestObservation(effect));
export const validControlProof = proof => Array.isArray(proof?.effects) && validControlObservations(proof.observations) &&
  proof.observations.every(effect => !effect.request || proof.effects.some(row => row?.operation === effect.request.operation));
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
    if (typeof proof?.identity !== 'string' || !/^control-state\.v1:[a-f0-9]{64}$/.test(proof.identity) ||
        identities.has(proof.identity) || !proof.review?.policy || !validControlProof(proof)) return empty();
    identities.add(proof.identity);
  }
  preparation.state = 'prepared';
  return { preparation, proofs: catalog.controls.map(({ identity, effects, observations }) =>
    ({ identity, effects: structuredClone(effects), observations: structuredClone(observations), release: { ...release } })) };
}
