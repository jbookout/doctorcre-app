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
  "import {createServer as start} from './missing-listener-wrapper.mjs'; start(() => {});",
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
  for (const source of ["import h from 'http'; export const start = listener => h.createServer(listener);", "export {createServer as start} from 'node:http';",
    "const name = process.env.SYNTHETIC_MODULE; const h = await import(name); export const start = () => h.createServer();",
    "const name = process.env.SYNTHETIC_MODULE; const h = await import(name); const start = h['create' + 'Server']; start();",
    "const name = process.env.SYNTHETIC_MODULE; const h = await import(name); export const start = () => new h.Server();",
  ]) {
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
  await writeFile(root + '/src/worker.js', "import './packet.json' with { type: 'json' }; export const handleDoctorcreRequest = () => {};");
  await writeFile(root + '/src/packet.json', '{"stops": []}');
  assert.deepEqual(await checkFixtureServers(root), []);
  await writeFile(root + '/src/packet.json', '{"stops": unknown}');
  await assert.rejects(checkFixtureServers(root), SyntaxError);
  await writeFile(root + '/src/packet.json', '{"stops": []}');
  await writeFile(root + '/src/worker.js', "import './assets'; export const handleDoctorcreRequest = () => {};");
  await writeFile(root + '/src/assets.js', "const {readFile} = await import('node:fs/promises');");
  assert.ok((await checkFixtureServers(root)).some(error => /src\/assets.js:1:.*filesystem/.test(error)));
});

test('finite query-only module retries resolve all branches and unknown alternatives still refuse', () => {
  const result = checkFixtureSource("const VIEW = './view.js'; let attempt = 0; const module = () => attempt ? `${VIEW}?retry=${attempt}` : VIEW; await import(module());");
  assert.deepEqual(result.errors,[]);
  assert.deepEqual(result.imports,['./view.js']);
  assert.ok(checkFixtureSource("let name; const module = () => name ? './view.js' : name; await import(module());").errors.length);
  assert.ok(checkFixtureSource("let name; await import(`${name}?retry=1`);").errors.length);
});

test('the generated UI module graph resolves the app call and queue imports from checked-out source', async () => {
  const errors = await checkFixtureServers();
  assert.equal(errors.some(error => /Unresolved fixture helper.*ui-(call|queue)\.generated\.js/.test(error)),false,errors.join('\n'));
});

test('root-relative browser imports resolve the actual source graph and refuse hidden servers', async t => {
  const root = temporaryDirectory('fixture-browser-graph-', t);
  execFileSync('git', ['init', '-q', root]);
  await mkdir(root + '/scripts'); await mkdir(root + '/js');
  await writeFile(root + '/scripts/fixture-http.mjs', 'export const startFixture = async () => {};');
  await writeFile(root + '/scripts/use.mjs', "import {startFixture} from './fixture-http.mjs'; await page.evaluate(async () => import('/js/view.js'));");
  await writeFile(root + '/js/view.js', 'export const view = 1;');
  assert.deepEqual(await checkFixtureServers(root), []);
  await writeFile(root + '/js/view.js', "export {createServer} from 'node:http';");
  assert.ok((await checkFixtureServers(root)).some(error => /js\/view.js:1:.*Server construction/.test(error)));
  await writeFile(root + '/js/view.js', 'await import(unknown);');
  assert.ok((await checkFixtureServers(root)).some(error => /js\/view.js:1:.*Dynamic/.test(error)));
});

test('finite private URL loader follows every literal call and refuses escaped functions', () => {
  const source = "const sibling = path => import(new URL(path, import.meta.url).href); await sibling('./one.js'); await sibling('./two.js');";
  assert.deepEqual(checkFixtureSource(source).errors, []);
  assert.deepEqual(checkFixtureSource(source).imports, ['./one.js', './two.js']);
  assert.ok(checkFixtureSource(source + ' publish(sibling);').errors.length);
  assert.ok(checkFixtureSource(source + ' sibling(unknown);').errors.length);
  assert.ok(checkFixtureSource(source.replace('path => import', 'path => { path = unknown; return import').replace('.href);', '.href); };')).errors.length);
});

test('generated data-module graphs inspect actual compiler output and refuse unknown byte producers', async t => {
  const root = temporaryDirectory('fixture-generated-graph-', t);
  execFileSync('git', ['init', '-q', root]);
  await mkdir(root + '/scripts'); await mkdir(root + '/source');
  await writeFile(root + '/scripts/fixture-http.mjs', 'export const startFixture = async () => {};');
  const consumer = "import {startFixture} from './fixture-http.mjs'; import {build} from 'esbuild'; const bundle = await build({entryPoints:['source/view.js'], bundle:true, write:false, platform:'node', format:'esm'}); await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);";
  await writeFile(root + '/scripts/use.mjs', consumer);
  await writeFile(root + '/source/view.js', 'export const view = 1;');
  assert.deepEqual(await checkFixtureServers(root), []);
  await writeFile(root + '/source/view.js', "export {createServer} from 'node:http';");
  assert.ok((await checkFixtureServers(root)).some(error => /Server construction/.test(error)));
  await writeFile(root + '/scripts/use.mjs', consumer.replace("import {build} from 'esbuild';", 'const build = unknown;'));
  assert.ok((await checkFixtureServers(root)).some(error => /Dynamic module/.test(error)));
});

test('compiler provenance refuses modified output, shadowed buffers, plugins and unknown entries', async t => {
  const root = temporaryDirectory('fixture-compiler-refusal-', t);
  execFileSync('git', ['init', '-q', root]);
  await mkdir(root + '/scripts'); await mkdir(root + '/source');
  await writeFile(root + '/scripts/fixture-http.mjs', 'export const startFixture = async () => {};');
  await writeFile(root + '/source/view.js', 'export const view = 1;');
  const before = "import {startFixture} from './fixture-http.mjs'; import {build} from 'esbuild'; const bundle = await build({entryPoints:['source/view.js'],bundle:true,write:false,platform:'node',format:'esm'});";
  const load = "await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);";
  for (const source of [before + 'bundle.outputFiles[0].text = unknown;' + load,
    before + 'const Buffer = unknown;' + load,
    before.replace("entryPoints:['source/view.js']", 'entryPoints:unknown') + load,
    before.replace('bundle:true', 'plugins:unknown,bundle:true') + load,
    before.replace('bundle:true', '...unknown,bundle:true') + load,
    before.replace('const bundle', 'let bundle') + 'bundle = unknown;' + load]) {
    await writeFile(root + '/scripts/use.mjs', source);
    assert.ok((await checkFixtureServers(root)).some(error => /Dynamic module/.test(error)), source);
  }
});
