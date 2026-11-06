import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { prove } from '../scripts/prove-answer-table-empty-match-state.mjs';
const root = resolve('.');
const run = (origin, fixture = true) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/prove-answer-table-empty-match-state.mjs', '--origin', origin, ...(fixture ? ['--fixture'] : [])]);
  let output = ''; child.stdout.on('data', data => { output += data; });
  child.on('error', reject); child.on('exit', code => resolve({code, receipt:JSON.parse(output)}));
});
test('proof uses checked-out assets, distinguishes fixture evidence and cleans owned browsers', async t => {
  let mode = 'pass';
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://fixture.invalid').pathname);
      const file = resolve(root, '.' + pathname);
      if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      if (pathname === '/app-release') {
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify({service:'doctorcre-app',environment:'production',source_commit:'a'.repeat(40)})); return;
      }
      if (mode === 'missing') { res.writeHead(404).end(); return; }
      if (!/^\/js\/[\w.-]+\.js$/.test(pathname)) { res.writeHead(403).end(); return; }
      res.setHeader('content-type','text/javascript');
      const body = await readFile(file,'utf8');
      res.end(mode === 'fail' ? body.replaceAll('No recorded rows in this answer','Incorrect empty response') : body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [name, fixture, expected] of [['pass',true,0],['fail',true,1],['missing',true,78],['pass',false,78]]) await t.test(`${name} fixture=${fixture}`,async () => {
    mode = name;
    const result = await run(origin,fixture);
    assert.equal(result.code,expected,JSON.stringify(result.receipt));
    if (expected === 0) assert.ok(result.receipt.assertions.length > 30);
    if (!fixture) assert.equal(result.receipt.status,'insufficient_evidence');
  });
  for (const path of ['/..%2fpackage.json','/%2e%2e%2fpackage.json']) {
    const response = await fetch(origin + path);
    assert.equal(response.status,403,'encoded traversal is refused');
  }
  mode = 'pass';
  for (const scenario of ['stalled evaluation','late launch']) await t.test(`${scenario} exits 78 without owned survivors`,async () => {
    let acquired;
    let started;
    const launchStarted = new Promise(resolve => { started = resolve; });
    const engine = {async launch(options) {
      const server = await chromium.launchServer({...options,args:[...CHROMIUM_SAFETY_ARGS,...(options.args || [])]});
      const pid = server.process().pid;
      const browser = await chromium.connect(server.wsEndpoint());
      const originalClose = browser.close.bind(browser);
      browser.close = async () => { await originalClose(); await server.close(); };
      acquired = {browser,pid}; started();
      if (scenario === 'late launch') await new Promise(resolve => setTimeout(resolve, 1200));
      else {
        const originalContext = browser.newContext.bind(browser);
        browser.newContext = async (...args) => {
          const context = await originalContext(...args), originalPage = context.newPage.bind(context);
          context.newPage = async () => {
            const page = await originalPage();
            page.evaluate = () => new Promise(() => {});
            return page;
          };
          return context;
        };
      }
      return browser;
    }};
    const pending = prove({origin,timeoutMs:1000,fixture:true,engine});
    await launchStarted;
    const receipt = await pending;
    assert.equal(receipt.exitCode,78,JSON.stringify(receipt));
    await new Promise(resolve => setTimeout(resolve,1500));
    assert.equal(acquired.browser.isConnected(),false);
    assert.throws(() => process.kill(acquired.pid,0), {code:'ESRCH'});
  });
});
