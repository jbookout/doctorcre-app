import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { createServer } from './proof-fixture-server.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { prove } from '../scripts/prove-home-loaded-card-search.mjs';
const exec = promisify(execFile);
let outDir;
before(async () => { outDir = temporaryDirectory('loaded-proof-'); await buildArtifact({ root: process.cwd(), outDir }); });
after(async () => rm(outDir, { recursive: true, force: true }));
async function fixture(t, broken = false) {
  const root = resolve(outDir, 'site');
  const server = createServer(async (req, res) => {
    if (req.url === '/app-release') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }));
    try {
      const path = decodeURIComponent(req.url);
      const file = resolve(root, path.slice(1));
      if (!file.startsWith(root + sep) || path.includes('\\') || path.includes('\0') || /%2e|%5c|%00/i.test(req.url)) return res.writeHead(404).end();
      const body = broken && path === '/js/ui-inbox.js' ? 'document.body.textContent="broken";' : await readFile(file);
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
for (const broken of [false, true]) test(`proof CLI fixture ${broken ? 'failure' : 'pass remains insufficient natural evidence'}`, async t => {
  const origin = await fixture(t, broken);
  let result;
  try { result = { ...await exec(process.execPath, ['scripts/prove-home-loaded-card-search.mjs', '--origin', origin, '--timeout-ms', '15000'], { timeout: 25000 }), code: 0 }; }
  catch (error) { result = error; }
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(result.code, broken ? 1 : 78, result.stdout + result.stderr);
  assert.equal(receipt.natural_acceptance, 'insufficient_evidence');
  if (!broken) { assert.equal(receipt.synthetic, true); assert.equal(receipt.assertions.length, 4); assert.ok(receipt.assets.length > 1); }
});
for (const late of [false, true]) test(`deadline closes owned browser during ${late ? 'late launch' : 'stalled evaluation'}`, async t => {
  const origin = await fixture(t);
  let browser;
  let acquired;
  const acquisition = new Promise(resolve => { acquired = resolve; });
  const engine = { launch: async options => {
    browser = await chromium.launch(options);
    acquired();
    if (late) await new Promise(resolve => setTimeout(resolve, 1500));
    return browser;
  } };
  let started;
  const evaluation = new Promise(resolve => { started = resolve; });
  const result = prove({ origin, timeoutMs: 1200, engine, observe: async page => { started(); await page.evaluate(() => new Promise(() => {})); } });
  await acquisition;
  if (!late) await evaluation;
  await assert.rejects(result, error => error.exitCode === 78);
  if (late) await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(browser.isConnected(), false, 'zero surviving browsers acquired by this proof');
});
