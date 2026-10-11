import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, parse } from 'es-module-lexer';
import { sliceOutputs } from '../slices.mjs';
import { applicationSourceFingerprint } from './control-proofs.mjs';

const execute = promisify(execFile);
const catalogPath = 'contracts/e2e-staging-control-proofs.v1.json';
const safePath = path => typeof path === 'string' && path.length > 0 &&
  !path.startsWith('/') && !path.split('/').includes('..') && posix.normalize(path) === path;

// Read the review graph from immutable Git bytes, including the same generated
// slice registry the artifact builder uses. Never inspect the caller's checkout
// files for handler dependencies or execute those handlers.
async function sourceReader(git, commit, tree) {
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

/** Re-pin only after every reviewed source and its import closure is unchanged. */
export async function repinControlProofs(target, { cwd = process.cwd() } = {}) {
  const git = async (...args) => (await execute('git', args, {
    cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024,
  })).stdout;
  const path = resolve(cwd, catalogPath), original = await readFile(path, 'utf8');
  const catalog = JSON.parse(original);
  if (catalog.schema !== 'doctorcre-staging-control-proofs.v1' ||
      !/^[a-f0-9]{40}$/.test(catalog.reviewed_source_commit || '') ||
      !/^[a-f0-9]{64}$/.test(catalog.application_source_sha256 || '') ||
      !Array.isArray(catalog.controls) || !catalog.controls.length)
    throw new Error('Invalid control-proof catalog');
  if (typeof target !== 'string' || !target.length) throw new Error('Usage: npm run e2e:staging:repin-control-proofs -- <commit>');
  const commit = (await git('rev-parse', '--verify', '--end-of-options', `${target}^{commit}`)).trim();
  const baseline = catalog.reviewed_source_commit;
  const oldTree = await git('ls-tree', '-r', '-z', baseline);
  const newTree = await git('ls-tree', '-r', '-z', commit);
  if (applicationSourceFingerprint(oldTree) !== catalog.application_source_sha256)
    throw new Error('Catalog fingerprint does not match reviewed_source_commit');
  const oldRead = await sourceReader(git, baseline, oldTree);
  const newRead = await sourceReader(git, commit, newTree);
  const changed = new Set((await git('diff', '--no-renames', '--name-only', '-z', baseline, commit, '--')).split('\0').filter(Boolean));
  const reviewed = new Set(), refused = new Set();
  await init;
  async function visit(path) {
    if (!safePath(path)) throw new Error(`Invalid reviewed source path: ${path}`);
    if (reviewed.has(path)) return;
    reviewed.add(path);
    if (changed.has(path)) refused.add(path);
    const source = await oldRead(path);
    if (path === 'js/slices.generated.js' && source !== await newRead(path)) refused.add(path);
    if (!/\.m?js$/.test(path)) return;
    for (const dependency of parse(source, path)[0]) {
      if (dependency.d === -2) continue; // import.meta is not a dependency.
      if (!dependency.n) throw new Error(`Cannot resolve computed import in reviewed source: ${path}`);
      const specifier = dependency.n;
      if (!specifier.startsWith('.') && !specifier.startsWith('/'))
        throw new Error(`Cannot resolve import ${specifier} in reviewed source: ${path}`);
      const imported = specifier.startsWith('/') ? specifier.slice(1) : posix.join(posix.dirname(path), specifier);
      await visit(imported);
    }
  }
  for (const proof of catalog.controls) {
    const source = proof.review?.source;
    if (typeof source !== 'string') throw new Error('Control proof is missing review.source');
    await visit(source.replace(/:\d+(?::\d+)?$/, ''));
  }
  if (refused.size) throw new Error(`Control proofs require re-review; changed reviewed files:\n${[...refused].sort().join('\n')}`);
  const fingerprint = applicationSourceFingerprint(newTree);
  // Change only the two binding fields, preserving reviewed proof bytes and
  // catalog formatting. All validation completes before the single write.
  const updated = original.replace(/("reviewed_source_commit"\s*:\s*")[a-f0-9]{40}/, (_, prefix) => prefix + commit);
  const output = updated.replace(/("application_source_sha256"\s*:\s*")[a-f0-9]{64}/, (_, prefix) => prefix + fingerprint);
  await writeFile(path, output);
  return { reviewed_source_commit: commit, application_source_sha256: fingerprint, reviewed_sources: [...reviewed].sort() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  repinControlProofs(process.argv.length === 3 ? process.argv[2] : undefined)
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
