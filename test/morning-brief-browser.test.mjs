import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createFixtureClient } from '../js/fixture-client.js';
const root=new URL('../',import.meta.url);
const routes=(await import("../js/routes.js")).routeContract;
async function setup(t,{width=1440,motion='no-preference',brief=true,coverage=false,timezoneId='America/Chicago',onBrief,dealTitle='Demo Lease Review',dealAction='Review demo lease comments',loopTask}={}) {
 const browser=await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });t.after(()=>browser.close());const page=await browser.newPage({viewport:{width,height:960},reducedMotion:motion,timezoneId});const context=page.context();

 const fixture=await createFixtureClient({seedUrl:`data:application/json;base64,${(await readFile(new URL('data/board-seed.json',root))).toString('base64')}`});
 let scope='joe',fail=false,ready=brief,revision=0,thread=[{id:'demo-note',kind:'note',text:'Demo short summary. Original synthetic entry with additional details.',recorded_at:new Date().toISOString()}];const calls=[],errors=[];
 const day=new Date().toLocaleDateString('en-CA',{timeZone:'America/Chicago'});
 const priorityData=()=>({state:'ready',sponsor:scope,sections:{deals:{state:'ready',items:[{id:'d14',name:dealTitle,owner:scope},{id:'d05',name:'Demo Tour Planning',owner:scope},{id:'d20',name:'Demo Revised Terms',owner:scope}]},today:{state:'ready',items:[{subject_type:'deal',subject_id:'d14',owner:scope,due_on:'2026-01-01',what:revision ? 'Review updated demo lease comments' : dealAction},{subject_type:'deal',subject_id:'d05',owner:scope,due_on:day,what:'Confirm demo tour access'}]},loops:{state:'empty',items:[]}}});
 const data=()=>{
  const value=priorityData();
  if(loopTask){value.sections.today={state:'empty',items:[]};value.sections.loops={state:'ready',items:[loopTask]};}
  if(!coverage)return value;
  value.sections.needs_joe={state:'partial',items:[{title:'Demo waiting coverage decision',action:'Approve the synthetic rule',why:{text:'Demo work needs a ruling'},blocks:{text:'Demo queue'}}]};
  value.sections.claim_card={state:'ready',items:[{display_name:'Demo claim candidate'}]};
  value.sections.renewals={state:'unavailable',items:[]};
  value.sections.assurance_cadence={state:'empty',items:[]};
  value.sections.costs={state:'ready',items:[],providers:[{provider:'Demo provider',mtd_usd:12}]};
  value.sections.deals.accounts=[{account_client_id:'demo-account',account_client_ref:'C-DEMO',account_name:'Demo account portfolio',account_owner:'joe',open_deals:7,attention_deals:3,overdue_deals:2}];
  value.sections.today.items.push(...['next_action','post_call_action','critical_date','ingest'].map((item_kind,index)=>({id:`demo-triage-${index}`,item_kind,subject_type:'deal',subject_id:'private-demo-deal',owner_partner:'dell',what:`Demo ${item_kind}`,due_on:item_kind==='critical_date'?'2099-01-01':day,subject_name:'Demo shared subject'})));
  value.coverage={schema:'morning-brief-coverage.v1',count_scope:'returned_rows_only',required_sections:Object.entries(value.sections).map(([key,section])=>({key,path:`/sections/${key}`,state:section.state,counts:Object.fromEntries(['items','accounts','providers'].filter(name=>Array.isArray(section[name])).map(name=>[name,section.state==='unavailable'?null:section[name].length])),incomplete_sources:key==='needs_joe'?[{key:'work_requests',state:'unavailable'}]:[]}))};
  return value;
 };
 await page.addInitScript(()=>{window.spoken=[];window.speechStops=0;window.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};Object.defineProperty(window,'speechSynthesis',{value:{speak:utterance=>{window.spoken.push(utterance.text);window.lastUtterance=utterance;},cancel:()=>window.speechStops++}});});
 page.on('pageerror',error=>errors.push(error.message));
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!=='http://localhost')return route.abort();
  const rpc=value=>route.fulfill({json:{result:{content:[{type:'text',text:JSON.stringify(value)}]}}});
  if(['/api/system-work/session','/auth/session'].includes(url.pathname))return route.fulfill({json:{csrf_token:`synthetic-${scope}`,actor:{slug:scope}}});
  if(url.pathname==='/pipeline/changes') {return route.fulfill({json:{events:url.searchParams.get('cursor')!=='demo-end' ? [{id:'demo-event',subject_type:'deal',subject_id:'d20',field:'next_step',new_value:'Review revised demo terms',recorded_at:new Date().toISOString()}]:[],cursor:'demo-end'}});}
  if(url.pathname==='/mcp') {
   const {name,arguments:args}=route.request().postDataJSON().params;calls.push({name,args});
   if(name==='morning-brief' && onBrief)await onBrief();
   if(name==='morning-brief')return fail ? route.fulfill({status:503,body:''}) : rpc(ready ? data() : {ok:true});
   const methods={'deal-room-board':'getBoard','today-triage':'todayTriage','list-feature-switches':'listFeatureSwitches','list-doc-suggestions':'listDocSuggestions','list-doc-conversations':'listDocConversations','notification-feed':'notificationFeed','loop-board':'loopBoard','list-industry-events':'listIndustryEvents'};
   if(name==='get-deal-room') {const value=await fixture.getDeal(args.deal);return rpc({...value.deal,...(args.deal==='d14'?{name:dealTitle}:{}),deal_id:value.deal.id,thread,critical_dates:[],events:[]});}
   if(methods[name])return rpc(await fixture[methods[name]](args));
   if(name==='read-loop'&&loopTask)return rpc({loop:loopTask});
   if(name==='lead-board')return rpc({leads:[],stages:[],as_of:new Date().toISOString()});
   return rpc({ok:true});
  }
  if(url.pathname.startsWith('/api/'))return route.fulfill({json:{}});
  const file=routes.routes[url.pathname]||url.pathname.slice(1);try{return route.fulfill({body:await readFile(new URL(file,root)),contentType:/\.m?js$/.test(file)?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});}catch{return route.fulfill({status:404,body:''});}
 });
 const goto=async(path='/deals?mode=live')=>{await page.goto('http://localhost'+path);await page.locator('#docPresence').waitFor({state:'attached'});};
 return {page,goto,calls,errors,set scope(value){scope=value;},set ready(value){ready=value;},set fail(value){fail=value;},set thread(value){thread=value;},change(){revision++;}};
}
const snap=async(page,name)=>{await mkdir(new URL('out/test-artifacts/w12/',root),{recursive:true});await page.screenshot({path:new URL(`out/test-artifacts/w12/${name}.png`,root).pathname,animations:'disabled'});};

