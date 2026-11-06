import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from './proof-fixture-server.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { prove } from '../scripts/prove-email-filings-central-source-time.mjs';
const exec = promisify(execFile);
let outDir;
before(async () => { outDir = temporaryDirectory('filings-cli-'); await buildArtifact({ root: process.cwd(), outDir }); });
after(async () => rm(outDir, { recursive: true, force: true }));
async function fixture(t, broken = false) {
  const root = resolve(outDir, 'site');
  const server = createServer(async (req, res) => {
    if (req.url === '/app-release') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) }));
    try {
      const path = decodeURIComponent(req.url);
      const file = resolve(root, path.slice(1));
      if (/%2e|%5c|%00/i.test(req.url) || path.includes('\\') || path.includes('\0') || !file.startsWith(root + sep)) return res.writeHead(404).end();
      const body = broken && path === '/js/email-filings.js'
        ? 'export function mountEmailFilings({container}) {return {async refresh(){container.innerHTML="<article><p>wrong time</p></article>"},dispose(){}}}'
        : await readFile(file);
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
for (const broken of [false, true]) test(`CLI working-tree fixture ${broken ? 'fails' : 'passes'}`, async t => {
  const origin = await fixture(t, broken);
  let result;
  try { result = { ...await exec(process.execPath, ['scripts/prove-email-filings-central-source-time.mjs', '--origin', origin, '--timeout-ms', '30000'], { timeout: 40000 }), code: 0 }; }
  catch (error) { result = error; }
  assert.equal(result.code, broken ? 1 : 0, result.stdout + result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ok, !broken);
  assert.equal(receipt.production_acceptance, 'insufficient_evidence');
  if (!broken) assert.equal(receipt.deployed_asset_fixture.observations.length, 3);
});
for (const mode of ['late launch', 'stalled evaluation']) test(`proof deadline closes owned resource after ${mode}`, async t => {
  const origin = await fixture(t);
  let acquired, pending;
  t.after(async () => { await pending?.catch(() => {}); await acquired?.close(); });
  const engine = { launch: options => {
    pending = (async () => {
      acquired = await chromium.launch({ ...options, timeout: 5000, args: [...CHROMIUM_SAFETY_ARGS] });
      if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 1500));
      if (mode === 'late launch') return acquired;
      return {
        close: () => acquired.close(),
        newContext: async options => {
          const context = await acquired.newContext(options);
          return { route: (...args) => context.route(...args), close: () => context.close(),
            newPage: async () => {
              const page = await context.newPage();
              return { clock: page.clock, goto: (...args) => page.goto(...args),
                evaluate: () => page.evaluate(() => new Promise(() => {})) };
            } };
        } };
    })();
    return pending;
  } };
  await assert.rejects(prove({ origin, timeoutMs: 1000, engine }), error => error.exitCode === 78);
  await pending;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(acquired.isConnected(), false, 'owned browser process closed');
});
