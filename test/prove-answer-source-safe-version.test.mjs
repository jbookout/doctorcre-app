import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './proof-fixture-server.mjs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const entry = await readFile('js/ui-answers.js','utf8');
const run = (origin, timeout = '30000') => new Promise((resolve, reject) => {
  const child = spawn(process.execPath,['scripts/prove-answer-source-safe-version.mjs','--origin',origin,'--timeout-ms',timeout]);
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.on('error',reject);
  child.on('exit',code => resolve({code,receipt:JSON.parse(stdout),stderr}));
});

test('proof CLI executes fetched modules and refuses contradictions, unavailable assets and timeouts', async t => {
  let mode = 'pass';
  const requests = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    requests.push(req.url);
    if (mode === 'timeout') return;
    if (req.url === '/app-release') {
      if (mode === 'release') { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify(mode === 'identity' ? {} : {service:'doctorcre-app', environment: 'production',source_commit:'a'.repeat(40)}));
      return;
    }
    if (mode === 'missing') { res.writeHead(404).end(); return; }
    try {
      const path = new URL(req.url, 'http://fixture.invalid').pathname;
      if (mode === 'chunk' && path !== '/js/ui-answers.js') throw new Error('missing generated asset');
      if (path !== '/js/ui-answers.js' && !/^\/js\/[a-zA-Z0-9_-]+\.generated\.js$/.test(path)) throw new Error('unexpected request');
      let body = path === '/js/ui-answers.js' ? entry : await readFile(`.${path}`,'utf8');
      if (path === '/js/ui-answers.js' && mode === 'fail') body = body.replace('Number.isSafeInteger','Number.isInteger');
      if (path === '/js/ui-answers.js' && mode === 'external') body += '\nimport "https://example.invalid/evil.js";';
      if (path === '/js/ui-answers.js' && mode === 'cap') body += Array.from({length:20},(_,i)=>`\nimport "./cap${i}.generated.js";`).join('');
      res.setHeader('Content-Type','text/javascript');
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [scenario, expected] of [['pass',0],['fail',1],['release',78],['identity',78],['missing',78],['chunk',78],['external',78],['cap',78],['timeout',78]]) await t.test(scenario, async () => {
    mode = scenario;
    requests.length = 0;
    const {code,receipt} = await run(origin,scenario === 'timeout' ? '50' : '30000');
    assert.equal(code,expected,JSON.stringify(receipt));
    assert.ok(requests.length <= 20);
    assert.equal(new Set(requests).size,requests.length,'no retries');
    if (scenario === 'pass') {
      assert.ok(receipt.assertions.length > 20);
      assert.ok(receipt.assertions.every(result => result.passed));
      assert.equal(receipt.assets[0].sha256,createHash('sha256').update(entry).digest('hex'));
      assert.equal(receipt.release.source_commit,'a'.repeat(40));
      assert.ok(receipt.assets.length > 1,'referenced generated modules fetched');
    }
    if (scenario === 'fail') assert.match(receipt.error,/refuse 9007199254740992/);
    if (scenario === 'timeout') assert.match(receipt.error,/deadline/);
  });
});