test('live brief opens on request and wide record detail; desktop/phone renders, focus, original entry, no horizontal overflow',async t=>{
 const state=await setup(t);const {page}=state;await state.goto();await page.locator('#docOpen[data-brief-unseen]').waitFor();assert.equal(await page.locator('#docMorningBrief').evaluate(node=>node.open),false);await page.locator('#docOpen').click();await page.locator('#docMorning').click();await page.locator('#docMorningBrief[open]').waitFor();
 await page.locator('[data-brief-record]').first().waitFor();assert.equal(await page.locator('[data-brief-record]').count(),3);assert.deepEqual(await page.locator('#docMorningBrief h3').allTextContents(),['Do first','Overnight','Today']);
 assert.doesNotMatch(await page.locator('#docMorningBrief').innerText(),/read from|records read|retry|Read again/);

 await snap(page,'brief-desktop');
 assert.ok(await page.locator('#docMorningBrief').evaluate(node=>node.getBoundingClientRect().width)>1000);
 await page.locator('[data-brief-record="0"]').click();await page.locator('.morning-record').waitFor();await page.locator('#morningContent summary').click();assert.match(await page.locator('#morningContent details[open]').innerText(),/Original synthetic entry/);await snap(page,'record-desktop');
 await page.locator('#morningBack').click();await page.setViewportSize({width:390,height:844});await snap(page,'brief-phone');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.equal(await page.locator('#docMorningBrief').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
 await page.locator('[data-brief-record="0"]').click();await page.locator('.morning-record').waitFor();await snap(page,'record-phone');
 assert.equal(await page.locator('#docMorningBrief').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
 await page.locator('#morningClose').click();await page.locator('#selfAvatar').click();await page.locator('#docOpen').click();await page.locator('#docMorning').click();await page.locator('#docMorningBrief[open]').waitFor();assert.equal(await page.locator('dialog[open]').count(),1);
 await page.keyboard.press('Escape');assert.equal(await page.locator('#selfAvatar').evaluate(node=>document.activeElement===node),true);
 assert.deepEqual(state.errors,[]);assert.ok(state.calls.filter(call=>call.name==='morning-brief').every(call=>Object.keys(call.args).length===0));
});
test('complete priority titles wrap and open the matching record on desktop and phone',async t=>{
 const title='Review the synthetic lease renewal terms with the practice owner before signing';
 for(const width of [1440,390]){
  const {page,goto,errors,calls}=await setup(t,{width,dealTitle:title});await goto();
  if(width===390)await page.locator('#selfAvatar').click();
  await page.locator('#docOpen[data-brief-unseen]').waitFor();await page.locator('#docOpen').click();await page.locator('#docMorning').click();
  const card=page.locator('[data-brief-record]').first();await card.waitFor();
  assert.equal(await card.locator('strong').innerText(),title);
  assert.equal(await card.locator('strong').evaluate(node=>node.scrollWidth<=node.clientWidth&&node.scrollHeight<=node.clientHeight),true);
  assert.equal(await page.locator('#docMorningBrief').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
  await card.focus();await page.keyboard.press('Enter');await page.locator('.morning-record').waitFor();
  assert.equal(calls.filter(call=>call.name==='get-deal-room').at(-1).args.deal,'d14');
  assert.equal(await page.locator('#morningTitle').innerText(),title);
  await page.locator('#morningBack').click();assert.equal(await page.locator('[data-brief-record]').first().locator('strong').innerText(),title);
  await snap(page,`full-title-${width}`);assert.deepEqual(errors,[]);
 }
});
test('priority cards show repeated instructions once and retain distinct refreshed instructions',async t=>{
 const title='Review the <synthetic> lease renewal terms with the practice owner before signing';
 for(const width of [1440,390]){
  const state=await setup(t,{width,dealTitle:title,dealAction:title});const {page}=state;await state.goto();
  if(width===390)await page.locator('#selfAvatar').click();
  await page.locator('#docOpen[data-brief-unseen]').waitFor();await page.locator('#docOpen').click();await page.locator('#docMorning').click();
  const card=page.locator('[data-brief-record]').first();await card.waitFor();
  assert.equal(await card.locator('strong').innerText(),title);
  assert.equal(await card.locator('div > span').count(),0);
  assert.equal(await card.locator('synthetic').count(),0);
  assert.equal(await page.locator('[data-brief-record]').last().locator('div > span').innerText(),'Confirm demo tour access');
  assert.equal(await page.locator('#docMorningBrief').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
  await card.focus();await page.keyboard.press('Enter');await page.locator('.morning-record').waitFor();
  assert.equal(state.calls.filter(call=>call.name==='get-deal-room').at(-1).args.deal,'d14');
  await page.locator('#morningBack').click();assert.equal(await card.evaluate(node=>node===document.activeElement),true);
  assert.equal(await card.locator('div > span').count(),0);await snap(page,`single-instruction-${width}`);
  state.change();await page.locator('#morningRefresh').click();
  await page.waitForFunction(()=>document.querySelector('[data-brief-record] div > span')?.textContent==='Review updated demo lease comments');
  assert.equal(await card.locator('strong').innerText(),title);assert.deepEqual(state.errors,[]);
 }
});
test('task instructions stay readable without open-status noise on desktop and phone',async t=>{
 const task={number:'7',kind:'open_loop',owner:'joe',title:'Review the synthetic lease terms',status:'open',due_on:'2026-01-01',blocker_detail:'Open <demo> and review the proposed lease terms.',body:'Compare the synthetic revisions before responding.'};
 for(const width of [1440,390]){
  const {page,goto,calls,errors}=await setup(t,{width,loopTask:task});await goto();
  if(width===390)await page.locator('#selfAvatar').click();
  await page.locator('#docOpen[data-brief-unseen]').waitFor();await page.locator('#docOpen').click();await page.locator('#docMorning').click();
  const section=page.locator('[data-brief-section="loops"]');await section.locator('summary').click();
  assert.match(await section.innerText(),/Your task: Open <demo> and review the proposed lease terms\./);
  assert.doesNotMatch(await section.innerText(),/Status: open|Blocker:/);
  const card=page.locator('[data-brief-key="loop:open_loop:7"]');await card.focus();await page.keyboard.press('Enter');await page.locator('.morning-record').waitFor();
  assert.deepEqual(calls.filter(call=>call.name==='read-loop').at(-1).args,{number:'7',kind:'open_loop'});
  assert.deepEqual(await page.locator('.morning-record dt').allTextContents(),['Due','Your task']);
  assert.equal(await page.locator('.morning-record dd').last().innerText(),task.blocker_detail);
  assert.match(await page.locator('.morning-record').innerText(),/Compare the synthetic revisions before responding/);
  assert.equal(await page.locator('#docMorningBrief').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
  await snap(page,`task-instructions-${width}`);
  await page.locator('#morningBack').click();assert.equal(await card.evaluate(node=>node===document.activeElement),true);
  assert.deepEqual(errors,[]);
 }
});
test('task title repeats stay omitted in sections and detail while refreshed instructions remain visible',async t=>{
 const title='Review the <synthetic> lease terms with the practice owner before signing';
 for(const width of [1440,390]){
  const task={number:'7',kind:'open_loop',owner:'joe',title,status:'open',due_on:'2026-01-01',blocker_detail:`  ${title.replaceAll(' ','  ')}\n`,body:`${title}. Compare the <synthetic> revisions before responding.`};
  const {page,goto,calls,errors}=await setup(t,{width,loopTask:task});await goto();
  if(width===390)await page.locator('#selfAvatar').click();
  await page.locator('#docOpen[data-brief-unseen]').waitFor();await page.locator('#docOpen').click();await page.locator('#docMorning').click();
  const section=page.locator('[data-brief-section="loops"]');await section.locator('summary').click();
  assert.doesNotMatch(await section.innerText(),/Your task:/);assert.ok((await section.innerText()).includes(title));
  const card=page.locator('[data-brief-key="loop:open_loop:7"]');await card.focus();await page.keyboard.press('Enter');await page.locator('.morning-record').waitFor();
  assert.deepEqual(calls.filter(call=>call.name==='read-loop').at(-1).args,{number:'7',kind:'open_loop'});
  assert.equal(await page.locator('#morningTitle').innerText(),title);assert.deepEqual(await page.locator('.morning-record dt').allTextContents(),['Due']);
  await page.locator('.morning-record summary').click();assert.equal(await page.locator('.morning-record .entry-original').innerText(),task.body);
  assert.equal(await page.locator('#docMorningBrief synthetic').count(),0);
  assert.equal(await page.locator('#docMorningBrief').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
  await snap(page,`task-single-instruction-${width}`);
  task.blocker_detail=`${title} and send the <synthetic> response.`;await page.locator('#morningRefresh').click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.morning-record dt')].some(node=>node.textContent==='Your task'));
  assert.equal(await page.locator('.morning-record dd').last().innerText(),task.blocker_detail);
  assert.equal(await page.locator('.morning-record details').evaluate(node=>node.open),true);
  await page.locator('#morningBack').click();assert.equal(await card.evaluate(node=>node===document.activeElement),true);
  await section.locator('summary').click();
  assert.ok((await section.innerText()).includes(`Your task: ${task.blocker_detail}`));
  assert.deepEqual(errors,[]);
 }
});
test('daily preference survives navigation and refresh without narration, including legacy speech opt-in',async t=>{
 const state=await setup(t);const {page}=state;
 await page.addInitScript(()=>localStorage.setItem('doctorcre:morning:joe',JSON.stringify({...JSON.parse(localStorage.getItem('doctorcre:morning:joe')||'{}'),speech:true})));
 await state.goto();await page.locator('#docOpen[data-brief-unseen]').waitFor();assert.equal(await page.locator('#docMorningBrief').evaluate(node=>node.open),false);await page.locator('#docOpen').click();await page.locator('#docMorning').click();await page.locator('#docMorningBrief[open]').waitFor();
 assert.equal(await page.getByRole('button',{name:/Brief speech|Listen to morning brief|Stop morning brief/}).count(),0);assert.equal(await page.evaluate(()=>spoken.length),0);
 await page.locator('#morningClose').click();const loaded=page.waitForResponse(res=>res.url().endsWith('/mcp')&&res.request().postDataJSON()?.params?.name==='morning-brief');await page.reload();await loaded;await page.locator('#docPresence').waitFor({state:'attached'});
 assert.equal(await page.locator('#docMorningBrief').evaluate(node=>node.open),false);await page.locator('#docOpen').click();await page.locator('#docMorning').click();await page.locator('[data-brief-record]').first().waitFor();
 assert.equal(await page.getByRole('button',{name:/Brief speech|Listen to morning brief|Stop morning brief/}).count(),0);assert.equal(await page.evaluate(()=>spoken.length),0);
 state.change();await page.evaluate(()=>window.dispatchEvent(new Event('online')));try { await page.waitForFunction(()=>document.getElementById('morningContent').textContent.includes('updated demo')); } catch(error) { throw new Error(JSON.stringify({calls:state.calls.filter(call=>call.name==='morning-brief').length,text:await page.locator('#docMorningBrief').innerText(),errors:state.errors})+error.message); }
 assert.deepEqual(state.errors,[]);
});
test('unavailable brief recovers on background read, clears prior facts, partner changes never reuse content/preferences',async t=>{
 const state=await setup(t,{brief:false});const {page}=state;await state.goto();await page.locator('#docOpen').click();await page.locator('#docMorning').click();assert.match(await page.locator('#morningCoverage').innerText(),/unavailable/);
 state.ready=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));try { await page.locator('[data-brief-record]').first().waitFor(); } catch(error) { throw new Error(JSON.stringify({calls:state.calls.filter(call=>call.name==='morning-brief').length,text:await page.locator('#docMorningBrief').innerText(),errors:state.errors})+error.message); }state.fail=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForFunction(()=>document.getElementById('morningCoverage').textContent==='Brief unavailable');assert.equal(await page.locator('[data-brief-record]').count(),0);
 state.fail=false;state.scope='dell';await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForURL('**/public-shell/session-ended.html');assert.equal(await page.locator('#docMorningBrief').count(),0);await state.goto();await page.locator('#docOpen').click();await page.locator('#docMorning').click();await page.waitForFunction(()=>document.getElementById('morningTitle').textContent.includes('Dell'));assert.deepEqual(state.errors,[]);
});
test('V2 motion: hover is a state transition with no pulse; reduced motion is measured at desktop and phone widths',async t=>{
 for(const motion of ['no-preference','reduce'])for(const width of [1440,390]){
  const {page,goto}=await setup(t,{motion,width});await goto();
  if(width===390)await page.locator('#selfAvatar').click();
  await page.locator('#docOpen[data-brief-unseen]').waitFor();await page.locator('#docOpen').click();await page.locator('#docMorning').click();await page.locator('#docMorningBrief[open]').waitFor();await page.locator('.morning-card').first().hover();
  const css=await page.locator('.morning-card').first().evaluate(node=>({transform:getComputedStyle(node).transform,transition:getComputedStyle(node).transitionDuration,pulse:getComputedStyle(node.querySelector('.morning-marker')).animationName}));
  assert.equal(css.pulse,'none','V2 removed the ambient pulse');assert.equal(css.transform,'none');
  if(motion==='reduce')assert.equal(css.transition,'0s');else assert.notEqual(css.transition,'0s');
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
 const {page,goto}=await setup(t);await goto();await page.locator('#docOpen[data-brief-unseen]').waitFor();await page.locator('#docOpen').click();await page.locator('#docMorning').click();await page.locator('#docMorningBrief[open]').waitFor();const card=page.locator('[data-brief-record="0"]');await card.focus();await page.keyboard.press('Enter');await page.locator('.morning-record').waitFor();
 assert.equal(await page.evaluate(()=>document.activeElement.id),'morningBack');await page.keyboard.press('Enter');await card.waitFor();assert.equal(await card.evaluate(node=>document.activeElement===node),true);
});
test('refresh retains Details on stable note identity and uses Back when it leaves the visible five',async t=>{
 const state=await setup(t),{page}=state;await state.goto();await page.locator('#docOpen[data-brief-unseen]').waitFor();await page.locator('#docOpen').click();await page.locator('#docMorning').click();await page.locator('#docMorningBrief[open]').waitFor();await page.locator('[data-brief-record="0"]').click();await page.locator('.morning-record').waitFor();const original=page.locator('#morningContent details').filter({hasText:'Original synthetic entry'});await original.locator('summary').click();await original.locator('summary').focus();
 state.thread=[{id:'prepended-note',text:'Demo prepended note.'},{id:'demo-note',text:'Demo short summary. Original synthetic entry with additional details.'}];await page.locator('#morningRefresh').evaluate(node=>node.click());await page.waitForFunction(()=>document.getElementById('morningContent').textContent.includes('prepended'));
 assert.equal(await original.evaluate(node=>node.open),true);assert.equal(await original.locator('summary').evaluate(node=>document.activeElement===node),true);assert.equal(await page.locator('#morningContent details').first().evaluate(node=>node.open),false);
 state.thread=Array.from({length:5},(_,index)=>({id:`new-note-${index}`,text:`Demo replacement note ${index}.`}));await page.locator('#morningRefresh').evaluate(node=>node.click());await page.waitForFunction(()=>document.getElementById('morningContent').textContent.includes('replacement'));
 assert.equal(await page.evaluate(()=>document.activeElement.id),'morningBack');assert.equal(await page.locator('#morningContent details[open]').count(),0);
});

for (const key of ['d', 'k']) test(`Doc Control+${key} switches from the brief to the command bar with one modal`, async t => {
 const { page, goto } = await setup(t);
 await goto(); await page.locator('#docOpen[data-brief-unseen]').waitFor();await page.locator('#docOpen').click();await page.locator('#docMorning').click();await page.locator('#docMorningBrief[open]').waitFor();
 await page.keyboard.press(`Control+${key}`);
 await page.locator('#docDetail[open]').waitFor();
 assert.equal(await page.locator('dialog[open]').count(), 1);
 // The brief's close event lands a task later; focus must still be on the command bar after it.
 await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
 assert.equal(await page.locator('#docCommandInput').evaluate(node => document.activeElement === node), true);
 await page.keyboard.press('Escape');
 await page.waitForFunction(() => document.activeElement?.id === 'docOpen');
 assert.equal(await page.locator('dialog[open]').count(), 0);
 assert.equal(await page.locator('#docOpen').evaluate(node => document.activeElement === node), true);
 await page.locator('#docOpen').click(); await page.locator('#docMorning').click();
 assert.equal(await page.locator('dialog[open]').count(), 1);
 assert.equal(await page.locator('#docMorningBrief').evaluate(node => node.open), true);
});


test('full returned coverage is expandable on desktop and phone in a UTC browser',async t=>{
 const state=await setup(t,{coverage:true,timezoneId:'UTC'}),{page}=state;
 await state.goto();await page.locator('#docOpen[data-brief-unseen]').waitFor();await page.locator('#docOpen').click();await page.locator('#docMorning').click();
 const needs=page.locator('[data-brief-section="needs_joe"]');
 await needs.locator('summary').click();await needs.getByText(/Demo waiting coverage decision/).waitFor({state:'visible'});
 assert.match(await needs.innerText(),/partial.*Work requests unavailable/s);
 await page.locator('[data-brief-section="today"] > summary').click();
 for(const kind of ['next_action','post_call_action','critical_date','ingest']) {
  const summary=page.locator('[data-brief-section="today"] li summary').filter({hasText:`Demo ${kind}`});await summary.click();
  assert.match(await summary.locator('..').innerText(),/private-demo-deal/);
 }
 await page.locator('[data-brief-section="deals"] > summary').click();await page.getByText(/Demo account portfolio/).waitFor({state:'visible'});
 const account=page.locator('[data-brief-section="deals"] li details');await account.locator('summary').click();assert.match(await account.innerText(),/C-DEMO.*Attention deals: 3.*Overdue deals: 2/s);
 await page.locator('[data-brief-section="costs"] summary').click();await page.getByText(/Demo provider/).first().waitFor({state:'visible'});
 await needs.scrollIntoViewIfNeeded();await snap(page,'coverage-desktop');await page.setViewportSize({width:390,height:844});await needs.scrollIntoViewIfNeeded();await snap(page,'coverage-phone');
 assert.ok(await page.locator('#docMorningBrief').evaluate(node=>node.scrollWidth<=node.clientWidth));
 assert.deepEqual(state.errors,[]);
});

for(const selected of [false,true]) test(`F4 resumed brief removes ${selected?'selected detail':'priority facts'} until the current authenticated read`,async t=>{
 let hold=false,release;const held=new Promise(resolve=>release=resolve);t.after(()=>release());
 const {page,goto,errors}=await setup(t,{onBrief:()=>hold?held:undefined});await goto();
 await page.locator('#docOpen[data-brief-unseen]').waitFor();await page.locator('#docOpen').click();await page.locator('#docMorning').click();
 await page.locator('[data-brief-record]').first().waitFor();
 if(selected){await page.locator('[data-brief-record]').first().click();await page.locator('.morning-record').waitFor();}
 hold=true;
 const suspended=await page.evaluate(()=>{window.dispatchEvent(new Event('online'));return {content:document.getElementById('morningContent').textContent,title:document.getElementById('morningTitle').textContent};});
 assert.equal(suspended.content,'');assert.equal(suspended.title,'Morning brief');
 await snap(page,`suspended-${selected?'detail':'priorities'}`);
 release();await page.locator('[data-brief-record]').first().waitFor();assert.equal(await page.locator('.morning-record').count(),0);
 assert.equal(await page.evaluate(()=>spoken.length),0);assert.deepEqual(errors,[]);
});

for (const trigger of ['reopen', 'idle wake']) test(`F4 ${trigger} clears cached facts and replaces an outstanding read`, {timeout:15_000}, async t => {
 let hold=false,releaseOld,releaseFresh,started;
 const oldRead=new Promise(resolve=>releaseOld=resolve),freshRead=new Promise(resolve=>releaseFresh=resolve);
 const reading=new Promise(resolve=>started=resolve);
 let held=0;
 t.after(()=>{releaseOld();releaseFresh();});
 const state=await setup(t,{onBrief:()=>{
  if(!hold)return;
  if(++held===1){started();return oldRead;}
  return freshRead;
 }});
 const {page}=state; await state.goto();
 await page.locator('#docOpen[data-brief-unseen]').waitFor();
 await page.locator('#docOpen').click(); await page.locator('#docMorning').click();
 await page.locator('[data-brief-record]').first().waitFor();
 if(trigger==='reopen')await page.locator('#morningClose').click();
 hold=true;
 await page.locator('#morningRefresh').evaluate(node=>node.click());
 await reading;
 const pending=await page.evaluate(trigger=>{
  if(trigger==='reopen')document.getElementById('docMorning').click();
  else {const original=Date.now;Date.now=()=>original()+31*60_000;document.dispatchEvent(new Event('pointerdown'));Date.now=original;}
  return {content:document.getElementById('morningContent').textContent,title:document.getElementById('morningTitle').textContent};
 },trigger);
 assert.deepEqual(pending,{content:'',title:'Morning brief'});
 releaseOld();
 assert.equal(await page.locator('[data-brief-record]').count(),0);
 releaseFresh(); await page.locator('[data-brief-record]').first().waitFor();
 assert.equal(await page.locator('[data-brief-record]').count(),3);

 assert.deepEqual(state.errors,[]);
});
