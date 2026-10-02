import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { atlasFixtureResponse } from '../scripts/atlas-fixture.mjs';
import { createFixtureClient } from '../js/fixture-client.js';
let server, origin;
before(async()=>{
 const port=19000+Math.floor(Math.random()*20000);origin=`http://127.0.0.1:${port}`;
 server=spawn(process.execPath,['scripts/serve.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>{if(code)reject(Error('Fixture server exited '+code));});});
});
after(()=>server?.kill());
async function open(t,{smallChats=false,clientHooks=''}={}){
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(10000);await page.clock.install({time:new Date('2026-10-01T15:00:00Z')});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/system-work/session',r=>r.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic'}}));
 await page.route('**/api/v1/atlas-graph**',r=>{const u=new URL(r.request().url());u.searchParams.set('limit','2');const a=atlasFixtureResponse(u,'GET');return r.fulfill({status:a.status,json:a.body});});
 if(smallChats || clientHooks)await page.route('**/js/fixture-client.js',async r=>{
  let src=await readFile(new URL('../js/fixture-client.js',import.meta.url),'utf8');src=src.replace('export async function createFixtureClient','async function originalFixture');
  src+=`\nexport async function createFixtureClient(opts){const c=await originalFixture(opts);${smallChats ? "for(const name of ['listDocConversations','readDocConversation','docOutcomeCards']){const f=c[name];c[name]=args=>f({...args,limit:1});}" : ''}${clientHooks}return c;}`;
  await r.fulfill({contentType:'text/javascript',body:src});
 });
 return {page,errors};
}
const online=page=>page.evaluate(()=>window.dispatchEvent(new Event('online')));
test('PR119 finding 8: loaded Doc Chats traversal expires as a whole and can recover',async t=>{
 const hooks=`const read=c.listDocConversations;
 window.chatResponses=[];window.chatReadCount=0;
 c.listDocConversations=async args=>{
  window.chatReadCount++;
  const p=await read({...args,cursor:null,limit:1});
  const n=Number(args.cursor||0);
  p.conversations=[{...p.conversations[0],id:'00000000-0000-4000-8000-00000000000'+n,title:'Synthetic chat '+n}];
  p.more=n<3;p.next_cursor=n<3?String(n+1):null;p.visible_conversation_count=4;
  if(window.holdChats)await new Promise(resolve=>window.chatResponses.push(resolve));
  return p;
 };`;
 const {page,errors}=await open(t,{clientHooks:hooks});await page.goto(origin+'/doc-chats');
 for(let count=2;count<=4;count++){
  await page.locator('#showMoreConversations').click();
  await page.waitForFunction(n=>document.querySelectorAll('#conversationList [data-conversation]').length===n,count);
 }
 await page.evaluate(async()=>{window.chatView=(await import('/js/conversations.js')).view;window.holdChats=true;});
 await online(page);
 for(let n=0;n<3;n++){
  await page.waitForFunction(()=>window.chatResponses.length===1);
  await page.clock.fastForward(9000);await page.evaluate(()=>window.chatResponses.shift()());
 }
 await page.waitForFunction(()=>window.chatResponses.length===1);
 await page.clock.fastForward(9000);await page.evaluate(()=>window.chatResponses.shift()());
 await page.evaluate(()=>window.holdChats=false);
 // Give any uncancelled final response a chance to apply before checking.
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
 assert.equal(await page.evaluate(()=>window.chatView.list.state),'unavailable');
 assert.equal(await page.locator('#conversationList [data-conversation]').count(),0);
 await online(page);await page.waitForFunction(()=>window.chatView.list.state==='read' && window.chatView.list.rows.length===4);
 assert.equal(await page.locator('#conversationList [data-conversation]').count(),4);assert.deepEqual(errors,[]);
});
test('PR119 finding 8: loaded All Work traversal expires as a whole and can recover',async t=>{
 const first=await (await fetch(origin+'/api/v1/work-inventory')).json();
 const second=await (await fetch(origin+'/api/v1/work-inventory?cursor=demo-cursor-page-2')).json();
 const rows=[...first.items,...second.items];
 const answer=url=>{
  const n=Number(new URL(url).searchParams.get('cursor')||0),items=rows.slice(n*4,(n+1)*4);
  return {...first,items,next_cursor:n<3?String(n+1):null,coverage:first.coverage.map(row=>({...row,count_returned:items.filter(item=>item.kind===row.kind).length}))};
 };
 const {page,errors}=await open(t);let pending,hold=false;
 await page.route('**/api/v1/work-inventory**',route=>hold?(pending=route):route.fulfill({json:answer(route.request().url())}));
 await page.goto(origin+'/all-work');
 for(let count=8;count<=14;count+=4){
  await page.locator('#loadMore').click();
  await page.waitForFunction(n=>document.querySelector('#itemsCount')?.textContent.startsWith(String(Math.min(n,14))),count);
 }
 // The fourth page contains the final two fixture rows.
 if(!await page.locator('#itemsCount').textContent().then(s=>s.startsWith('14'))){
  await page.locator('#loadMore').click();await page.waitForFunction(()=>document.querySelector('#itemsCount')?.textContent.startsWith('14'));
 }
 const release=async()=>{const route=pending;pending=null;await route.fulfill({json:answer(route.request().url())}).catch(()=>{});};
 hold=true;await online(page);
 for(let n=0;n<3;n++){
  for(let wait=0;!pending && wait<100;wait++)await page.waitForTimeout(10);
  assert.ok(pending);await page.clock.fastForward(9000);await release();
 }
 for(let wait=0;!pending && wait<100;wait++)await page.waitForTimeout(10);
 assert.ok(pending);await page.clock.fastForward(9000);await release();
 await page.waitForFunction(()=>document.querySelector('#itemsCount')?.textContent!=='Reading…');
 assert.equal(await page.locator('#itemsCount').textContent(),'Unavailable');
 hold=false;await online(page);await page.waitForFunction(()=>document.querySelector('#itemsCount')?.textContent.startsWith('14'));
 assert.deepEqual(errors,[]);
});
for(const trigger of ['online','timer','resume'])test('PR119 dismissed-draft regression: '+trigger+' still refreshes after dismissing an edited suggestion',async t=>{
 const hooks=`window.chatReads={list:0,suggestions:0};for(const [name,key] of [['listDocConversations','list'],['listDocSuggestions','suggestions']]){const read=c[name];c[name]=async args=>{window.chatReads[key]++;return read(args);};}`;
 const {page,errors}=await open(t,{clientHooks:hooks});await page.goto(origin+'/doc-chats');
 const card=page.locator('.suggestion-card').first();await card.waitFor();
 const id=await card.getAttribute('data-suggestion');
 await card.locator('[data-correction]').fill('Synthetic correction to a dismissed suggestion');
 await card.locator('[data-work-number]').fill('123');
 await card.locator('[data-snooze-date]').fill('2026-12-01');
 await card.locator('[data-choice="dismiss"]').click();
 await page.locator(`[data-suggestion="${id}"]`).waitFor({state:'detached'});
 await page.locator('h1').evaluate(e=>{e.tabIndex=-1;e.focus();});
 const before=await page.evaluate(()=>({...window.chatReads}));
 if(trigger==='timer')await page.clock.fastForward(120_000);
 else if(trigger==='resume')await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
 else await online(page);
 // Client calls start synchronously when a read is eligible. Count that
 // public read boundary so an indefinitely skipped callback fails directly.
 const after=await page.evaluate(()=>({...window.chatReads}));
 assert.ok(after.list>before.list,'conversation list refreshes after the editor disappears');
 assert.ok(after.suggestions>before.suggestions,'suggestions refresh after the editor disappears');
 assert.equal(await page.locator(`[data-suggestion="${id}"]`).count(),0);assert.deepEqual(errors,[]);
});
test('PR119 finding 8: aggregate deadline cancels loaded Atlas pages and rejects their late result',async t=>{
 const {page,errors}=await open(t);
 await page.goto(origin+'/control-room?tab=system-map');
 await page.evaluate(async()=>{window.atlasView=(await import('/js/atlas.js')).view;});
 await page.waitForFunction(()=>window.atlasView.status==='ready');
 for(let pages=2;pages<=4;pages++){
  await page.locator('#atlasMore').click();
  await page.waitForFunction(n=>window.atlasView.payload?.nodes.length===n,pages*2);
 }
 const selected=await page.evaluate(async()=> (await import('/js/atlas.js')).view.payload.nodes[7].id);
 await page.locator(`[data-atlas-select="${selected}"]`).first().click();
 let pending;
 await page.route('**/api/v1/atlas-graph**',route=>{pending=route;});
 await page.evaluate(()=>{
  const fetch=window.fetch;
  window.atlasAborts=0;
  window.fetch=(url,init)=>{
   if(String(url).includes('/api/v1/atlas-graph'))init.signal.addEventListener('abort',()=>window.atlasAborts++);
   return fetch(url,init);
  };
 });
 const release=async()=>{
  const route=pending;pending=null;
  const url=new URL(route.request().url());url.searchParams.set('limit','2');
  const response=atlasFixtureResponse(url,'GET');
  await route.fulfill({status:response.status,json:response.body}).catch(()=>{});
 };
 await online(page);
 for(let n=0;n<3;n++){
  await assert.doesNotReject(async()=>{for(let wait=0;!pending && wait<100;wait++)await page.waitForTimeout(10);assert.ok(pending);});
  await page.clock.fastForward(9000);await release();
 }
 for(let wait=0;!pending && wait<100;wait++)await page.waitForTimeout(10);
 assert.ok(pending);
 await page.clock.fastForward(9000);await release();
 await page.waitForFunction(()=>window.atlasView.status!=='loading');
 assert.equal(await page.evaluate(async()=> (await import('/js/atlas.js')).view.status),'offline');
 assert.ok(await page.evaluate(()=>window.atlasAborts)>0,'aggregate cancellation reaches the page transport');
 await page.unroute('**/api/v1/atlas-graph**');
 await page.route('**/api/v1/atlas-graph**',route=>{
  const url=new URL(route.request().url());url.searchParams.set('limit','2');const response=atlasFixtureResponse(url,'GET');
  return route.fulfill({status:response.status,json:response.body});
 });
 await online(page);
 await page.waitForFunction(()=>window.atlasView.status==='ready' && window.atlasView.payload?.nodes.length===8);
 const recovered=await page.evaluate(async()=>{const v=(await import('/js/atlas.js')).view;return {count:v.payload.nodes.length,selected:v.selected,present:v.payload.nodes.some(n=>n.id===v.selected)};});
 assert.deepEqual(recovered,{count:8,selected,present:true});assert.deepEqual(errors,[]);
});
test('PR119 finding 8: a hung Home read expires and a late response cannot overwrite recovery',async t=>{
 const {page,errors}=await open(t);let held=null,count=0;
 const fixture=await createFixtureClient({seedUrl:`data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json',import.meta.url))).toString('base64')}`});
 await page.route('**/api/v1/command-center',async route=>{if(++count===2){held=route;return;}await route.fulfill({json:await fixture.commandCenter()});});
 await page.goto(origin+'/');await page.waitForFunction(()=>document.querySelector('#dealAttention')?.getAttribute('aria-busy')!=='true');
 await online(page);await page.waitForFunction(()=>document.querySelector('#dealAttention')?.getAttribute('aria-busy')==='true');
 await page.clock.fastForward(120_000);await online(page);await page.waitForFunction(()=>document.querySelector('#dealAttention')?.getAttribute('aria-busy')!=='true');
 assert.ok(count>=3);await held.fulfill({status:503,json:{error:'DEPENDENCY_UNAVAILABLE'}}).catch(()=>{});
 assert.notEqual(await page.locator('#dealAttention').getAttribute('aria-busy'),'true');assert.equal(await page.locator('#retryHome').count(),0);assert.deepEqual(errors,[]);
});
test('PR119 finding 10: retained Act caller reaches a supported work lookup and create flow',async t=>{
 const {page,errors}=await open(t);await page.goto(origin+'/doc-chats');
 const link=page.locator('.suggestion-card a').filter({hasText:/Open Tasks|Choose work/}).first();
 const popupPromise=page.waitForEvent('popup');await link.click();const popup=await popupPromise;await popup.waitForLoadState();
 await popup.waitForFunction(()=>document.querySelector('#quickAddForm')?.hidden===false);
 assert.ok(await popup.locator('#taskList [data-task]').count());assert.equal(await popup.locator('#quickAddInput').isVisible(),true);
 assert.notEqual(new URL(popup.url()).pathname,'/');assert.deepEqual(errors,[]);
});
test('PR119 finding 7: a pending Deal poll cannot detach a later Jev reading',async t=>{
 const hooks=`const get=c.getDeal;c.getDeal=async id=>{const d=await get(id);if(window.holdDeal){window.dealWaiting=true;await new Promise(r=>window.releaseDeal=r);}return d;};c.getJevDealReading=async()=>{window.jevWaiting=true;await new Promise(r=>window.releaseJev=r);return {judged:true,movement_rung:2,movement_rungs:5,movement_label:'Synthetic movement',waiting_on:'partner',silence_is_bad:0.2};};`;
 const {page,errors}=await open(t,{clientHooks:hooks});await page.goto(origin+'/index.html');await page.locator('.deal-link').first().click();await page.waitForFunction(()=>document.querySelector('#dealDialog')?.open);
 await page.evaluate(()=>window.holdDeal=true);await online(page);await page.waitForFunction(()=>window.dealWaiting);
 await page.locator('[data-jev-deal]').click();await page.waitForFunction(()=>window.jevWaiting);
 await page.evaluate(()=>window.releaseDeal());await page.evaluate(()=>window.releaseJev());
 await page.waitForFunction(()=>document.querySelector('[data-jev-result]')?.textContent.includes('Synthetic movement'));
 assert.equal(await page.locator('[data-jev-deal]').isEnabled(),true);assert.deepEqual(errors,[]);
});
for(const trigger of ['online','timer','resume'])test('PR119 finding 6: '+trigger+' preserves the active suggestion editor and snooze date',async t=>{
 const {page,errors}=await open(t,{smallChats:true});await page.goto(origin+'/doc-chats');
 const card=page.locator('.suggestion-card').first();await card.locator('[data-correction]').fill('Synthetic correction');await card.locator('[data-snooze-date]').fill('2026-12-01');
 await card.locator('[data-correction]').focus();await card.locator('[data-correction]').evaluate(e=>{window.editor=e;e.setSelectionRange(3,8);});
 if(trigger==='timer')await page.clock.fastForward(31_000);else if(trigger==='resume')await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));else await online(page);
 const editor=await page.evaluate(()=>({connected:window.editor.isConnected,focused:document.activeElement===window.editor,start:window.editor.selectionStart,end:window.editor.selectionEnd,date:document.querySelector('[data-snooze-date]').value}));
 assert.deepEqual(editor,{connected:true,focused:true,start:3,end:8,date:'2026-12-01'});assert.deepEqual(errors,[]);
});
test('PR119 finding 6: a cleared snooze date stays cleared after focus leaves the editor',async t=>{
 const {page,errors}=await open(t);await page.goto(origin+'/doc-chats');
 const date=page.locator('[data-snooze-date]').first();await date.fill('');await date.evaluate(e=>{window.dateEditor=e;e.blur();});
 await online(page);await page.waitForFunction(async()=> (await import('/js/conversations.js')).view.list.state==='read');
 assert.equal(await date.inputValue(),'');assert.deepEqual(errors,[]);
});
test('PR119 finding 5: All Work rereads its loaded extent',async t=>{
 const {page,errors}=await open(t);await page.goto(origin+'/all-work');
 await page.locator('#loadMore').click();await page.waitForFunction(()=>document.querySelector('#itemsCount')?.textContent.includes('14'));
 await online(page);await page.waitForFunction(()=>/\d+ items/.test(document.querySelector('#itemsCount')?.textContent));
 assert.match(await page.locator('#itemsCount').textContent(),/14/);assert.deepEqual(errors,[]);
});
test('PR119 finding 5: Doc Chats refresh keeps loaded conversations and turns',async t=>{
 const {page,errors}=await open(t,{smallChats:true});await page.goto(origin+'/doc-chats');
 await page.locator('#showMoreConversations').click();await page.waitForFunction(()=>document.querySelectorAll('#conversationList [data-conversation]').length===2);
 await online(page);await page.waitForFunction(async()=> (await import('/js/conversations.js')).view.list.state==='read');
 assert.equal(await page.locator('#conversationList [data-conversation]').count(),2);
 await page.locator('#conversationList [data-conversation] button[data-open]').first().click();
 await page.locator('#showMore').click();await page.waitForFunction(()=>document.querySelectorAll('#turnList .turn').length===2);
 await online(page);await page.waitForFunction(async()=> (await import('/js/conversations.js')).view.conversation.state==='read');
 assert.equal(await page.locator('#turnList .turn').count(),2);assert.deepEqual(errors,[]);
});
test('PR119 finding 5: Doc Chats rereads the loaded outcome-card extent',async t=>{
 const {page,errors}=await open(t,{smallChats:true});await page.goto(origin+'/doc-chats');
 await page.locator('#outcomeCardsShowMore').click();await page.waitForFunction(async()=> (await import('/js/conversations.js')).view.outcomeCards.rows.length===2);
 await online(page);await page.waitForFunction(async()=> (await import('/js/conversations.js')).view.outcomeCards.state==='read');
 assert.equal(await page.evaluate(async()=> (await import('/js/conversations.js')).view.outcomeCards.rows.length),2);assert.deepEqual(errors,[]);
});
test('PR119 finding 6: editing started during a pending read defers the suggestion repaint',async t=>{
 const hooks=`const read=c.listDocSuggestions;c.listDocSuggestions=async args=>{const p=await read(args);if(window.holdSuggestions){window.suggestionsWaiting=true;await new Promise(r=>window.releaseSuggestions=r);}return p;};`;
 const {page,errors}=await open(t,{clientHooks:hooks});await page.goto(origin+'/doc-chats');await page.locator('.suggestion-card').first().waitFor();
 await page.evaluate(()=>window.holdSuggestions=true);await online(page);await page.waitForFunction(()=>window.suggestionsWaiting);
 const card=page.locator('.suggestion-card').first();await card.locator('[data-snooze-date]').fill('2026-12-01');await card.locator('[data-correction]').fill('Synthetic mid-read draft');await card.locator('[data-correction]').focus();
 await card.locator('[data-correction]').evaluate(e=>window.editor=e);await page.evaluate(()=>window.releaseSuggestions());
 await page.waitForFunction(async()=> (await import('/js/conversations.js')).view.list.state==='read');
 assert.equal(await page.evaluate(()=>window.editor.isConnected && document.activeElement===window.editor),true);assert.equal(await card.locator('[data-snooze-date]').inputValue(),'2026-12-01');assert.deepEqual(errors,[]);
});
test('PR119 finding 5: Atlas refresh keeps the loaded second page and selected component',async t=>{
 const {page,errors}=await open(t);await page.goto(origin+'/control-room?tab=system-map');
 await page.waitForFunction(async()=> (await import('/js/atlas.js')).view.payload?.nodes.length===2);
 await page.locator('#atlasMore').click();await page.waitForFunction(async()=> (await import('/js/atlas.js')).view.payload?.nodes.length===4);
 const selected=await page.evaluate(async()=> (await import('/js/atlas.js')).view.payload.nodes[3].id);
 await page.locator(`[data-atlas-select="${selected}"]`).first().click();
 await online(page);await page.waitForFunction(async()=> (await import('/js/atlas.js')).view.status==='ready');
 const state=await page.evaluate(async()=>{const v=(await import('/js/atlas.js')).view;return {count:v.payload.nodes.length,selected:v.selected,present:v.payload.nodes.some(n=>n.id===v.selected)};});
 assert.equal(state.count,4);assert.equal(state.selected,selected);assert.equal(state.present,true);assert.deepEqual(errors,[]);
});
