import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, parse } from 'es-module-lexer';
import { sliceOutputs } from '../slices.mjs';
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
const safePath = path => typeof path === 'string' && path.length > 0 &&
  !path.startsWith('/') && !path.split('/').includes('..') && posix.normalize(path) === path;

// Read committed bytes only, including the same generated slice registry the
// artifact builder derives. Never inspect a checkout's working files.
function sourceReader(git, commit, tree) {
  const entries = new Map(tree.split('\0').filter(Boolean).map(row => {
    const [metadata, path] = row.split('\t'); return [path, metadata];
  }));
  const cache = new Map();
  let generated;
  const read = async path => {
    if (cache.has(path)) return cache.get(path);
    let text;
    if (path === 'js/slices.generated.js' && !entries.has(path)) {
      const names = [...entries.keys()].filter(path => /^js\/slices\/[^/]+\.js$/.test(path))
        .map(path => posix.basename(path, '.js')).sort();
      generated ||= sliceOutputs(names, read);
      text = (await generated).outputs.get(path).toString('utf8');
    } else {
      if (!entries.get(path)?.startsWith('100644 blob ') && !entries.get(path)?.startsWith('100755 blob '))
        throw new Error(`Cannot inspect reviewed source: ${path} at ${commit}`);
      text = await git('show', `${commit}:${path}`);
    }
    cache.set(path, text); return text;
  };
  return read;
}

// A proof is bound to the bytes a reviewer read: its handler source and that
// file's static and literal dynamic import closure at one commit. Every
// reviewed path maps to its SHA-256, so files outside every closure never
// touch the catalog and an import added to a reviewed file changes its digest.
export async function reviewedSourceDigests(commit, controls, { cwd = root, signal } = {}) {
  const git = async (...args) => (await execute('git', args, {
    cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024, signal,
  })).stdout;
  const read = sourceReader(git, commit, await git('ls-tree', '-r', '-z', commit));
  const digests = new Map();
  await init;
  async function visit(path) {
    if (!safePath(path)) throw new Error(`Invalid reviewed source path: ${path}`);
    if (digests.has(path)) return;
    digests.set(path, null);
    const source = await read(path);
    digests.set(path, sha(source));
    if (!/\.m?js$/.test(path)) return;
    for (const dependency of parse(source, path)[0]) {
      if (dependency.d === -2) continue; // import.meta is not a dependency.
      if (!dependency.n) throw new Error(`Cannot resolve computed import in reviewed source: ${path}`);
      const specifier = dependency.n;
      if (!specifier.startsWith('.') && !specifier.startsWith('/'))
        throw new Error(`Cannot resolve import ${specifier} in reviewed source: ${path}`);
      await visit(specifier.startsWith('/') ? specifier.slice(1) : posix.join(posix.dirname(path), specifier));
    }
  }
  for (const proof of controls) {
    if (typeof proof?.review?.source !== 'string') throw new Error('Control proof is missing review.source');
    await visit(proof.review.source.replace(/:\d+(?::\d+)?$/, ''));
  }
  return Object.fromEntries([...digests].sort(([a], [b]) => a < b ? -1 : 1));
}

// Reviewed paths whose bytes differ, appeared or disappeared since the review.
export const unreviewedSources = (pinned, current) =>
  [...new Set([...Object.keys(pinned), ...Object.keys(current)])].filter(path => pinned[path] !== current[path]).sort();

const validDigests = digests => digests && typeof digests === 'object' && !Array.isArray(digests) &&
  Object.entries(digests).length > 0 && Object.entries(digests).every(([path, digest]) => safePath(path) && /^[a-f0-9]{64}$/.test(digest));

// Record preparation runs this before installing any browser guard. No page
// is accepted here and no grant is inferred from a discovered control.
export async function prepareBrowserControlProofs(release, { signal } = {}) {
  const preparation = { schema: catalog.schema, release: { ...release },
    catalog_sha256: sha(JSON.stringify(catalog)), state: 'unreviewed-source' };
  const empty = () => ({ preparation, proofs: [] });
  if (catalog.schema !== 'doctorcre-staging-control-proofs.v1' ||
      !/^[a-f0-9]{40}$/.test(release?.source_commit || '') ||
      release.carr_source_commit !== catalog.carr_source_commit || !validDigests(catalog.reviewed_sources) ||
      !Array.isArray(catalog.controls) || !catalog.controls.length) return empty();
  let current;
  try { current = await reviewedSourceDigests(release.source_commit, catalog.controls, { signal }); }
  catch { signal?.throwIfAborted(); return empty(); }
  const unreviewed = unreviewedSources(catalog.reviewed_sources, current);
  if (unreviewed.length) { preparation.unreviewed_sources = unreviewed; return empty(); }
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
