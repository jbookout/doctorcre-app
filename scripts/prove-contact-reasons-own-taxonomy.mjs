import { launchProofBrowser, readAppRelease } from './app-release-reader.mjs';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {CHROMIUM_SAFETY_ARGS} from './chromium-safety-args.mjs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export async function exerciseContactReasons(page, moduleUrl) {
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror',onError);
  const assertions = [];
  try {
    await page.evaluate(async moduleUrl => {
      const {mountContactReasons} = await import(moduleUrl);
      if (typeof mountContactReasons !== 'function') throw new Error('missing mountContactReasons export');
      document.body.innerHTML = '<main id="taxonomy-proof"></main>';
      const card = {id:'9',name:'Synthetic valid practice',kind:'enumeration',route:'research',city:'Demo City',state:'FL',evidence_date:'2026-10-26',source:'nppes',npi:'1234567890',source_url:'https://npiregistry.cms.hhs.gov/provider-view/1234567890',client_ids:[],client_refs:[]};
      const payload = {ok:true,contract:'practice-origination.v1',outreach_started:false,next_cursor:'8',coverage:[{source:'nppes',status:'available'}],cards:[card,...['constructor','toString','__proto__'].map((kind,i)=>({...card,id:String(20+i),name:`Invalid ${kind}`,kind}))]};
      const probe = window.taxonomyProof = {payload,reads:[],held:false};
      probe.remount = ({source,held=false} = {}) => {
        probe.mount?.dispose();
        probe.payload=JSON.parse(JSON.stringify(payload));
        if (source) probe.payload.coverage=[{source,status:'available'}];
        probe.reads=[];
        probe.held=held;
        probe.resolve=null;
        probe.mount = mountContactReasons({host:document.querySelector('main'),window,client:{listPracticeOrigination:args=>{
          probe.reads.push({before_id:args.before_id});
          return probe.held ? new Promise(resolve=>{probe.resolve=resolve;}) : JSON.parse(JSON.stringify(probe.payload));
        }}});
      };
      probe.remount();
    },moduleUrl);
    const host = page.locator('#taxonomy-proof');
    await host.getByText('Synthetic valid practice',{exact:true}).waitFor();
    assert.equal(await host.locator('.work-card').count(),1);
    assert.doesNotMatch(await host.innerText(),/Invalid (constructor|toString|__proto__)/);
    assertions.push('mixed JSON kinds omit inherited entries and keep valid card');
    await page.evaluate(()=>{
      const p=window.taxonomyProof;
      p.payload.cards = [p.payload.cards[0],{...p.payload.cards[0],id:'7',kind:'pecos_observation',source:'pecos',source_url:'https://data.cms.gov/example',route:'relationship_follow_up',client_ids:['synthetic-client'],client_refs:['SYNTHETIC-CLIENT']}];
      p.payload.next_cursor=null;
    });
    await host.getByRole('button',{name:'More reasons',exact:true}).click();
    const show = host.getByRole('button',{name:/Show .* more/});
    if (await show.count()) await show.click();
    await host.getByRole('link',{name:'Follow up with SYNTHETIC-CLIENT',exact:true}).waitFor();
    assert.equal(await host.locator('.work-card').count(),2);
    assert.equal(await host.getByRole('link',{name:'Follow up with SYNTHETIC-CLIENT',exact:true}).getAttribute('href'),'/clients?record=synthetic-client');
    assert.equal(await page.evaluate(()=>window.taxonomyProof.reads[1].before_id),'8');
    assertions.push('pagination deduplicates and preserves PECOS relationship route');
    for (const source of ['constructor','toString','__proto__']) {
      await page.evaluate(source=>{
        const p=window.taxonomyProof;
        p.payload.coverage=[{source,status:'available'}];
        p.mount.refresh();
      },source);
      await host.getByText(/Contact reasons unavailable/).waitFor();
      assert.equal(await host.locator('.work-card').count(),2);
      assert.doesNotMatch(await host.locator('[aria-label="Source coverage"]').innerText(),/constructor|toString|__proto__/);
      const reads = await page.evaluate(()=>window.taxonomyProof.reads.length);
      await host.getByRole('button',{name:'Try again',exact:true}).click();
      await page.waitForFunction(reads=>window.taxonomyProof.reads.length === reads+1 && document.querySelector('#taxonomy-proof').getAttribute('aria-busy') === 'false',reads);
      await host.getByText(/Contact reasons unavailable/).waitFor();
      assert.equal(await host.locator('.work-card').count(),2);
      assert.doesNotMatch(await host.locator('[aria-label="Source coverage"]').innerText(),/constructor|toString|__proto__/);
      await page.evaluate(()=>{window.taxonomyProof.payload.coverage=[{source:'pecos',status:'available'}];});
      await host.getByRole('button',{name:'Try again',exact:true}).click();
      await page.waitForFunction(()=>!document.querySelector('[data-retry-reasons]'));
      assert.match(await host.locator('[aria-label="Source coverage"]').innerText(),/PECOS/);
    }
    assertions.push('inherited coverage remains unavailable on unsuccessful Retry, then recovers');
    await page.evaluate(()=>{const p=window.taxonomyProof;p.held=true;p.mount.refresh();});
    await page.waitForFunction(()=>typeof window.taxonomyProof.resolve==='function');
    await page.evaluate(()=>{
      window.dispatchEvent(new Event('doctorcre-session-invalidated'));
      window.taxonomyProof.resolve(window.taxonomyProof.payload);
    });
    await host.getByText('Sign in to view contact reasons.',{exact:true}).waitFor();
    await page.evaluate(async()=>{await Promise.resolve();window.taxonomyProof.mount.refresh();});
    assert.equal(await host.locator('.work-card').count(),0);
    assertions.push('retired session ignores late results');
    for (const state of ['loading','unavailable','retrying']) {
      await page.evaluate(state=>window.taxonomyProof.remount({source:'constructor',held:state==='loading'}),state);
      if (state === 'loading') {
        await host.getByText('Loading contact reasons…',{exact:true}).waitFor();
        await page.waitForFunction(()=>typeof window.taxonomyProof.resolve==='function');
        assert.equal(await host.getAttribute('aria-busy'),'true');
        assert.equal(await host.locator('.work-card').count(),0);
      } else {
        await host.getByText(/Contact reasons unavailable/).waitFor();
        assert.equal(await host.locator('.work-card').count(),0);
        if (state === 'retrying') {
          await page.evaluate(()=>{const p=window.taxonomyProof;p.held=true;p.resolve=null;});
          await host.getByRole('button',{name:'Try again',exact:true}).click();
          await page.waitForFunction(()=>typeof window.taxonomyProof.resolve==='function');
          assert.equal(await host.getAttribute('aria-busy'),'true');
        }
      }
      await page.evaluate(()=>window.dispatchEvent(new Event('doctorcre-session-invalidated')));
      await host.getByText('Sign in to view contact reasons.',{exact:true}).waitFor();
      await page.evaluate(async()=>{
        const p=window.taxonomyProof;
        p.payload.coverage=[{source:'nppes',status:'available'}];
        p.resolve?.(p.payload);
        await new Promise(resolve=>setTimeout(resolve,0));
      });
      const reads = await page.evaluate(()=>window.taxonomyProof.reads.length);
      await page.evaluate(()=>window.taxonomyProof.mount.refresh());
      assert.equal(await page.evaluate(()=>window.taxonomyProof.reads.length),reads);
      assert.equal(await host.locator('.work-card').count(),0);
      assert.equal(await host.getAttribute('aria-busy'),'false');
      await host.getByText('Sign in to view contact reasons.',{exact:true}).waitFor();
      assert.equal(await host.getByRole('button').count(),0);
      assertions.push(`${state} retires and ignores late results and refresh`);
    }
    const reads = await page.evaluate(()=>window.taxonomyProof.reads.length);
    await page.evaluate(()=>{const p=window.taxonomyProof;p.mount.dispose();p.mount.refresh();});
    assert.equal(await page.evaluate(()=>window.taxonomyProof.reads.length),reads);
    assert.equal(await host.locator('.work-card').count(),0);
    assert.equal(await host.innerText(),'');
    assert.deepEqual(errors,[]);
    return assertions;
  } finally {
    await page.evaluate(()=>window.taxonomyProof?.mount.dispose());
    page.off('pageerror',onError);
  }
}

