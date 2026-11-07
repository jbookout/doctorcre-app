import { chromium } from './browser-harness.mjs';
import { appAssetSnapshot } from '../scripts/fixture-app-assets.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filterNetwork, validNetwork } from '../js/relationship-network-model.js';
const recording = JSON.parse(readFileSync(new URL('./fixtures/network-kind-focus/recordings.json', import.meta.url)));
const fixture = () => {
 const data = structuredClone(recording);
 data.nodes.forEach((n,i)=> { n.owner = ['Alpha', 'Beta', null, '', ' ', 'Owner not recorded', ' Alpha '][i % 7]; });
 delete data.nodes.at(-1).owner;
 assert.ok(validNetwork(data));
 return data;
};
test('owner uses raw values and composes all predicates before complete-path pruning',()=>{
 const data=fixture();
 for(const raw of ['Alpha','Beta',null,'Owner not recorded',' Alpha ']) {
  const owner=JSON.stringify([raw]);
  for(const extra of [{},{kind:'vendor'},{q:'Demo'},{kind:'vendor',q:'lender',territory:'Demo Coast',vertical:'dental'}]) {
   const expected=filterNetwork(data,extra).nodes.filter(n=>raw===null?!n.owner?.trim():n.owner===raw);
   const view=filterNetwork(data,{...extra,owner});
   assert.deepEqual(view.nodes,expected);
   const ids=new Set(expected.map(n=>n.id)), keep=e=>ids.has(e.from)&&ids.has(e.to)&&(!e.via||ids.has(e.via));
   assert.deepEqual(view.edges,data.edges.filter(keep));
   assert.deepEqual(view.suggestions,data.suggestions.filter(keep));
   assert.deepEqual(view.referrals,data.referrals.filter(r=>ids.has(r.node_id)));
  }
 }
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
      const data=fixture();data.observed_at=await page.evaluate(()=>new Date().toISOString());data.valid_until=new Date(Date.parse(data.observed_at)+120000).toISOString();
      if(mode==='disappeared')data.nodes.forEach(n=>n.owner='Replacement');
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

const ownerValue = raw => JSON.stringify([raw]);
test('owner restore select conjunction reset refresh disappearance and zero business reads',async t=>{
 const h=await open(t),{page}=h;
 await page.goto('http://localhost/relationships?mode=live&owner='+encodeURIComponent(ownerValue('Alpha')));
 await page.locator('#networkNodes button').first().waitFor();
 const select=page.getByLabel('Recorded owner',{exact:true});
 assert.equal(await select.inputValue(),ownerValue('Alpha'));
 const before=h.reads();
 for(const raw of ['Beta',null,'Owner not recorded',' Alpha ']){
  await select.selectOption(ownerValue(raw));
  const expected=fixture().nodes.filter(n=>raw===null?!n.owner?.trim():n.owner===raw);
  assert.deepEqual(await page.locator('#networkNodes [data-node]').evaluateAll(ns=>ns.map(n=>n.dataset.node)),expected.map(n=>n.id));
  assert.equal(await page.locator('#networkCount').textContent(),String(expected.length));
 }
 await select.selectOption(ownerValue('Alpha'));
 await page.locator('#networkKind').selectOption('vendor');
 await page.locator('#networkSearch').fill('Lending');
 assert.equal(await page.locator('#networkCount').textContent(),'1');
 await page.locator('#networkSearch').fill('no match');
 assert.equal(await page.locator('#networkCount').textContent(),'0');
 assert.equal(h.reads(),before);
 await page.locator('#networkSearch').fill('');
 await page.reload();await page.locator('#networkNodes button').first().waitFor();
 assert.equal(await select.inputValue(),ownerValue('Alpha'));
 await page.locator('#networkReset').click();
 assert.equal(await select.inputValue(),'');assert.equal(new URL(page.url()).searchParams.has('owner'),false);
 assert.equal(await page.locator('#networkCount').textContent(),String(recording.nodes.length));
 await select.selectOption(ownerValue('Beta'));h.mode('disappeared');
 await page.locator('#networkRefresh').click();await page.waitForFunction(()=>document.querySelector('#networkRefresh').getAttribute('aria-busy')==='false');
 assert.equal(await select.inputValue(),'');
 assert.match(await page.locator('#networkOwnerNotice').textContent(),/no longer available/);
 assert.equal(new URL(page.url()).searchParams.has('owner'),false);
 assert.deepEqual(h.errors,[]);
});
test('owner removes focus, conceals expiry and retires control on disposal',async t=>{
 const h=await open(t),{page}=h;
 await page.goto('http://localhost/relationships?mode=live');await page.locator('#networkNodes button').first().waitFor();
 await page.locator('#networkNodes button').first().click();
 await page.keyboard.press('Escape');
 await page.locator('#networkOwner').selectOption(ownerValue('Beta'));
 assert.equal(await page.locator('.relationship-dialog[open]').count(),0);
 assert.equal(new URL(page.url()).searchParams.has('node'),false);
 assert.equal(await page.evaluate(()=>document.activeElement.isConnected),true);
 h.mode('fail');await page.clock.fastForward(121000);
 await page.waitForFunction(()=>document.querySelectorAll('#networkNodes button').length===0);
 assert.equal(await page.locator('#networkOwner').isDisabled(),true);
 h.mode('ok');await page.locator('#networkRefresh').click();await page.locator('#networkNodes button').first().waitFor();
 await page.evaluate(()=>window.__network.dispose());
 assert.equal(await page.locator('#networkOwner').count(),0);
 assert.deepEqual(h.errors,[]);
});

test('owner prunes introduction via endpoints without inventing a shorter path',()=>{
 const data=fixture(), intro=data.suggestions[0];
 for(const n of data.nodes)n.owner='Alpha';
 const via=data.nodes.find(n=>n.id!==intro.from&&n.id!==intro.to);
 via.owner='Beta';intro.via=via.id;data.edges.find(e=>e.id===intro.id).via=via.id;
 assert.ok(validNetwork(data));
 const view=filterNetwork(data,{owner:ownerValue('Alpha')});
 assert.ok(view.nodes.some(n=>n.id===intro.from));assert.ok(view.nodes.some(n=>n.id===intro.to));
 assert.equal(view.edges.some(e=>e.id===intro.id),false);assert.deepEqual(view.suggestions,[]);
});
test('owner disposal during initial load ignores late completion',async t=>{
 const h=await open(t),{page}=h;
 let release,requested;
 const gate=new Promise(resolve=>release=resolve), pending=new Promise(resolve=>requested=resolve);
 t.after(()=>release());
 await page.route('**/api/v1/business/relationships*',async route=>{requested();await gate;await route.fallback().catch(()=>{});});
 await page.goto('http://localhost/relationships?mode=live');await pending;
 await page.evaluate(()=>window.__network.dispose());
 release();await page.waitForTimeout(100);
 assert.equal(await page.locator('#networkOwner').count(),0);
 assert.equal(await page.locator('#networkNodes button').count(),0);
 assert.deepEqual(h.errors,[]);
});
