import { rm } from 'node:fs/promises';
import { buildArtifact } from '../scripts/artifact.mjs';
import { loadFixtureAssets } from '../scripts/fixture-assets.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';

export async function proofAssetSnapshot() {
  const root = temporaryDirectory('proof-asset-snapshot-');
  try {
    const { manifest } = await buildArtifact({ root: process.cwd(), outDir: root });
    return await loadFixtureAssets({ root: `${root}/site`, manifest: new Map(manifest.files
      .filter(row => row.path.startsWith('js/')).map(row => ['/' + row.path, row.path])) });
  } finally { await rm(root, { recursive: true, force: true }); }
}
