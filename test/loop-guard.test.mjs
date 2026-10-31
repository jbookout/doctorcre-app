import { spawnSync } from 'node:child_process';
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
  const approved = { [sites[0].id]: {cap: 20, backoff: 'exponential', idleStop: 'hidden'} };
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

test('lifecycle-driven fetches are detected and unbounded declarations are rejected', () => {
  const sites = loopSites(`window.addEventListener('online', () => fetch('/mcp'));
    window.addEventListener('focus', () => fetch('/mcp'));
    document.addEventListener('visibilitychange', () => fetch('/mcp'));
    window.addEventListener('pageshow', () => fetch('/mcp'));`, 'event-scratch.js');
  assert.equal(sites.filter(site => site.kind === 'event-refresh').length, 4);
  assert.equal(auditLoops(sites, {}).length, 4);
  const [interval] = loopSites('setInterval(read, 1)', 'interval-scratch.js');
  for (const cap of [undefined, 'unbounded', Infinity, NaN, -1]) {
    const errors = auditLoops([interval], { [interval.id]: {cap, backoff:'none', idleStop:'none'} });
    assert.ok(errors.some(error => error.includes('finite cap')), String(cap));
  }
});

test('full guard rejects event-fetch and unbounded-cap scratch mutations', async t => {
 const root=temporaryDirectory('loop-guard-negatives-',t);
 await Promise.all(['js','src','reports','tours','public-shell','test'].map(dir=>mkdir(join(root,dir))));
 const guard=new URL('../scripts/client-loop-guard.mjs',import.meta.url).pathname;
 const path=join(root,'js','scratch.js'), inventory=join(root,'test','loop-inventory.json');
 await writeFile(path,"window.addEventListener('online',()=>fetch('/mcp')); window.addEventListener('focus',()=>fetch('/mcp')); document.addEventListener('visibilitychange',()=>fetch('/mcp')); window.addEventListener('pageshow',()=>fetch('/mcp'));");
 await writeFile(inventory,'{}');
 let result=spawnSync(process.execPath,[guard],{cwd:root,encoding:'utf8'});
 assert.equal(result.status,1);assert.match(result.stderr,/event-refresh is unaudited/);
 const source='setInterval(read, 1);';await writeFile(path,source);
 const [site]=loopSites(source,'js/scratch.js');
 await writeFile(inventory,JSON.stringify({[site.id]:{cap:'unbounded',backoff:'none',idleStop:'none'}}));
 result=spawnSync(process.execPath,[guard],{cwd:root,encoding:'utf8'});
 assert.equal(result.status,1);assert.match(result.stderr,/finite cap number/);
});
