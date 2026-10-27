import { mkdtempSync, rmSync } from 'node:fs';

const directories = new Set();
process.once('exit', () => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

export function temporaryDirectory(prefix) {
  const directory = mkdtempSync(prefix);
  directories.add(directory);
  return directory;
}
