import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { createFixtureClient } from '../js/fixture-client.js';
import { FEATURES } from '../js/usage-contract.v1.js';
const releaseSha='a'.repeat(40);
const root=new URL('../',import.meta.url);
const routes=JSON.parse(await readFile(new URL('contracts/app-routes.v1.json',root)));
async function setup(t,{width=1440,motion='no-preference',brief=true}={}) {
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage({viewport:{width,height:960},reducedMotion:motion});const context=page.context();
 const fixture=await createFixtureClient({seedUrl:`data:application/json;base64,${(await readFile(new URL('data/board-seed.json',root))).toString('base64')}`});
 let scope='joe',fail=false,ready=brief,revision=0,thread=[{id:'demo-note',kind:'note',text:'Demo short summary. Original synthetic entry with additional details.',recorded_at:new Date().toISOString()}];const calls=[],errors=[];
 const day=new Date().toLocaleDateString('en-CA');
 const data=()=>({state:'ready',sponsor:scope,sections:{deals:{state:'ready',items:[{id:'d14',name:'Demo Lease Review',owner:scope},{id:'d05',name:'Demo Tour Planning',owner:scope},{id:'d20',name:'Demo Revised Terms',owner:scope}]},today:{state:'ready',items:[{subject_type:'deal',subject_id:'d14',owner:scope,due_on:'2026-01-01',what:revision ? 'Review updated demo lease comments' : 'Review demo lease comments'},{subject_type:'deal',subject_id:'d05',owner:scope,due_on:day,what:'Confirm demo tour access'}]},loops:{state:'empty',items:[]}}});
 await page.addInitScript(()=>{window.spoken=[];window.speechStops=0;window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};Object.defineProperty(window,'speechSynthesis',{value:{speak:utterance=>{window.spoken.push(utterance.text);window.lastUtterance=utterance;},cancel:()=>window.speechStops++}});});
 page.on('pageerror',error=>errors.push(error.message));
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!=='http://localhost')return route.abort();
  const rpc=value=>route.fulfill({json:{result:{content:[{type:'text',text:JSON.stringify(value)}]}}});
  if(url.pathname==='/app-release')return route.fulfill({json:{source_commit:releaseSha,provider_version_created_at:'2026-10-01T00:00:00.000Z'}});
  if(url.pathname==='/api/v1/usage-signals')return route.fulfill({json:{schema:'doctorcre-usage.v1',release_sha:releaseSha,enabled:true,coverage:'since_release',features:FEATURES.map(feature=>({...feature,uses:{joe:feature.id==='home:view'?3:0,dell:feature.id==='home:view'?1:0},last_used:{joe:null,dell:null},never_used:{joe:feature.id!=='home:view',dell:feature.id!=='home:view'}}))}});
  if(url.pathname==='/api/system-work/session')return route.fulfill({json:{actor:{slug:scope}}});
  if(url.pathname==='/pipeline/changes') {return route.fulfill({json:{events:url.searchParams.get('cursor')!=='demo-end' ? [{id:'demo-event',subject_type:'deal',subject_id:'d20',field:'next_step',new_value:'Review revised demo terms',recorded_at:new Date().toISOString()}]:[],cursor:'demo-end'}});}
  if(url.pathname==='/mcp') {
   const {name,arguments:args}=route.request().postDataJSON().params;calls.push({name,args});
   if(name==='morning-brief')return fail ? route.fulfill({status:503,body:''}) : rpc(ready ? data() : {ok:true});
   const methods={'deal-room-board':'getBoard','today-triage':'todayTriage','list-doc-suggestions':'listDocSuggestions','list-doc-conversations':'listDocConversations','notification-feed':'notificationFeed','loop-board':'loopBoard','list-industry-events':'listIndustryEvents'};
   if(name==='get-deal-room') {const value=await fixture.getDeal(args.deal);return rpc({...value.deal,deal_id:value.deal.id,thread,critical_dates:[],events:[]});}
   if(methods[name])return rpc(await fixture[methods[name]](args));
   if(name==='lead-board')return rpc({leads:[],stages:[],as_of:new Date().toISOString()});
   return rpc({ok:true});
  }
  if(url.pathname.startsWith('/api/'))return route.fulfill({json:{}});
  const file=routes.routes[url.pathname]||url.pathname.slice(1);try{return route.fulfill({body:await readFile(new URL(file,root)),contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});}catch{return route.fulfill({status:404,body:''});}
 });
 const goto=async(path='/deals?mode=live')=>{await page.goto('http://localhost'+path);await page.locator('#docPresence').waitFor();};
 return {page,goto,calls,errors,set scope(value){scope=value;},set ready(value){ready=value;},set fail(value){fail=value;},set thread(value){thread=value;},change(){revision++;}};
}
const snap=async(page,name)=>{await mkdir(new URL('out/test-artifacts/w12/',root),{recursive:true});await page.screenshot({path:new URL(`out/test-artifacts/w12/${name}.png`,root).pathname,animations:'disabled'});};

