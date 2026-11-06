import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { checkFixtureSource, checkFixtureServers } from '../scripts/check-fixture-servers.mjs';

for (const source of [
  "import {createServer as start} from 'node:http'; start(() => {});",
  "import * as h from 'http'; h.createServer(() => {});",
  "import h from 'node:https'; new h.Server();",
  "import h from 'node:http'; const {createServer: start} = h;",
  "const h = await import('node:http'); h.createServer();",
  "const {createServer} = require('http');",
  "process.getBuiltinModule('http').createServer();",
  "export {createServer as start} from 'node:http';",
  "export * from 'node:net';",
  "Bun.serve({fetch(){}});",
  "const name = 'node:http'; await import(name);",
  "import h from 'http'; const alias = h; alias['createServer']();",
  "import h from 'http'; h['create' + 'Server']();",
  "import h from 'http'; const {['create' + 'Server']: start} = h;",
  "const broken = ;",
  "process['getBuiltin' + 'Module']('http').createServer();",
  "process?.getBuiltinModule('http').createServer();",
  "module.require('http').createServer();",
  "const load = require; load('http').createServer();",
  "const builtin = process.getBuiltinModule; builtin('http').createServer();",
  "import {createRequire} from 'node:module'; const load = createRequire(import.meta.url); load('http').createServer();",
  "import express from 'express'; express().listen(0);",
]) test(`refuses server capability ${source}`, () => assert.ok(checkFixtureSource(source).errors.length));

for (const source of [
  "const {get} = require('http'); get('http://fixture.invalid');",
  "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url); require.resolve('playwright');",
  "const h = require('http'); h.get('http://fixture.invalid');",
  "const {get} = await import('http'); get('http://fixture.invalid');",
  "import {get, request} from 'node:http'; get('http://fixture.invalid');",
  "import h from 'http'; h.get('http://fixture.invalid');",
  "import * as h from 'node:https'; h.request('https://fixture.invalid');",
  "import {readFile} from 'node:fs/promises'; await readFile('manifest.json');",
  "import {startFixture} from './fixture-http.mjs'; await startFixture({assets: new Map()});",
  "import type {Server} from 'node:http';",
  "const example = \"import {createServer} from 'node:http'\";",
]) test(`admits client, preload or data ${source}`, () => assert.deepEqual(checkFixtureSource(source, 'positive.ts').errors, []));

test('canonical transport refuses filesystem and helper imports', () => {
  assert.ok(checkFixtureSource("import {readFile} from 'node:fs/promises';", 'scripts/fixture-http.mjs').errors.length);
});

test('whole repository guard detects hidden wrappers and outside-directory constructors through its CLI', async t => {
  const root = temporaryDirectory('fixture-guard-', t);
  execFileSync('git', ['init', '-q', root]);
  await mkdir(root + '/scripts');
  await mkdir(root + '/hidden');
  await writeFile(root + '/scripts/fixture-http.mjs', "import {createServer} from 'node:http'; export const startFixture = async () => createServer();");
  await writeFile(root + '/scripts/use.mjs', "import {start} from '../hidden/helper.mjs'; start();");
  await writeFile(root + '/hidden/helper.mjs', 'export const start = () => 1;');
  assert.deepEqual(await checkFixtureServers(root), []);
  for (const source of ["import h from 'http'; export const start = listener => h.createServer(listener);", "export {createServer as start} from 'node:http';"]) {
    await writeFile(root + '/hidden/helper.mjs', source);
    const result = spawnSync(process.execPath, ['scripts/check-fixture-servers.mjs', root], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /hidden\/helper.mjs:1:/);
  }
});


test('fixture helper graphs refuse unknown dynamic loaders and transport helper imports', async t => {
  const root = temporaryDirectory('fixture-graph-', t);
  execFileSync('git', ['init', '-q', root]);
  await mkdir(root + '/scripts');
  await writeFile(root + '/scripts/fixture-http.mjs', 'export const startFixture = async () => {};');
  await writeFile(root + '/scripts/client.mjs', "import {startFixture} from './fixture-http.mjs'; import './helper.mjs';");
  await writeFile(root + '/scripts/helper.mjs', 'export const load = name => import(name);');
  assert.ok((await checkFixtureServers(root)).some(error => /helper.mjs:1: Dynamic/.test(error)));
  await writeFile(root + '/scripts/helper.mjs', 'export const asset = 1;');
  assert.deepEqual(await checkFixtureServers(root), []);
  await writeFile(root + '/scripts/fixture-http.mjs', "import './helper.mjs'; export const startFixture = async () => {};");
  assert.ok((await checkFixtureServers(root)).some(error => /Transport must not import/.test(error)));
});

test('fixed Worker transport graph refuses filesystem capabilities in its router dependencies', async t => {
  const root = temporaryDirectory('fixture-worker-graph-', t);
  execFileSync('git', ['init', '-q', root]);
  await mkdir(root + '/scripts'); await mkdir(root + '/src');
  await writeFile(root + '/scripts/fixture-http.mjs', "import {handleDoctorcreRequest} from '../src/worker.js'; export const startWorkerFixture = async () => {};");
  await writeFile(root + '/src/worker.js', 'export const handleDoctorcreRequest = () => {};');
  assert.deepEqual(await checkFixtureServers(root), []);
  await writeFile(root + '/src/worker.js', "import './assets'; export const handleDoctorcreRequest = () => {};");
  await writeFile(root + '/src/assets.js', "const {readFile} = await import('node:fs/promises');");
  assert.ok((await checkFixtureServers(root)).some(error => /src\/assets.js:1:.*filesystem/.test(error)));
});
