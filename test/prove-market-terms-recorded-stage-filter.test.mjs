import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from './proof-fixture-server.mjs';
import { uiAssets } from '../scripts/ui-bundle.mjs';
import { chromium as realChromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { prove } from '../scripts/prove-market-terms-recorded-stage-filter.mjs';

const release = { service: 'doctorcre-app', environment: 'production', source_commit: 'a'.repeat(40) };
async function server() {
  const assets = await uiAssets(path => readFile(new URL('../' + path, import.meta.url), 'utf8'));
  let broken = false;
  const http = createServer((req, res) => {
    if (req.url === '/app-release') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(release)); }
    const body = assets.get(req.url?.replace(/^\//, ''));
    if (!body) { res.writeHead(403); return res.end(); }
    res.setHeader('content-type', 'text/javascript');
    res.end(broken ? `export function mountMarketTerms(root) { root.innerHTML = '<label>Recorded stage<select aria-label="Recorded stage"><option>Wrong stages</option></select></label>'; return { dispose() {} }; }` : body);
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${http.address().port}`, break() { broken = true; }, async close() { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); } };
}
function cli(origin, fixture = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/prove-market-terms-recorded-stage-filter.mjs', '--origin', origin, '--timeout-ms', '7000', ...(fixture ? ['--fixture'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('CLI exact admitted in-memory assets pass, assertion failure exits 1, unsigned natural proof exits 78', async () => {
  const fixture = await server();
  try {
    const pass = await cli(fixture.origin);
    assert.equal(pass.code, 0, pass.stderr);
    assert.equal(JSON.parse(pass.stdout).assertions.reads, 4);
    const unsigned = await cli(fixture.origin, false);
    assert.equal(unsigned.code, 78, unsigned.stderr);
    assert.equal(JSON.parse(unsigned.stdout).production_acceptance, false);
    fixture.break();
    const fail = await cli(fixture.origin);
    assert.equal(fail.code, 1, fail.stderr);
  } finally { await fixture.close(); }
});

test('proof deadline closes late launch and stalled evaluation with zero owned browser survivors', async () => {
  const fixture = await server();
  try {
    for (const mode of ['late launch', 'stalled evaluation']) {
      let acquired;
      let finishLaunch;
      const launched = new Promise(resolve => { finishLaunch = resolve; });
      const engine = { launch: async (options = {}) => {
        acquired = await realChromium.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])], timeout: 10000 });
        finishLaunch();
        if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve, 1000));
        else {
          const newPage = acquired.newPage.bind(acquired);
          acquired.newPage = async () => { const page = await newPage(); page.goto = async () => {}; page.evaluate = () => new Promise(() => {}); return page; };
        }
        return acquired;
      } };
      try {
        await assert.rejects(prove({ origin: fixture.origin, timeoutMs: 700, fixture: true, engine }), error => error.exitCode === 78);
        await launched;
        await new Promise(resolve => setTimeout(resolve, 1200));
        assert.equal(acquired.isConnected(), false, mode);
      } finally { await acquired?.close(); }
    }
  } finally { await fixture.close(); }
});
