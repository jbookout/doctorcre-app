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
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(5000);await page.clock.install({time:new Date('2026-10-01T15:00:00Z')});
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
 const {page,errors}=await open(t,{clientHooks:hooks});await page.goto(origin+'/deals');await page.locator('.deal-link').first().click();await page.waitForFunction(()=>document.querySelector('#dealDialog')?.open);
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