test('live first-open brief and wide record detail; desktop/phone renders, focus, original entry, no horizontal overflow',async t=>{
 const state=await setup(t);const {page}=state;await state.goto();await page.locator('#docMorningBrief[open]').waitFor();
 assert.equal(await page.locator('[data-brief-record]').count(),3);assert.deepEqual(await page.locator('#docMorningBrief h3').allTextContents(),['Do first','Overnight','Today','Weekly feature use']);
 assert.doesNotMatch(await page.locator('#docMorningBrief').innerText(),/read from|source|records read|retry|Read again/);
 await page.locator('.weekly-usage svg').waitFor();
 assert.match(await page.locator('.weekly-usage').innerText(),/Joe 3 · Dell 1/);
 await page.locator('.weekly-usage select').selectOption('doc');
 assert.equal(await page.locator('.weekly-usage tbody tr').count(),3);
 await page.locator('.weekly-usage select').selectOption('view');
 await snap(page,'brief-desktop');
 assert.ok(await page.locator('#docMorningBrief').evaluate(node=>node.getBoundingClientRect().width)>1000);
 await page.locator('[data-brief-record="0"]').click();await page.locator('.morning-record').waitFor();await page.locator('#morningContent summary').click();assert.match(await page.locator('#morningContent details[open]').innerText(),/Original synthetic entry/);await snap(page,'record-desktop');
 await page.locator('#morningBack').click();await page.setViewportSize({width:390,height:844});await snap(page,'brief-phone');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.equal(await page.locator('#docMorningBrief').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
 await page.locator('[data-brief-record="0"]').click();await page.locator('.morning-record').waitFor();await snap(page,'record-phone');
 assert.equal(await page.locator('#docMorningBrief').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
 await page.locator('#morningClose').click();await page.locator('#docOpen').click();await page.locator('#docMorning').click();await page.locator('#docMorningBrief[open]').waitFor();assert.equal(await page.locator('dialog[open]').count(),1);
 await page.keyboard.press('Escape');assert.equal(await page.locator('#docOpen').evaluate(node=>document.activeElement===node),true);
 assert.deepEqual(state.errors,[]);assert.ok(state.calls.filter(call=>call.name==='morning-brief').every(call=>Object.keys(call.args).length===0));
});
test('daily preference survives navigation; speech is opt-in, stops, persists, and resumes refresh with no duplicate autoplay',async t=>{
 const state=await setup(t);const {page}=state;await state.goto();await page.locator('#docMorningBrief[open]').waitFor();assert.equal(await page.evaluate(()=>spoken.length),0);
 await page.locator('#morningSpeech').click();await page.locator('#morningListen').click();assert.equal(await page.evaluate(()=>spoken.length),1);assert.ok(await page.evaluate(()=>spoken[0].split(/\s+/).length<=65));
 await page.locator('#morningClose').click();assert.ok(await page.evaluate(()=>speechStops)>0);const loaded=page.waitForResponse(res=>res.url().endsWith('/mcp')&&res.request().postDataJSON()?.params?.name==='morning-brief');await page.reload();await loaded;await page.locator('#docPresence').waitFor();
 assert.equal(await page.locator('#docMorningBrief').evaluate(node=>node.open),false);await page.locator('#docOpen').click();await page.locator('#docMorning').click();assert.equal(await page.locator('#morningSpeech').getAttribute('aria-pressed'),'true');assert.equal(await page.evaluate(()=>spoken.length),0);
 state.change();await page.evaluate(()=>window.dispatchEvent(new Event('online')));try { await page.waitForFunction(()=>document.getElementById('morningContent').textContent.includes('updated demo')); } catch(error) { throw new Error(JSON.stringify({calls:state.calls.filter(call=>call.name==='morning-brief').length,text:await page.locator('#docMorningBrief').innerText(),errors:state.errors})+error.message); }
 assert.deepEqual(state.errors,[]);
});
test('unavailable brief recovers on background read, clears prior facts, partner changes never reuse content/preferences',async t=>{
 const state=await setup(t,{brief:false});const {page}=state;await state.goto();await page.locator('#docOpen').click();await page.locator('#docMorning').click();assert.match(await page.locator('#morningCoverage').innerText(),/unavailable/);
 state.ready=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));try { await page.locator('[data-brief-record]').first().waitFor(); } catch(error) { throw new Error(JSON.stringify({calls:state.calls.filter(call=>call.name==='morning-brief').length,text:await page.locator('#docMorningBrief').innerText(),errors:state.errors})+error.message); }state.fail=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForFunction(()=>document.getElementById('morningCoverage').textContent==='Brief unavailable');assert.equal(await page.locator('[data-brief-record]').count(),0);
 state.fail=false;state.scope='dell';await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForFunction(()=>document.getElementById('morningTitle').textContent.includes('Dell'));assert.equal(await page.locator('#morningSpeech').getAttribute('aria-pressed'),'false');assert.deepEqual(state.errors,[]);
});
test('motion includes hover and ambient pulse; reduced motion is measured at desktop and phone widths',async t=>{
 for(const motion of ['no-preference','reduce'])for(const width of [1440,390]){
  const {page,goto}=await setup(t,{motion,width});await goto();await page.locator('#docMorningBrief[open]').waitFor();await page.locator('.morning-card').first().hover();
  const css=await page.locator('.morning-card').first().evaluate(node=>({transform:getComputedStyle(node).transform,transition:getComputedStyle(node).transitionDuration,pulse:getComputedStyle(node.querySelector('.morning-marker')).animationName,duration:getComputedStyle(node.querySelector('.morning-marker')).animationDuration}));
  assert.equal(await page.locator('.weekly-usage .usage-bar').first().evaluate(node=>getComputedStyle(node).animationName),motion==='reduce'?'none':'usage-enter');
  if(motion==='reduce'){assert.equal(css.transform,'none');assert.equal(css.transition,'0s');assert.equal(css.pulse,'none');}else{assert.notEqual(css.pulse,'none');assert.equal(css.duration,'1s');assert.notEqual(css.transition,'0s');}
  if(motion==='reduce')await snap(page,`reduced-${width}`);
 }
});
test('Doc remains reachable with invalid or missing brief without consuming the daily opening',async t=>{
 const {page,goto}=await setup(t,{brief:false});await goto();assert.equal(await page.locator('#docMorningBrief').evaluate(node=>node.open),false);
 await page.locator('#docOpen').click();await page.locator('#docMorning').click();await page.locator('#docMorningBrief[open]').waitFor();
 assert.equal(await page.locator('[data-brief-record]').count(),0);assert.match(await page.locator('#morningCoverage').innerText(),/unavailable/);
 assert.equal(await page.evaluate(()=>localStorage.getItem('doctorcre:morning:joe')),null);
});

