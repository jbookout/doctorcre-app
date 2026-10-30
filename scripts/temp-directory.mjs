import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const directories = new Set();
process.once('exit', () => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

export function temporaryDirectory(prefix, owner) {
  const directory = mkdtempSync(resolve(tmpdir(), prefix));
  directories.add(directory);
  owner?.after(() => {
    rmSync(directory, { recursive: true, force: true });
    directories.delete(directory);
  });
  return directory;
}
