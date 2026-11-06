import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from './proof-fixture-server.mjs';
import { fixtureServer } from './browser-harness.mjs';
import { chromium as realChromium } from 'playwright';
import { prove } from '../scripts/prove-market-terms-fact-filter.mjs';

function cli(origin) {
  return new Promise((resolve,reject) => {
    const child = spawn(process.execPath,['scripts/prove-market-terms-fact-filter.mjs','--origin',origin,'--timeout-ms','10000','--fixture'], {stdio:['ignore','pipe','pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data',chunk => { stdout += chunk; }); child.stderr.on('data',chunk => { stderr += chunk; });
    child.on('error',reject); child.on('close',code => resolve({code,stdout,stderr}));
  });
}
async function server(handler) {
  const http = createServer(handler);
  await new Promise(resolve => http.listen(0,'127.0.0.1',resolve));
  return {origin:`http://127.0.0.1:${http.address().port}`,close:async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); }};
}
const release = {service:'doctorcre-app',environment:'production',source_commit:'a'.repeat(40)};

test('CLI working-tree fixture passes; broken deployed asset fails; natural proof remains insufficient', async () => {
  const upstream = await fixtureServer();
  let broken = false;
  const proxy = await server(async (req,res) => {
    if (req.url === '/app-release') { res.setHeader('content-type','application/json'); return res.end(JSON.stringify(release)); }
    if (broken) { res.setHeader('content-type','text/javascript'); return res.end('export const missing = true;'); }
    const response = await fetch(upstream.origin + req.url);
    res.writeHead(response.status,{'content-type':response.headers.get('content-type') || ''}); res.end(Buffer.from(await response.arrayBuffer()));
  });
  try {
    const pass = await cli(proxy.origin);
    assert.equal(pass.code,0,pass.stderr);
    const receipt = JSON.parse(pass.stdout);
    assert.equal(receipt.production_acceptance,false);
    assert.equal(receipt.deployed_asset_fixture.assertions.reads,6);
    broken = true;
    const fail = await cli(proxy.origin);
    assert.equal(fail.code,1,fail.stderr);
    await assert.rejects(prove({origin:proxy.origin}), error => error.exitCode === 78 && /insufficient_evidence/.test(error.message));
  } finally { await proxy.close(); await upstream.close(); }
});

test('deadline closes late launch and stalled evaluation resources with exit 78', async () => {
  const fixture = await server((req,res) => {res.setHeader('content-type','application/json'); res.end(JSON.stringify(release));});
  try {
    for (const mode of ['late launch','stalled evaluation']) {
      let acquired = 0, closed = 0;
      const browser = {close:async () => { closed++; },newPage:async () => ({route:async () => {},goto:async () => {},evaluate:() => new Promise(() => {})})};
      const engine = {launch:async () => { if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve,300)); acquired++; return browser; }};
      await assert.rejects(prove({origin:fixture.origin,timeoutMs:150,fixture:true,engine}),error => error.exitCode === 78);
      await new Promise(resolve => setTimeout(resolve,350));
      assert.equal(acquired,1,mode); assert.ok(closed >= 1,mode);
    }
  } finally { await fixture.close(); }
});


test('real Chromium disconnects after late acquisition and stalled evaluation deadlines', async () => {
  const fixture = await server((req,res) => { res.setHeader('content-type','application/json'); res.end(JSON.stringify(release)); });
  try {
    for (const mode of ['late launch','stalled evaluation']) {
      let acquired;
      let finishLaunch;
      const launched = new Promise(resolve => { finishLaunch = resolve; });
      const engine = { launch: async options => {
        acquired = await realChromium.launch({...options,timeout:10000});
        finishLaunch();
        if (mode === 'late launch') await new Promise(resolve => setTimeout(resolve,1000));
        else {
          const newPage = acquired.newPage.bind(acquired);
          acquired.newPage = async () => {
            const page = await newPage();
            page.goto = async () => {};
            page.evaluate = () => new Promise(() => {});
            return page;
          };
        }
        return acquired;
      }};
      try {
        await assert.rejects(prove({origin:fixture.origin,timeoutMs:700,fixture:true,engine}),error => error.exitCode === 78);
        await launched;
        await new Promise(resolve => setTimeout(resolve,1200));
        assert.equal(acquired.isConnected(),false,mode);
      } finally { await acquired?.close(); }
    }
  } finally { await fixture.close(); }
});