test('keyboard record entry moves focus into detail and Back restores the invoking card',async t=>{
 const {page,goto}=await setup(t);await goto();await page.locator('#docMorningBrief[open]').waitFor();const card=page.locator('[data-brief-record="0"]');await card.focus();await page.keyboard.press('Enter');await page.locator('.morning-record').waitFor();
 assert.equal(await page.evaluate(()=>document.activeElement.id),'morningBack');await page.keyboard.press('Enter');await card.waitFor();assert.equal(await card.evaluate(node=>document.activeElement===node),true);
});
test('refresh retains Details on stable note identity and uses Back when it leaves the visible five',async t=>{
 const state=await setup(t),{page}=state;await state.goto();await page.locator('#docMorningBrief[open]').waitFor();await page.locator('[data-brief-record="0"]').click();await page.locator('.morning-record').waitFor();const original=page.locator('#morningContent details').filter({hasText:'Original synthetic entry'});await original.locator('summary').click();await original.locator('summary').focus();
 state.thread=[{id:'prepended-note',text:'Demo prepended note.'},{id:'demo-note',text:'Demo short summary. Original synthetic entry with additional details.'}];await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForFunction(()=>document.getElementById('morningContent').textContent.includes('prepended'));
 assert.equal(await original.evaluate(node=>node.open),true);assert.equal(await original.locator('summary').evaluate(node=>document.activeElement===node),true);assert.equal(await page.locator('#morningContent details').first().evaluate(node=>node.open),false);
 state.thread=Array.from({length:5},(_,index)=>({id:`new-note-${index}`,text:`Demo replacement note ${index}.`}));await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForFunction(()=>document.getElementById('morningContent').textContent.includes('replacement'));
 assert.equal(await page.evaluate(()=>document.activeElement.id),'morningBack');assert.equal(await page.locator('#morningContent details[open]').count(),0);
});

for (const key of ['d', 'k']) test(`Doc Control+${key} switches from a speaking brief to the command bar with one modal`, async t => {
 const { page, goto } = await setup(t);
 await goto(); await page.locator('#docMorningBrief[open]').waitFor();
 await page.locator('#morningSpeech').click(); await page.locator('#morningListen').click();
 await page.keyboard.press(`Control+${key}`);
 await page.locator('#docDetail[open]').waitFor();
 assert.equal(await page.locator('dialog[open]').count(), 1);
 assert.equal(await page.locator('#docCommandInput').evaluate(node => document.activeElement === node), true);
 await page.waitForFunction(() => window.speechStops > 0);
 await page.keyboard.press('Escape');
 await page.waitForFunction(() => document.activeElement?.id === 'docOpen');
 assert.equal(await page.locator('dialog[open]').count(), 0);
 assert.equal(await page.locator('#docOpen').evaluate(node => document.activeElement === node), true);
 await page.locator('#docOpen').click(); await page.locator('#docMorning').click();
 assert.equal(await page.locator('dialog[open]').count(), 1);
 assert.equal(await page.locator('#docMorningBrief').evaluate(node => node.open), true);
});
