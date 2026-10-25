import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('installed shell answers from its cache despite hung or unsuccessful network reads', async () => {
  const source = await readFile(new URL('../tours/day-sw.js', import.meta.url), 'utf8');
  for (const network of [() => new Promise(() => {}), async () => new Response('Unavailable', { status: 503 })]) {
    const handlers = {};
    const sandbox = { URL, Response, fetch: network, importScripts() {},
      self: { TOUR_DAY_SHELL: { cache: 'synthetic-version', files: ['/tours/day.html'] }, location: { origin: 'https://synthetic.test' }, addEventListener(type, handler) { handlers[type] = handler; } },
      caches: { async open(name) { assert.equal(name, 'synthetic-version'); return { async match(path) { assert.equal(path, '/tours/day.html'); return new Response('Saved shell'); } }; } } };
    runInNewContext(source, sandbox);
    let response;
    handlers.fetch({ request: new Request('https://synthetic.test/tours/day.html?tour=synthetic'), respondWith(value) { response = value; } });
    let timer;
    try {
      const result = await Promise.race([response, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('saved shell stalled on network')), 100); })]);
      assert.equal(await result.text(), 'Saved shell');
    } finally { clearTimeout(timer); }
    for (const path of ['/api/tours/detail', '/auth/session', '/audio/synthetic.webm', 'https://tiles.example.test/tile']) {
      handlers.fetch({ request: new Request(new URL(path, 'https://synthetic.test')), respondWith() { assert.fail('private or provider response intercepted'); } });
    }
  }
});
test('offline shell follows HTML, transitive imports and worker URLs, without API or remote data', async () => {
  const { offlineTourShell } = await import('../scripts/offline-tour-shell.mjs');
  const sources = new Map([
    ['tours/day.html', '<link href="/tours/day.css"><script src="/js/app-shell.js"></script>'],
    ['tours/day.css', '@import url("../css/tokens.css"); @import "../css/layout.css";'],
    ['css/tokens.css', '@import url("https://example.test/remote.css");'],
    ['css/layout.css', '@import "./tokens.css";'],
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
