import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { handleDoctorcreRequest } from '../src/worker.js';
import { createServer } from './proof-fixture-server.mjs';
import { prove } from '../scripts/prove-calendar-coverage-notes-panels.mjs';

const exec = promisify(execFile);
let outDir;
before(async () => { outDir = temporaryDirectory('coverage-proof-'); await buildArtifact({ root: process.cwd(), outDir }); });
after(() => rm(outDir, { recursive: true, force: true }));
async function fixture(t, mode) {
  const root = resolve(outDir, 'site');
  const server = createServer(async (req, res) => {
    if (req.url === '/app-release') {
      const release = await handleDoctorcreRequest(new Request('https://fixture.invalid/app-release'), { APP_ENV: 'production', GIT_SHA: '1'.repeat(40) });
      res.writeHead(release.status, Object.fromEntries(release.headers)).end(await release.text());
      return;
    }
    try {
      const path = decodeURIComponent(req.url);
      if (/%2e|%5c|%00/i.test(req.url) || path.includes('\\') || path.includes('\0')) throw Error('unsafe');
      const file = resolve(root, path.slice(1));
      if (!file.startsWith(root + sep)) throw Error('outside root');
      const body = mode === 'broken' && path === '/js/ui-calendar-panels.js'
        ? 'export async function mountCalendarPanels(left) {return {render(){left.textContent="old behavior"},clear(){}}}' : await readFile(file);
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
for (const mode of ['pass', 'broken']) test(`proof CLI fixture ${mode}`, async t => {
  const origin = await fixture(t, mode);
  let result;
  try { result = { ...await exec(process.execPath, ['scripts/prove-calendar-coverage-notes-panels.mjs', '--origin', origin, '--timeout-ms', '30000'], { timeout: 40000 }), code: 0 }; }
  catch (error) { result = error; }
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(result.code, mode === 'pass' ? 0 : 1, result.stdout + result.stderr);
  assert.equal(receipt.ok, mode === 'pass');
  assert.equal(receipt.production_acceptance, false);
  if (mode === 'pass') {
    assert.equal(receipt.natural_authenticated_observation.status, 'insufficient_evidence');
    assert.equal(receipt.release.source_commit, '1'.repeat(40));
    assert.ok(receipt.requests <= 64 && receipt.bytes <= 16 * 1024 * 1024);
  }
});
for (const mode of ['stalled evaluation', 'late launch']) test(`proof closes owned browser after ${mode}`, async t => {
  const origin = await fixture(t, 'pass');
  let acquired, evaluationEntered = false;
  const engine = { async launch(options) {
    acquired = await chromium.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])] });
    if (mode === 'late launch') {
      await new Promise(resolve => setTimeout(resolve, 2500));
      return acquired;
    }
    return new Proxy(acquired, { get(target, key) {
      if (key === 'newContext') return async (...args) => {
        const context = await target.newContext(...args);
        return new Proxy(context, { get(target, key) {
          if (key === 'newPage') return async (...args) => {
            const page = await target.newPage(...args);
            return new Proxy(page, { get(target, key) {
              if (key === 'evaluate') return () => { evaluationEntered = true; return new Promise(() => {}); };
              const value = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            } });
          };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  t.after(() => acquired?.close());
  await assert.rejects(prove({ origin, timeoutMs: 2000, engine }), error => error.exitCode === 78);
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.ok(acquired, 'browser acquired by this run');
  if (mode === 'stalled evaluation') assert.equal(evaluationEntered, true);
  assert.equal(acquired.isConnected(), false, 'zero surviving owned browser connections');
});
