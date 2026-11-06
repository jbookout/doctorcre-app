import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { createServer } from './proof-fixture-server.mjs';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { prove } from '../scripts/prove-home-overdue-task-slice.mjs';
const exec = promisify(execFile);
let out;
before(async () => { out = temporaryDirectory('overdue-cli-'); await buildArtifact({ root: process.cwd(), outDir: out }); });
after(async () => rm(out, { recursive: true, force: true }));
async function fixture(t, mode = 'pass') {
  const root = resolve(out, 'site');
  const server = createServer(async (req, res) => {
    if (req.url === '/app-release') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }));
    try {
      const path = decodeURIComponent(req.url);
      if (/%2e|%5c|%00/i.test(req.url) || path.includes('\\') || path.includes('\0')) throw Error();
      const file = resolve(root, path.slice(1));
      if (!file.startsWith(root + sep)) throw Error();
      let body = await readFile(file);
      if (mode === 'fail') body = Buffer.from(body.toString().replaceAll('"Overdue"', '"Broken overdue"'));
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
for (const mode of ['pass', 'fail']) test(`proof CLI ${mode} through production v5 parser`, async t => {
  const origin = await fixture(t, mode);
  let result;
  try { result = { ...await exec(process.execPath, ['scripts/prove-home-overdue-task-slice.mjs', '--origin', origin], { timeout: 40000 }), code: 0 }; }
  catch (error) { result = error; }
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(result.code, mode === 'pass' ? 78 : 1, result.stdout + result.stderr);
  assert.equal(receipt.ok, mode === 'pass');
  assert.equal(receipt.natural_acceptance.status, 'insufficient_evidence');
  if (mode === 'pass') { assert.equal(receipt.deployed_asset_fixture.status, 'passed'); assert.ok(receipt.assets.length > 1); }
});
for (const mode of ['late launch', 'stalled evaluation']) test(`proof closes acquired browser after ${mode}`, async t => {
  const origin = await fixture(t);
  let acquired, pending;
  const engine = { launch: () => {
    pending = (async () => {
      acquired = await chromium.launch({ headless: true, args: [...CHROMIUM_SAFETY_ARGS] });
      if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 1200));
      return mode === 'late launch' ? acquired : new Proxy(acquired, { get(target, key) {
        if (key === 'newContext') return () => new Promise(() => {});
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    })();
    return pending;
  } };
  t.after(async () => { await pending; await acquired?.close(); });
  await assert.rejects(prove({ origin, timeoutMs: 1000, engine }), error => error.exitCode === 78);
  await pending;
  if (acquired.isConnected()) await new Promise(resolve => acquired.once('disconnected', resolve));
  assert.equal(acquired.isConnected(), false, 'owned real browser closed, including late acquisition');
});
