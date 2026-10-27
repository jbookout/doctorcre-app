import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium, waitForAsync} from './browser-harness.mjs';
import {renderClientPortalLink} from '../js/client-portal-link.js';
const root=new URL('../',import.meta.url);
const PORTAL='https://share.doctorcre.com/demo-practice';

test('the client portal link renders only for https and escapes the address',()=>{
 assert.equal(renderClientPortalLink(null),'');
 assert.equal(renderClientPortalLink(''),'');
 assert.equal(renderClientPortalLink('javascript:alert(1)'),'');
 assert.equal(renderClientPortalLink('http://share.doctorcre.com/demo'),'');
 const html=renderClientPortalLink('https://share.doctorcre.com/a"b');
 assert.match(html,/href="https:\/\/share\.doctorcre\.com\/a&quot;b"/);
 assert.match(html,/target="_blank" rel="noopener noreferrer"/);
});

async function open(t,width=1280,{portal=null,closed=false}={}) {
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height:960}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const seed=JSON.parse(await readFile(new URL('data/board-seed.json',root),'utf8'));
 Object.assign(seed.deals.find(d=>d.id==='d14'),{phase:'Negotiation',workspace_kind:'team',account_client_id:null,operating_state:'active',client_portal_url:portal});
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!=='http://localhost')return route.abort();
  if(url.pathname==='/data/board-seed.json')return route.fulfill({json:seed});
  if(url.pathname.startsWith('/api/')||url.pathname==='/app-release')return route.fulfill({json:{}});
  const file=url.pathname==='/deals'?'pipeline.html':url.pathname.slice(1);
  try{return route.fulfill({body:await readFile(new URL(file,root)),contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});}
  catch{return route.fulfill({status:404,body:''});}
});
 if(closed) Object.assign(seed.deals.find(d=>d.id==='d14'),{phase:'Closed',closed_on:'2026-10-02',outcome:'won'});
 await page.goto('http://localhost/deals'+(closed?'?deal=d14':''));
 await waitForAsync(page,async()=>(await import('/js/pipeline.js')).state.deals.size>0);
 return {page,errors};
}

for(const width of [390,1280]) test(`a set link shows on the deal card and opens safely at ${width}px`,async t=>{
 const {page,errors}=await open(t,width,{portal:PORTAL});
 const card=page.locator('.kanban-card[data-id="d14"]');
 const link=card.getByRole('link',{name:/Client portal/});
 assert.equal(await link.getAttribute('href'),PORTAL);
 assert.equal(await link.getAttribute('target'),'_blank');
 assert.match(await link.getAttribute('rel'),/noopener/);
 await link.focus();
 assert.equal(await page.evaluate(()=>document.activeElement.className),'client-portal-link');
 assert.ok((await link.boundingBox()).height>=44,'touch target');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
 assert.equal(await page.locator('.kanban-card:not([data-id="d14"]) .client-portal-link').count(),0);
 assert.deepEqual(errors,[]);
});

test('a deal without a link shows none on its card',async t=>{
 const {page}=await open(t);
 assert.equal(await page.locator('.client-portal-link').count(),0);
});

test('a partner registers the portal from the deal panel, a taken name is refused, and the password is never shown again',async t=>{
 const {page,errors}=await open(t);
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');await state.client.registerClientPortal({deal:'d20',slug:'taken',password:'other',idempotency_key:'seed-taken'});});
 await page.locator('.kanban-card[data-id="d14"] [data-open]').click();
 const submit=async(slug,password)=>{
  await page.locator('#detailClientPortalForm').waitFor({state:'attached'});
  if(!await page.locator('#clientPortalSlug').isVisible())await page.locator('.client-portal-register summary').click();
  await page.locator('#clientPortalSlug').fill(slug);
  assert.equal(await page.locator('#clientPortalPassword').getAttribute('type'),'password');
  await page.locator('#clientPortalPassword').fill(password);
  await page.getByRole('button',{name:'Register portal'}).click();
 };
 const card=page.locator('.kanban-card[data-id="d14"] .client-portal-link');
 await submit('taken','simple-pw');
 await page.waitForFunction(()=>document.getElementById('detailClientPortalStatus')?.textContent.includes('That portal name is already taken'));
 assert.equal(await card.count(),0);
 await submit('demo-practice','simple-pw');
 await card.waitFor();
 assert.equal(await card.getAttribute('href'),PORTAL);
 await page.locator('#recordPanel .client-portal-link').waitFor();
 assert.equal(await page.locator('#detailClientPortalForm').count(),0,'a registered deal offers no second registration');
 assert.equal(await page.locator('#clientPortalPassword').count(),0);
 assert.equal(await page.locator('input').evaluateAll(inputs=>inputs.some(input=>input.value==='simple-pw')),false);
 assert.equal((await page.locator('#recordPanel').innerText()).includes('simple-pw'),false);
 assert.deepEqual(errors,[]);
});

test('a closed deal shows its portal link without board controls',async t=>{
 const {page}=await open(t,1280,{portal:PORTAL,closed:true});
 const link=page.locator('#recordPanel .client-portal-link');
 await link.waitFor({timeout:3000});
 assert.equal(await link.getAttribute('href'),PORTAL);
 assert.equal(await page.locator('#detailClientPortalForm').count(),0);
});

test('a different password refusal explains the existing portal password',async t=>{
 const {page}=await open(t);
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');state.client.registerClientPortal=async()=>{const error=new Error('fixture refusal');error.payload={error:'portal_password_differs'};throw error;};});
 await page.locator('.kanban-card[data-id="d14"] [data-open]').click();
 await page.locator('.client-portal-register summary').click();
 await page.getByLabel('Portal name').fill('demo-practice');
 await page.locator('#clientPortalPassword').fill('different-password');
 await page.getByRole('button',{name:'Register portal'}).click();
 await page.waitForFunction(()=>document.getElementById('detailClientPortalStatus')?.textContent.includes('That password does not match the existing portal password.'),null,{timeout:1500});
});

test('an unanswered registration can be checked with its original request',async t=>{
 const {page}=await open(t);
 await page.evaluate(async()=>{const {state}=await import('/js/pipeline.js');const send=state.client.registerClientPortal.bind(state.client);let first=true;state.client.registerClientPortal=async request=>{if(first){first=false;throw new Error('offline');}return send(request);};});
 await page.locator('.kanban-card[data-id="d14"] [data-open]').click();
 await page.locator('.client-portal-register summary').click();
 await page.getByLabel('Portal name').fill('demo-practice');
 await page.locator('#clientPortalPassword').fill('simple-pw');
 await page.getByRole('button',{name:'Register portal'}).click();
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Check outcome'}).click({timeout:2000});
 await page.locator('.kanban-card[data-id="d14"] .client-portal-link').waitFor({timeout:2000});
});
