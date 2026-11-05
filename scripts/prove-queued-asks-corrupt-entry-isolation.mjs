import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from './chromium-safety-args.mjs';

export async function prove({ origin, timeoutMs = 30000, revision } = {}) {
  const base = new URL(origin);
  assert.ok(['http:', 'https:'].includes(base.protocol) && base.origin === origin, 'Supply an origin without a path');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'Invalid timeout');
  const releaseResponse = await fetch(`${origin}/app-release`, { redirect:'error', signal:AbortSignal.timeout(timeoutMs) });
  assert.equal(releaseResponse.status, 200, 'Release unavailable or sign-in required');
  const release = await releaseResponse.json();
  assert.equal(release.service, 'doctorcre-app', 'Wrong release application');
  assert.match(release.source_commit, /^[a-f0-9]{40}$/, 'Release revision missing');
  const required = revision ?? execFileSync('git', ['log', '-1', '--format=%H', '--', 'scripts/prove-queued-asks-corrupt-entry-isolation.mjs'], { encoding:'utf8' }).trim();
  assert.match(required, /^[a-f0-9]{40}$/, 'Required revision missing');
  execFileSync('git', ['merge-base', '--is-ancestor', required, release.source_commit], { stdio:'pipe' });
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  const deadline = setTimeout(() => { void browser.close(); }, timeoutMs);
  const modules = new Set(), failedAssets = [], denied = [];
  let requests = 0;
  try {
    const context = await browser.newContext({ serviceWorkers:'block' });
    context.setDefaultTimeout(timeoutMs);
    const page = await context.newPage();
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (++requests > 100) { denied.push('request budget exceeded'); return route.abort(); }
      if (request.method() === 'GET' && url.origin === origin && url.pathname === '/__queued_asks_proof')
        return route.fulfill({ contentType:'text/html', body:'<!doctype html><html><body><main id="probe"></main></body></html>' });
      if (request.method() === 'GET' && url.origin === origin && /^\/js\/[\w.-]+\.js$/.test(url.pathname)) return route.continue();
      denied.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    });
    page.on('response', response => {
      if (response.url().includes('/js/')) {
        modules.add(response.url());
        if (response.status() !== 200) failedAssets.push(response.url());
      }
    });
    await page.goto(`${origin}/__queued_asks_proof`);
    const assertions = [];
    for (const width of [390,1280]) for (const theme of ['light','dark']) {
      await page.setViewportSize({ width, height:900 });
      await page.emulateMedia({ colorScheme:theme });
      await page.evaluate(async () => {
        const { mountAskComposer } = await import('/js/ui-host.js');
        if (typeof mountAskComposer !== 'function') throw Error('mountAskComposer export missing');
        const conversation='11111111-1111-4111-8111-111111111111', key='22222222-2222-4222-8222-222222222222';
        const prefix=`doctorcre:asks:v1:corrupt-proof:${conversation}:`;
        localStorage.clear();
        localStorage.setItem(prefix+'bad-before','{');
        const request={idempotency_key:key,conversation_id:conversation,body:'Synthetic valid frozen ask'};
        localStorage.setItem(prefix+key,JSON.stringify({kind:'queued',request}));
        localStorage.setItem(prefix+'bad-after','{');
        localStorage.setItem(prefix+'draft',JSON.stringify({text:'Current synthetic draft',version:1}));
        const calls=[];
        window.corruptProof={prefix,key,request,calls};
        window.corruptProof.dispose=await mountAskComposer(document.querySelector('#probe'), {
          askSession:async()=>({actor:'corrupt-proof'}),
          submitDocRequest:request=>{calls.push(request);return new Promise(resolve=>{
            window.corruptProof.accept=()=>resolve({ok:true,contract:'doc-request.v1',status:'accepted',...request,request_msg_id:request.idempotency_key});
          });},
        },conversation);
      });
      await page.getByText('Synthetic valid frozen ask', { exact:true }).waitFor();
      await page.getByText(/Some saved asks or the saved draft need recovery/).waitFor();
      await page.waitForFunction(()=>window.corruptProof.calls.length===1);
      assert.equal(await page.locator('#askText').inputValue(),'Current synthetic draft');
      await page.evaluate(()=>window.corruptProof.accept());
      await page.getByText('Received by Dr. CRE. An answer is still pending.', { exact:true }).waitFor();
      const state=await page.evaluate(()=>{
        const p=window.corruptProof;
        return {calls:p.calls,request:p.request,before:localStorage.getItem(p.prefix+'bad-before'),after:localStorage.getItem(p.prefix+'bad-after')};
      });
      assert.deepEqual(state.calls,[state.request]);
      assert.equal(state.before,'{');assert.equal(state.after,'{');
      await page.evaluate(()=>window.corruptProof.dispose());
      assertions.push(`${width} ${theme}: valid request accepted once; draft and corrupt bytes retained; notice shown`);
    }
    assert.deepEqual(failedAssets,[], 'Protected or missing module assets');
    assert.deepEqual(denied,[], 'Unexpected network request denied');
    return { origin, release, requiredRevision:required, modules:[...modules].sort(), assertions };
  } finally { clearTimeout(deadline); await browser.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2), options={};
    for(let i=0;i<args.length;i+=2) {
      assert.ok(['--origin','--timeout-ms','--revision'].includes(args[i]) && args[i+1], 'Unknown or missing argument');
      options[args[i]] = args[i+1];
    }
    console.log(JSON.stringify(await prove({origin:options['--origin'],timeoutMs:options['--timeout-ms'] === undefined ? 30000 : Number(options['--timeout-ms']),revision:options['--revision']})));
  } catch(error) { console.error(`queued-asks proof failed: ${error.message}`);process.exitCode=1; }
}
