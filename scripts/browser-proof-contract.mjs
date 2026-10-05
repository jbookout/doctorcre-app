import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Product coverage is owned by the manifest; every consumer derives its file
// set from those entries rather than maintaining another journey list.
export const requiredNativeEntries = JSON.parse(await readFile(new URL('../tests/journeys/required-coverage.json', import.meta.url), 'utf8')).tests;
export const journeyFiles = [...new Set(requiredNativeEntries.map(row => row.file))];
export const continuityCases = [320, 390, 844].flatMap(width =>
  ['reduce', 'no-preference'].map(motion => ({ width, motion, id: `continuity-${width}-${motion}` })));

export function assertNativeJourneys(results, targets) {
  for (const target of targets) for (const entry of requiredNativeEntries) {
    const id = `${entry.file}::${encodeURIComponent(entry.title)}`;
    const rows = results.filter(row => row.testId === id && row.targetId === target && row.selected);
    if (rows.length !== 1 || rows[0].status !== 'passed' || rows[0].attempts.length !== 1)
      throw Error(`required native entry point incomplete: ${target}/${id}`);
  }
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
