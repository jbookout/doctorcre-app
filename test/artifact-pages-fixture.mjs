import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact, verifyArtifact } from '../scripts/artifact.mjs';

let pages;
export async function hasArtifactPage(page) {
  pages ||= (async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'doctorcre-page-fixture-'));
    try {
      const built = await buildArtifact({ root: fileURLToPath(new URL('../', import.meta.url)), outDir, commit: '1'.repeat(40) });
      return new Set(verifyArtifact(built.archive, built.archiveSha256).manifest.files.map(file => file.path));
    } finally { await rm(outDir, { recursive: true, force: true }); }
  })();
  return (await pages).has(page);
}
