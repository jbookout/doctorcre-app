import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from './artifact.mjs';
import { loadFixtureAssets } from './fixture-assets.mjs';
import { temporaryDirectory } from './temp-directory.mjs';

export async function appAssetSnapshot(builtRoot) {
  const scratch = builtRoot ? null : temporaryDirectory('app-asset-snapshot-');
  try {
    const root = builtRoot || join(scratch, 'site');
    const manifest = builtRoot ? JSON.parse(await readFile(join(root, 'artifact-manifest.json'), 'utf8'))
      : (await buildArtifact({ root: process.cwd(), outDir: scratch })).manifest;
    return await loadFixtureAssets({ root, manifest: new Map([
      ...manifest.files.map(row => ['/' + row.path, row.path]),
      ['/artifact-manifest.json', 'artifact-manifest.json'],
    ]) });
  } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
}
