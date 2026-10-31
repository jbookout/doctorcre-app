import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { join } from 'node:path';
import { auditLoops, loopSites, scanLoops } from '../scripts/client-loop-guard.mjs';

test('every client timer, reconnect, retry and read loop has a current audited boundary', async () => {
  const inventory = JSON.parse(await readFile('test/loop-inventory.json', 'utf8'));
  assert.deepEqual(auditLoops(await scanLoops(process.cwd()), inventory), []);
});

test('guard detects multiline timers, recursive timeouts, reconnects, retry helpers and pagination', () => {
  const sites = loopSites(`setInterval\n(() => read(), 1000); function again() { setTimeout(again, 1); }
    const later = window.setTimeout; later(again, 1);
    const { setInterval: repeat } = window; repeat(read, 1); window['setInterval'](read, 1);
    new EventSource('/events'); new WebSocket('/socket'); reconnect(); retry(read); configure({retryDelay: 1});
    for (let page = 0; page < total; page++) await readPage(page);
    do { await readPage(); } while (cursor); while (more) await readPage();`, 'scratch.js');
  for (const kind of ['setInterval', 'setTimeout', 'EventSource', 'WebSocket', 'retry', 'retry-option', 'loop']) assert.ok(sites.some(site => site.kind === kind), kind);
  assert.equal(sites.filter(site => site.kind === 'setInterval').length, 3, 'direct, destructured and computed calls');
  assert.equal(sites.filter(site => site.kind === 'setTimeout').length, 2, 'recursive and aliased calls');
  assert.equal(auditLoops(sites, {}).length, sites.length);
});

test('an unbounded loop in a scratch file fails the guard', async t => {
  const dir = temporaryDirectory('client-loop-mutation-', t);
  {
    const path = join(dir, 'unbounded.js');
    await writeFile(path, 'function poll() { setTimeout(poll, 1); } poll();');
    const errors = auditLoops(loopSites(await readFile(path, 'utf8'), path), {});
    assert.equal(errors.length, 1);
    assert.match(errors[0], /setTimeout is unaudited/);
  }
});

test('changing an approved loop invalidates its inventory and all boundary fields are required', () => {
  const sites = loopSites('setInterval(read, 1000)', 'scratch.js');
  assert.equal(auditLoops(sites, { [sites[0].id]: {} }).length, 3);
  const approved = { [sites[0].id]: {cap: '20', backoff: 'exponential', idleStop: 'hidden'} };
  assert.deepEqual(auditLoops(sites, approved), []);
  assert.equal(auditLoops(loopSites('setInterval(read, 1)', 'scratch.js'), approved).length, 2);
  assert.equal(auditLoops(loopSites('const cap = Infinity; setInterval(read, 1000)', 'scratch.js'), approved).length, 2, 'changing a surrounding cap also requires review');
});

test('guard scans executable JS/TS variants and HTML script end tags with whitespace', async t => {
  const root = temporaryDirectory('client-loop-extensions-', t);
  await Promise.all(['js', 'src', 'reports', 'tours', 'public-shell'].map(dir => mkdir(join(root, dir))));
  for (const extension of ['jsx', 'mts', 'cts']) await writeFile(join(root, 'js', `unbounded.${extension}`), 'setInterval(read, 1);');
  await writeFile(join(root, 'inline.html'), '<script>setInterval(read, 1);</script >');
  assert.equal(auditLoops(await scanLoops(root), {}).length, 4);
});
