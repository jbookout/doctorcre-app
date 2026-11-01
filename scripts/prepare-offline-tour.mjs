import { readFile, writeFile } from 'node:fs/promises';
import { offlineTourShell } from './offline-tour-shell.mjs';
import { UI_OUTPUT, uiBundle } from './ui-bundle.mjs';
const root = new URL('../', import.meta.url);
await writeFile(new URL(UI_OUTPUT, root), await uiBundle(path => readFile(new URL(path, root))));
const shell = await offlineTourShell(path => readFile(new URL(path, root)));
await writeFile(new URL('tours/day-shell.generated.js', root), `self.TOUR_DAY_SHELL = ${JSON.stringify(shell)};\n`);