export async function prove({origin,timeoutMs=30000,requiredRevision}) {
  const target = new URL(origin);
  assert.ok(target.protocol === 'https:' || target.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(target.hostname),'HTTPS or loopback origin required');
  assert.equal(target.origin,origin,'provide an origin without path or credentials');
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000,'invalid timeout');
  const root = fileURLToPath(new URL('../',import.meta.url));
  const required = requiredRevision || execFileSync('git',['log','-1','--format=%H','--','scripts/prove-contact-reasons-own-taxonomy.mjs'],{cwd:root,encoding:'utf8'}).trim();
  assert.match(required,/^[0-9a-f]{40}$/,'required revision missing');
  let browser, timer;
  const work = async () => {
    const release = await readAppRelease(origin, { timeoutMs: timeoutMs });
    execFileSync('git',['merge-base','--is-ancestor',required,release.source_commit],{cwd:root,timeout:5000,stdio:'pipe'});
    browser = await launchProofBrowser(chromium, {args: [...CHROMIUM_SAFETY_ARGS]});
    const context = await browser.newContext({storageState:{cookies:[],origins:[]},serviceWorkers:'block'});
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    const moduleUrls = new Set(), failures = [];
    let requests = 1;
    await context.route('**/*',route=>{
      const request=route.request(), url=new URL(request.url());
      if (url.href === `${origin}/__contact-taxonomy-proof__`) return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'});
      if (++requests > 40 || request.method() !== 'GET' || url.origin !== origin || !/^\/js\/[\w./-]+\.(m?js)$/.test(url.pathname)) {
        failures.push('unexpected request denied');
        return route.abort();
      }
      moduleUrls.add(url.href);
      return route.continue();
    });
    page.on('response',response=>{if (!response.ok()) failures.push(`asset HTTP ${response.status()}`);});
    await page.goto(`${origin}/__contact-taxonomy-proof__`);
    const assertions = await exerciseContactReasons(page,`${origin}/js/contact-reasons.mjs`);
    assert.deepEqual(failures,[]);
    assert.ok(moduleUrls.has(`${origin}/js/ui-reasons.generated.js`),'deployed renderer was not loaded');
    return {origin,release,required_revision:required,module_urls:[...moduleUrls],assertions,requests};
  };
  try {
    return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('proof timeout')),timeoutMs);})]);
  } finally {clearTimeout(timer);await browser?.close();}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2), options={};
    for (let i=0;i<args.length;i+=2) {
      assert.ok(['--origin','--timeout-ms','--required-revision'].includes(args[i]) && args[i+1],'unknown or missing argument');
      options[args[i]]=args[i+1];
    }
    console.log(JSON.stringify(await prove({origin:options['--origin'],timeoutMs:Number(options['--timeout-ms'] || 30000),requiredRevision:options['--required-revision']})));
  } catch (error) {console.error(`Contact taxonomy proof failed: ${error.message}`);process.exitCode=error.exitCode||1;}
}
