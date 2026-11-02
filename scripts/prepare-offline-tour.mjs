import { readFile, writeFile } from 'node:fs/promises';
import { offlineTourShell } from './offline-tour-shell.mjs';
import { uiAssets } from './ui-bundle.mjs';
const root = new URL('../', import.meta.url);
for (const [path, bytes] of await uiAssets(path => readFile(new URL(path, root)))) {
  await writeFile(new URL(path, root), bytes);
}
const shell = await offlineTourShell(path => readFile(new URL(path, root)));
await writeFile(new URL('tours/day-shell.generated.js', root), `self.TOUR_DAY_SHELL = ${JSON.stringify(shell)};\n`);
