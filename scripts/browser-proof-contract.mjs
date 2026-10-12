import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Product coverage is owned by the manifest; every consumer derives its file
// set from those entries rather than maintaining another journey list.
export const requiredNativeEntries = JSON.parse(await readFile(new URL('../tests/journeys/required-coverage.json', import.meta.url), 'utf8')).tests;
export const journeyFiles = [...new Set(requiredNativeEntries.map(row => row.file))];
export const continuityCases = [320, 390, 844].flatMap(width =>
  ['reduce', 'no-preference'].map(motion => ({ width, motion, id: `continuity-${width}-${motion}` })));

export function validateNativeCompletion(native, sourceCommit, entries = requiredNativeEntries) {
  const run = native?.run;
  if (run?.vcs?.commit !== sourceCommit || run.vcs.dirty !== false || run.exitCode !== 0 || run.status !== 'passed' || !run.id)
    throw Error('native runner failed or source identity changed');
  const selected = run.results.filter(row => row.selected);
  if (!selected.length || selected.some(row => row.status !== 'passed' || row.attempts?.length !== 1))
    throw Error('native results incomplete');
  for (const {file, title} of entries) {
    const id = `${file}::${encodeURIComponent(title)}`;
    if (selected.filter(row => row.testId === id && row.file === file).length !== 1)
      throw Error(`required native entry point incomplete: ${id}`);
  }
  return selected.length;
}

// Producer and receipt reader share the manifest, qualification and invocation
// rules. The packet digest is checked by the reader against the actual bytes.
export function validateBrowserCompletion({native, packet, coverage, sourceCommit, workflowRunId, attempt, entries = requiredNativeEntries}) {
  const nativeCount = validateNativeCompletion(native, sourceCommit, entries);
  if (packet?.schema !== 'browser-product-proof.v1') throw Error('browser packet schema mismatch');
  for (const binding of [packet.binding, coverage?.binding]) {
    if (binding?.repo !== 'jbookout/doctorcre-app' || binding.sourceCommit !== sourceCommit ||
        binding.runId !== native.run.id || binding.workflowRunId !== workflowRunId || binding.attempt !== attempt)
      throw Error('browser invocation binding mismatch');
  }
  const required = [...new Set(entries.map(({file}) => file.split('/').at(-1).replace(/\.e2e\.ts$/, ''))), ...continuityCases.map(({id}) => id)];
  if (!Array.isArray(coverage.rows) || coverage.rows.length !== required.length ||
      coverage.rows.some(row => !required.includes(row.id) || row.status !== 'passed' || row.attempts !== 1) ||
      required.some(id => coverage.rows.filter(row => row.id === id).length !== 1))
    throw Error('required journey or continuity incomplete');
  if (coverage.qualification?.broken !== 'failed' || coverage.qualification.repaired !== 'passed')
    throw Error('browser qualification failed');
  return nativeCount;
}

// Called against the origin used by the test, never a separate proof server.
// Hash the full manifest bytes so a matching commit alone cannot certify a
// different build. The producer obtains this digest from the verified archive.
export async function assertServedBuild(origin, expected) {
  const response = await fetch(new URL('/artifact-manifest.json', origin), { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw Error(`served build manifest unavailable: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const manifest = JSON.parse(bytes);
  if (manifest.source_commit !== expected.sourceCommit) throw Error('served build source commit mismatch');
  const manifestDigest = createHash('sha256').update(bytes).digest('hex');
  if (manifestDigest !== expected.manifestDigest) throw Error('served build manifest digest mismatch');
  return { sourceCommit: manifest.source_commit, manifestDigest };
}
