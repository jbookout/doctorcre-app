import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium } from './browser-harness.mjs';
import { appAssetSnapshot } from '../scripts/fixture-app-assets.mjs';
import { filterNetwork, validNetwork } from '../js/relationship-network-model.js';
const root = new URL('../', import.meta.url);
const recording = JSON.parse(readFileSync(new URL('test/fixtures/network-kind-focus/recordings.json', root)));
const provenance = JSON.parse(readFileSync(new URL('test/fixtures/network-kind-focus/provenance.json', root)));
const parserBytes = readFileSync(new URL('test/fixtures/network-kind-focus/producer.txt', root));
const parser = import(`data:text/javascript;base64,${parserBytes.toString('base64')}`);
assert.equal(createHash('sha256').update(parserBytes).digest('hex'), provenance.parser_sha256);
test('fixture passes pinned exact production parser',async()=>assert.ok((await parser).validNetwork(recording)));
assert.ok(validNetwork(recording));
assert.equal(createHash('sha256').update(readFileSync(new URL('test/fixtures/network-kind-focus/recordings.json',root))).digest('hex'),provenance.recordings_sha256);

const expectedIds = {
  vendor: ['party:demo-lender','party:demo-build'],
  client: ['party:demo-client','party:demo-therapy'],
  lead: ['party:demo-lead'],
  deal: ['deal:demo-won','deal:demo-open','deal:demo-lost'],
  contact: [],
};
const expectedCoastIds = {
  vendor: ['party:demo-lender','party:demo-build'],
  client: ['party:demo-client'],
  lead: ['party:demo-lead'],
  deal: ['deal:demo-won','deal:demo-open'],
  contact: [],
};
for (const kind of ['vendor','client','lead','deal','contact']) test(`kind ${kind} intersects before pruning complete paths`, () => {
  const view = filterNetwork(recording, {kind});
  assert.deepEqual(view.nodes.map(n=>n.id), expectedIds[kind]);
  const ids = new Set(view.nodes.map(n => n.id));
  const keep = e => ids.has(e.from) && ids.has(e.to) && (!e.via || ids.has(e.via));
  assert.deepEqual(view.edges, recording.edges.filter(keep));
  assert.deepEqual(view.suggestions, recording.suggestions.filter(keep));
  assert.deepEqual(view.referrals, recording.referrals.filter(r => ids.has(r.node_id)));
  assert.equal(filterNetwork(recording, {kind, q:'no matching subject'}).nodes.length, 0);
  assert.deepEqual(filterNetwork(recording, {kind,territory:'Demo Coast',vertical:'dental',q:'Demo'}).nodes.map(n=>n.id), expectedCoastIds[kind]);
});

test('kind removes introductions through a filtered intermediary without shortening the path',async()=>{
 const data=structuredClone(recording), intro=data.suggestions[0];
 data.nodes.find(n=>n.id===intro.from).kind='vendor';
 data.nodes.find(n=>n.id===intro.to).kind='vendor';
 intro.via=data.nodes.find(n=>n.kind==='client').id;
 data.edges.find(e=>e.id===intro.id).via=intro.via;
 assert.ok((await parser).validNetwork(data));
 const view=filterNetwork(data,{kind:'vendor'});
 assert.ok(view.nodes.some(n=>n.id===intro.from));assert.ok(view.nodes.some(n=>n.id===intro.to));
 assert.ok(!view.edges.some(e=>e.id===intro.id));assert.deepEqual(view.suggestions,[]);
});

