import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const sourceDirs = ['js', 'src', 'reports', 'tours'];
const pattern = /\b(?:setInterval|setTimeout|EventSource|WebSocket|requestAnimationFrame)\s*\(|\bwhile\s*\(|\bdo\s*\{|\b(?:retryDelay|refetchInterval)\b/;
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => {
    if (entry.name === 'vendor') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.(?:js|mjs|ts|tsx)$/.test(path) ? [path] : [];
  }))).flat();
}
test('every timer, reconnect and potential read loop has an audited boundary', async () => {
  const approved = JSON.parse(await readFile('test/loop-inventory.json', 'utf8'));
  const found = [];
  for (const dir of sourceDirs) for (const path of await files(dir)) {
    const lines = (await readFile(path, 'utf8')).split('\n');
    for (const line of lines) if (pattern.test(line) && !/^\s*\/\//.test(line)) found.push(`${path}: ${line.trim()}`);
  }
  assert.deepEqual(found.sort(), Object.keys(approved).sort(), 'audit every changed or new loop and record its boundary');
  for (const [site, boundary] of Object.entries(approved)) assert.ok(boundary, `missing boundary for ${site}`);
});
