import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewedSourceDigests, unreviewedSources } from './control-proofs.mjs';

const execute = promisify(execFile);
const catalogPath = 'contracts/e2e-staging-control-proofs.v1.json';
const usage = 'Usage: npm run e2e:staging:repin-control-proofs -- <commit> [--reviewed <path>]...';

/**
 * Re-pin reviewed handler digests after a human re-reviewed the proofs that
 * depend on each changed file. Every changed reviewed path must be named;
 * files outside every review closure never need a re-pin.
 */
export async function repinControlProofs(target, { reviewed = [], cwd = process.cwd() } = {}) {
  const path = resolve(cwd, catalogPath), original = await readFile(path, 'utf8');
  const catalog = JSON.parse(original);
  if (catalog.schema !== 'doctorcre-staging-control-proofs.v1' || !catalog.reviewed_sources ||
      typeof catalog.reviewed_sources !== 'object' || !Array.isArray(catalog.controls) || !catalog.controls.length)
    throw new Error('Invalid control-proof catalog');
  if (typeof target !== 'string' || !target.length || target.startsWith('-')) throw new Error(usage);
  const commit = (await execute('git', ['rev-parse', '--verify', '--end-of-options', `${target}^{commit}`],
    { cwd, encoding: 'utf8', timeout: 5000 })).stdout.trim();
  const current = await reviewedSourceDigests(commit, catalog.controls, { cwd });
  const changed = unreviewedSources(catalog.reviewed_sources, current);
  const unnamed = changed.filter(path => !reviewed.includes(path));
  if (unnamed.length) throw new Error(`Control proofs require re-review; changed reviewed files:\n${unnamed.join('\n')}\n` +
    'Re-review every proof whose closure includes them, then pass --reviewed <path> for each.');
  const unchanged = reviewed.filter(path => !changed.includes(path));
  if (unchanged.length) throw new Error(`Not a changed reviewed file:\n${unchanged.join('\n')}`);
  // Rewrite only the digest map, preserving reviewed proof bytes and catalog
  // formatting. All validation completes before the single write.
  const block = '"reviewed_sources": ' + JSON.stringify(current, null, 2).replace(/\n/g, '\n  ');
  await writeFile(path, original.replace(/"reviewed_sources"\s*:\s*\{[^}]*\}/, () => block));
  return { source_commit: commit, reviewed: changed, reviewed_sources: current };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [target, ...flags] = process.argv.slice(2), reviewed = [];
  for (let i = 0; i < flags.length; i += 2) {
    if (flags[i] !== '--reviewed' || !flags[i + 1]) { console.error(usage); process.exit(1); }
    reviewed.push(flags[i + 1]);
  }
  repinControlProofs(target, { reviewed })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