let assets;
async function open(t, width=1440, theme='light') {
  assets ||= await appAssetSnapshot();
  const browser = await chromium.launch(); t.after(()=>browser.close());
  const page = await browser.newPage({viewport:{width,height:900}});
  await page.clock.install({time:new Date()});
  await page.addInitScript(theme=>localStorage.setItem('doctorcre.visual-preferences',JSON.stringify({theme,walkthroughSeen:{joe:true,dell:true}})),theme);
  let reads=0, mode='ok'; const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!=='http://localhost')return route.abort();
    if(url.pathname==='/api/v1/business/relationships'){
      reads++;
      if(mode==='fail'||mode==='auth')return route.fulfill({status:mode==='auth'?403:503,json:{error:'unavailable'}});
      const data=structuredClone(recording);data.observed_at=await page.evaluate(()=>new Date().toISOString());data.valid_until=new Date(Date.parse(data.observed_at)+120000).toISOString();
      if(mode==='many')for(let i=0;i<20;i++)data.nodes.push({...data.nodes[0],id:`party:extra-${i}`,name:`Demo Extra ${i}`});
      if(mode==='malformed')data.nodes[0].kind='invented';
      if(mode==='empty')Object.assign(data,{nodes:[],edges:[],suggestions:[],referrals:[]});
      return route.fulfill({json:data});
    }
    if(['/auth/session','/api/system-work/session'].includes(url.pathname))return route.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic'}});
    if(url.pathname.startsWith('/api/')||url.pathname==='/mcp')return route.fulfill({status:503,json:{error:'unavailable'}});
    const asset=assets.get(url.pathname==='/relationships'?'/relationships.html':url.pathname);
    return asset?route.fulfill({body:url.pathname === '/js/relationship-network.js' ? asset.body.toString().replace(/mountRelationshipNetwork\(\{document,window,client:\w+\}\)/, 'window.__network = $&') : asset.body,contentType:asset.contentType||asset.type}):route.fulfill({status:404,body:''});
  });
  return {page,errors,reads:()=>reads,mode:v=>mode=v};
}
for(const width of [390,1440])for(const theme of ['light','dark'])test(`kind restore select reset tabs refresh keyboard ${width} ${theme}`,async t=>{
  const h=await open(t,width,theme),{page}=h;
  await page.goto('http://localhost/relationships?mode=live&kind=vendor');
  await page.locator('#networkNodes button').first().waitFor();
  const select=page.getByLabel('Relationship kind',{exact:true});
  assert.equal(await select.inputValue(),'vendor');
  assert.equal(await page.locator('#networkNodes button').count(),2);
  const before=h.reads();
  await select.focus();await page.keyboard.press('c');await page.keyboard.press('Tab');
  assert.equal(await select.inputValue(),'client', 'native keyboard selection changes kind');
  await select.selectOption('client');
  assert.deepEqual(await page.locator('#networkNodes [data-node]').evaluateAll(ns=>ns.map(n=>n.dataset.node)),recording.nodes.filter(n=>n.kind==='client').map(n=>n.id));
  await page.locator('#networkSearch').fill('no matching subject');
  assert.equal(await page.locator('#networkNodes button').count(),0);
  await page.locator('#networkSearch').fill('');
  await page.locator('#referralsTab').click();assert.equal(new URL(page.url()).searchParams.get('kind'),'client');
  assert.equal(h.reads(),before);
  await page.locator('#networkRefresh').click();await page.waitForFunction(()=>document.querySelector('#networkRefresh').getAttribute('aria-busy')==='false');
  assert.equal(await select.inputValue(),'client');
  await page.reload();await page.locator('#networkNodes button').first().waitFor({state:'attached'});
  assert.equal(await select.inputValue(),'client');
  await page.locator('#graphTab').click();
  await page.locator('#networkReset').click();
  assert.equal(await select.inputValue(),'');assert.equal(new URL(page.url()).searchParams.has('kind'),false);
  assert.equal(await page.locator('#networkNodes button').count(),recording.nodes.length);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await mkdir(new URL('out/test-artifacts/network-kind-focus/',root),{recursive:true});
  await page.screenshot({path:`out/test-artifacts/network-kind-focus/${width}-${theme}.png`,fullPage:true});
  assert.deepEqual(h.errors,[]);
});
test('invalid kind normalizes to All; malformed and empty recover; expiry and auth clear data',async t=>{
 const h=await open(t),{page}=h;h.mode('malformed');
 await page.goto('http://localhost/relationships?mode=live&kind=invented');
 await page.waitForFunction(()=>!document.querySelector('#networkNotice').hidden);
 assert.equal(await page.locator('#networkKind').inputValue(),'');assert.equal(new URL(page.url()).searchParams.has('kind'),false);
 assert.equal(await page.locator('#networkNodes button').count(),0);
 h.mode('empty');await page.locator('#networkRefresh').click();await page.waitForFunction(()=>document.querySelector('#networkRefresh').getAttribute('aria-busy')==='false');
 assert.equal(await page.locator('#networkNodes button').count(),0);
 h.mode('ok');await page.locator('#networkRefresh').click();await page.locator('#networkNodes button').first().waitFor();
 await page.locator('#networkKind').selectOption('vendor');h.mode('fail');await page.locator('#networkRefresh').click();
 await page.waitForFunction(()=>!document.querySelector('#networkNotice').hidden);assert.equal(await page.locator('#networkNodes button').count(),2);
 await page.clock.fastForward(121000);await page.waitForFunction(()=>document.querySelectorAll('#networkNodes button').length===0);
 h.mode('ok');await page.locator('#networkRefresh').click();await page.locator('#networkNodes button').first().waitFor();
 assert.equal(await page.locator('#networkKind').inputValue(),'vendor');
 h.mode('auth');await page.locator('#networkRefresh').click();await page.waitForURL('**/public-shell/session-ended.html');
 assert.equal(await page.locator('#networkNodes button').count(),0);assert.deepEqual(h.errors,[]);
});

test('kind removes selected node safely and resets expanded graph limit',async t=>{
 const h=await open(t),{page}=h;h.mode('many');
 await page.goto('http://localhost/relationships?mode=live');await page.locator('#networkMore').waitFor();
 await page.locator('#networkMore').click();assert.equal(await page.locator('.relationship-node').count(),24);
 await page.locator('#networkNodes [data-node="party:demo-client"]').click();await page.keyboard.press('Escape');
 await page.locator('#networkKind').selectOption('vendor');
 assert.equal(await page.locator('.relationship-dialog[open]').count(),0);
 assert.equal(new URL(page.url()).searchParams.has('node'),false);
 assert.equal(await page.locator('.relationship-node').count(),12);
 assert.equal(await page.locator('#networkKind').evaluate(n=>n===document.activeElement),true);
});
for (const phase of ['initial load','ready','refresh']) test(`disposal during ${phase} ignores late completion and retires local control`,async t=>{
 const h=await open(t),{page}=h;
 if(phase!=='initial load'){await page.goto('http://localhost/relationships?mode=live');await page.locator('#networkNodes button').first().waitFor();}
 let release;const gate=new Promise(resolve=>release=resolve);t.after(()=>release());
 let requested;const pending=new Promise(resolve=>requested=resolve);
 await page.route('**/api/v1/business/relationships*',async route=>{requested();await gate;await route.fallback().catch(()=>{});});
 if(phase==='initial load')await page.goto('http://localhost/relationships?mode=live');else if(phase==='refresh')await page.locator('#networkRefresh').click();else requested();
 await pending;
 await page.evaluate(()=>window.__network.dispose()).catch(error=>{release();throw error;});
 const before=await page.locator('#networkNodes').textContent();
 release();await page.waitForTimeout(100);
 assert.equal(await page.locator('#networkKind').count(),0);
 assert.equal(await page.locator('#networkNodes').textContent(),before);
 assert.deepEqual(h.errors,[]);
});
