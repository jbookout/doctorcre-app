import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createServer } from './proof-fixture-server.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { buildArtifact } from '../scripts/artifact.mjs';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { proveLoadedSearch } from '../scripts/prove-deal-documents-loaded-search.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('loaded search proof executes admitted assets, fails assertions and refuses missing evidence', async t => {
  const artifact = temporaryDirectory('loaded-search-proof-', t);
  await buildArtifact({ root: process.cwd(), outDir: artifact, commit: '1'.repeat(40) });
  const assets = new Map();
  async function admit(directory, prefix) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.isDirectory()) await admit(`${directory}/${item.name}`, `${prefix}/${item.name}`);
      else if (item.name.endsWith('.js')) assets.set(`${prefix}/${item.name}`, await readFile(`${directory}/${item.name}`));
    }
  }
  await admit(`${artifact}/site/js`, '/js');
  let mode = 'pass';
  const server = createServer((req, res) => {
    if (req.url === '/app-release') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ service: 'doctorcre-app', environment: 'production', source_commit: '1'.repeat(40) })); }
    if (!assets.has(req.url)) { res.writeHead(403); return res.end(); }
    res.setHeader('content-type', 'text/javascript');
    if (req.url === '/js/ui-deal-documents.js' && mode === 'broken') return res.end('export function mountDealDocuments(){throw Error("Synthetic assertion failure")}');
    if (req.url === '/js/ui-deal-documents.js' && mode === 'stalled') return res.end('await new Promise(()=>{});');
    res.end(assets.get(req.url));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [scenario, synthetic, expected] of [['pass', true, 0], ['broken', true, 1], ['pass', false, 78]]) {
    await t.test(`${scenario} synthetic=${synthetic} exit ${expected}`, async () => {
      mode = scenario;
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['scripts/prove-deal-documents-loaded-search.mjs', '--origin', origin, ...(synthetic ? ['--synthetic-only'] : [])], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 40000 });
        let stdout = '', stderr = '';
        child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
        child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
      });
      assert.equal(result.code, expected, result.stderr);
      if (scenario === 'pass') {
        const receipt = JSON.parse(result.stdout);
        assert.equal(receipt.observed.list_calls, 2);
        assert.equal(receipt.natural.status, 'insufficient_evidence');
        assert.equal(receipt.release_before.source_commit, receipt.release_after.source_commit);
        assert.ok(receipt.assets.length > 1);
      }
    });
  }
  for (const probe of ['stalled evaluation', 'late launch']) {
    await t.test(`${probe} exits 78 with zero owned survivors`, async () => {
      mode = probe === 'stalled evaluation' ? 'stalled' : 'pass';
      let ownedServer, pid, acquired = false;
      const engine = { async launch(options) {
        ownedServer = await chromium.launchServer({ ...options, args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])], timeout: 10000 });
        pid = ownedServer.process().pid; acquired = true;
        const connected = await chromium.connect(ownedServer.wsEndpoint());
        if (probe === 'late launch') await delay(1200);
        return new Proxy(connected, { get(target, key) {
          if (key === 'close') return async () => { await connected.close(); await ownedServer.close(); };
          const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        } });
      } };
      try {
        const failure = await proveLoadedSearch({ origin, engine, timeout: 1000 }).then(() => null, error => error);
        assert.equal(failure?.exitCode, 78, failure?.message);
        assert.ok(acquired, 'probe acquired a real owned browser');
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      } finally { await ownedServer?.close(); }
    });
  }
});
