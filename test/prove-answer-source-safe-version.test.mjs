import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../scripts/fixture-http.mjs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { proofAssetSnapshot } from './proof-asset-snapshot.mjs';
const snapshot = await proofAssetSnapshot();
const entry = await readFile('js/ui-answers.generated.js','utf8');
const run = (origin, timeout = '30000') => new Promise((resolve, reject) => {
  const child = spawn(process.execPath,['scripts/prove-answer-source-safe-version.mjs','--origin',origin,'--timeout-ms',timeout]);
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.on('error',reject);
  child.on('exit',code => resolve({code,receipt:JSON.parse(stdout),stderr}));
});

test('proof CLI executes fetched modules and refuses contradictions, unavailable assets and timeouts', async t => {
  for (const [scenario, expected] of [['pass',0],['fail',1],['release',78],['identity',78],['missing',78],['chunk',78],['external',78],['cap',78],['timeout',78]]) await t.test(scenario, async () => {
    const routes = new Map([...snapshot].filter(([path])=>path==='/js/ui-answers.generated.js'||/^\/js\/[a-zA-Z0-9_-]+\.generated\.js$/.test(path)));
    for (const [path, value] of routes) {
      if(scenario==='missing'||scenario==='chunk'&&path!=='/js/ui-answers.generated.js') {routes.set(path,{status:404});continue;}
      let body = path==='/js/ui-answers.generated.js'?entry:value.body.toString();
      if(path==='/js/ui-answers.generated.js') {
        if(scenario==='fail')body=body.replace('Number.isSafeInteger','Number.isInteger');
        if(scenario==='external')body+='\nimport "https://example.invalid/evil.js";';
        if(scenario==='cap')body+=Array.from({length:20},(_,i)=>`\nimport "./cap${i}.generated.js";`).join('');
      }
      routes.set(path,{body,contentType:'text/javascript'});
    }
    routes.set('/app-release',{contentType:'application/json',status:scenario==='release'?404:200,body:JSON.stringify(scenario==='identity'?{}:{service:'doctorcre-app',environment:'production',source_commit:'a'.repeat(40)})});
    if(scenario==='timeout')routes.set('/app-release',{hold:'timeout'});
    const server = await startFixture({routes});
    t.after(()=>server.close());
    const origin=server.origin;
    const {code,receipt} = await run(origin,scenario === 'timeout' ? '50' : '30000');
    assert.equal(code,expected,JSON.stringify(receipt));
    const requests = server.requests.map(req=>req.target);
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
