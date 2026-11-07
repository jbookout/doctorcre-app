import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../scripts/proof-browser.mjs';
import { createServer } from './proof-fixture-server.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { handleDoctorcreRequest } from '../src/worker.js';
import { validateLeadWorkspace, validateLeadDetail } from '../js/leads-client.js';
import { prove } from '../scripts/prove-research-kind-filter.mjs';
const recording = JSON.parse(await readFile(new URL('./fixtures/research-kind-filter/recordings.json', import.meta.url)));
validateLeadWorkspace(recording); validateLeadDetail(recording.detail, recording.detail.id);
const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t, mode) {
  const history = temporaryDirectory('research-kind-history-', t);
  const git = (...args) => execFileSync('git', args, { cwd: history, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  git('init');
  const commit = async text => { await writeFile(resolve(history, 'revision'), text); git('add', 'revision'); git('-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','commit','-m',text); return git('rev-parse','HEAD'); };
  const older = await commit('older'), expectedCommit = await commit('expected'), descendant = await commit('descendant');
  git('checkout','--orphan','unrelated'); const unrelated = await commit('unrelated');
  const released = { older, descendant, unrelated, unknown: 'f'.repeat(40) }[mode] || expectedCommit;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/app-release') {
      const response = await handleDoctorcreRequest(new Request(url), { GIT_SHA: released, APP_ENV: 'production' });
      res.setHeader('content-type','application/json'); return res.end(Buffer.from(await response.arrayBuffer()));
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/auth/session') { res.setHeader('content-type','application/json'); return res.end(JSON.stringify({actor:{slug:'example-partner'},csrf_token:'synthetic-test-token'})); }
    if (url.pathname === '/mcp') {
      let body='';for await (const chunk of req) body += chunk;
      const name=JSON.parse(body).params?.name;
      res.setHeader('content-type','application/json');
      return res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify(name==='lead-board' ? recording : {error:'fixture_read_unavailable'})}]}}));
    }
    const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/leads' ? '/leads.html' : url.pathname));
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403); return res.end(); }
    try {
      let bytes=await readFile(path);
      if (mode==='failure' && url.pathname==='/js/ui-lead-research.js') bytes=Buffer.from(bytes.toString().replaceAll('data-flag-id','data-wrong-id'));
      res.setHeader('content-type', ({'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.html':'text/html'})[extname(path)] || 'application/json');res.end(bytes);
    } catch { res.writeHead(404);res.end(); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  return {origin:`http://127.0.0.1:${server.address().port}`,expectedCommit,ancestryCwd:history};
}
for (const mode of ['equal','descendant','older','unrelated','unknown','failure','session']) test(`proof ${mode}`, async t => {
  const options=await fixture(t,mode);
  if (['older','unrelated','unknown','session'].includes(mode)) {
    await assert.rejects(prove(options), error=>error.exitCode===78);return;
  }
  if (mode === 'equal' || mode === 'failure') {
    const portServer = createServer(() => {});
    await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
    const port = portServer.address().port;
    await new Promise(resolve => portServer.close(resolve));
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
    t.after(() => browser.close());
    const args = ['scripts/prove-research-kind-filter.mjs', '--origin', options.origin, '--expected-commit', options.expectedCommit, '--cdp-url', `http://127.0.0.1:${port}`];
    if (mode === 'failure') await assert.rejects(promisify(execFile)(process.execPath, args), error => error.code === 1);
    else assert.equal(JSON.parse((await promisify(execFile)(process.execPath, args)).stdout).status, 'passed');
    assert.ok(browser.isConnected(), 'proof disconnect preserves acquired test browser');
    assert.equal((await browser.newContext()).pages().length, 0);
    return;
  }
  const browser=await chromium.launch(); t.after(()=>browser.close());
  await browser.newContext();
  const engine={connectOverCDP:async()=>browser};
  assert.equal((await prove({...options,engine,cdpUrl:'fixture'})).status,'passed');
});
for(const mode of ['late connection','stalled evaluation']) test(`proof deadline cleans ${mode}`,async t=>{
  const options=await fixture(t,'equal');let closed=0,pageClosed=0;
  const page={setDefaultTimeout(){},route:async()=>{},goto:async()=>{},evaluate:()=>new Promise(()=>{}),close:async()=>pageClosed++};
  const connection={contexts:()=>[{newPage:async()=>page}],close:async()=>closed++};
  const engine={connectOverCDP:async()=>{if(mode==='late connection')await new Promise(resolve=>setTimeout(resolve,150));return connection;}};
  await assert.rejects(prove({...options,engine,cdpUrl:'fixture',timeoutMs:100}),error=>error.exitCode===78);
  await new Promise(resolve=>setTimeout(resolve,200));assert.equal(closed,1);assert.equal(pageClosed,mode==='late connection'?0:1);
});

async function borrowedBrowser(t) {
  const portServer = createServer(() => {});
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  t.after(() => browser.close());
  const cdpUrl = `http://127.0.0.1:${port}`;
  const { chromium: cdp } = await import('playwright');
  const connection = await cdp.connectOverCDP(cdpUrl);
  t.after(() => connection.close());
  return { browser, connection, cdp, cdpUrl };
}

test('proof CLI returns 78 when the context retires during page acquisition', async t => {
  const options = await fixture(t, 'equal');
  const { browser, cdpUrl } = await borrowedBrowser(t);
  const scratch = temporaryDirectory('research-kind-retired-context-', t);
  const preload = resolve(scratch, 'retire.mjs');
  const playwrightUrl = import.meta.resolve('playwright');
  await writeFile(preload, `
    import { chromium } from ${JSON.stringify(playwrightUrl)};
    const connect = chromium.connectOverCDP.bind(chromium);
    chromium.connectOverCDP = async (...args) => {
      const connection = await connect(...args);
      const context = connection.contexts()[0];
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        await connection.close();
        return newPage();
      };
      return connection;
    };
  `);
  await assert.rejects(promisify(execFile)(process.execPath, [
    '--import', preload, 'scripts/prove-research-kind-filter.mjs',
    '--origin', options.origin, '--expected-commit', options.expectedCommit, '--cdp-url', cdpUrl,
  ]), error => {
    assert.equal(error.code, 78);
    assert.equal(JSON.parse(error.stdout).status, 'insufficient_evidence');
    return true;
  });
  assert.ok(browser.isConnected(), 'borrowed browser remains connected');
});

test('proof deadline closes a late CDP page before disconnecting and preserves existing tabs', async t => {
  const options = await fixture(t, 'equal');
  const { browser, connection, cdp, cdpUrl } = await borrowedBrowser(t);
  const context = connection.contexts()[0];
  const existing = await context.newPage();
  await existing.goto('about:blank#existing');
  const newPage = context.newPage.bind(context);
  let acquisition;
  context.newPage = () => acquisition = newPage().then(async page => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    return page;
  });
  const engine = { connectOverCDP: async () => connection };
  await assert.rejects(prove({ ...options, engine, cdpUrl, timeoutMs: 1000 }), error => error.exitCode === 78);
  assert.ok(acquisition, 'page acquisition started before deadline');
  await acquisition.catch(() => {});
  const fresh = await cdp.connectOverCDP(cdpUrl);
  try {
    const pages = fresh.contexts()[0].pages();
    assert.equal(pages.length, 1, 'only the existing tab remains');
    assert.equal(pages[0].url(), 'about:blank#existing');
    assert.ok(browser.isConnected(), 'borrowed browser remains connected');
  } finally { await fresh.close(); }
});
