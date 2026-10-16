import test from 'node:test';
import assert from 'node:assert/strict';
test('offline shell follows HTML, transitive imports and worker URLs, without API or remote data', async () => {
  const { offlineTourShell } = await import('../scripts/offline-tour-shell.mjs');
  const sources = new Map([
    ['tours/day.html', '<link href="/tours/day.css"><script src="/js/app-shell.js"></script>'],
    ['tours/day.css', '/* synthetic style */'],
    ['js/app-shell.js', 'import { routeContract } from "./routes.js"; fetch("/api/private"); new URL("../data/board-seed.json", import.meta.url);'],
    ['js/routes.js', 'import "./app-shell.js"; import("https://example.test/remote.js"); new URL("../tours/worker.mjs", import.meta.url);'],
    ['tours/worker.mjs', 'import "./shared.mjs";'],
    ['tours/shared.mjs', '// synthetic worker'],
  ]);
  const read = async path => { assert.ok(sources.has(path), `unexpected read: ${path}`); return sources.get(path); };
  const shell = await offlineTourShell(read);
  assert.deepEqual(shell.files, [...sources.keys()].map(path => '/' + path).sort());
  assert.deepEqual(await offlineTourShell(read), shell, 'generation is deterministic');
  sources.set('tours/shared.mjs', '// synthetic changed worker');
  assert.notEqual((await offlineTourShell(read)).cache, shell.cache, 'dependency changes install a new cache');
  sources.delete('tours/shared.mjs');
  await assert.rejects(offlineTourShell(read), /unexpected read/);
});
