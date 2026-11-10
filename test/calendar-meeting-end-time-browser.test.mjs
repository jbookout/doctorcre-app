import test from 'node:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { prove } from '../scripts/prove-calendar-meeting-end-time.mjs';

test('both Home panels show Chicago endpoints at mobile and desktop in both themes', async t => {
  const out = temporaryDirectory('meeting-end-browser-');
  t.after(() => rm(out, { recursive: true, force: true }));
  await buildArtifact({ root: process.cwd(), outDir: out });
  await prove({ fixtureRoot: join(out, 'site'), timeoutMs: 60000 });
});
