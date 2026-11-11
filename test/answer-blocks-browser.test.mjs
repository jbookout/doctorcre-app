import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
const privateId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01';
test('conversation answers sort, filter, chart, preserve refresh and dispose at phone widths',async t=>{
 const server=await fixtureServer();t.after(()=>server.close());
 const browser=await chromium.launch();t.after(()=>browser.close());
 await mkdir('out/test-artifacts/interactive-answers',{recursive:true});
 for(const width of [320,390,1280]) for(const theme of ['light','dark']) await t.test(`${width} ${theme}`,async()=>{
  const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});
  await page.clock.install({time:new Date('2026-11-03T15:00:00Z')});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(theme=>localStorage.setItem('dealroom-theme',theme),theme);
  await page.route('**/auth/session',r=>r.fulfill({json:{actor:{slug:'joe'},csrf_token:'synthetic'}}));
  await page.route('**/js/fixture-client.js',async r=>{
   let src=await readFile(new URL('../js/fixture-client.js',import.meta.url),'utf8');
   src=src.replace('export async function createFixtureClient','async function originalFixture');
   src+=`\nexport async function createFixtureClient(opts){const c=await originalFixture(opts),read=c.readDocConversation;window.answerReads=0;c.readDocConversation=async args=>{window.answerReads++;const p=await read(args);if(p.turns[1]){let blocks=p.turns[1].answer_blocks;if(window.answerMode==='invalid')blocks=[{type:'html',id:'bad'}];if(window.answerMode==='none')blocks=[];if(blocks?.[0]?.type==='table.v1'){blocks=structuredClone(blocks);if(window.answerMode==='changed')blocks[0].rows[0].rent.value=99;blocks[0].rows.push({deal:{value:'<img src=x onerror=alert(1)>'},rent:{value:-2,source:{record_id:'11111111-1111-4111-8111-111111111111'}}});blocks.push({type:'chart.v1',id:'chart',table_id:'comps',kind:window.answerMode==='line'?'line':'bar',x:'deal',y:'rent'});}p.turns[1].answer_blocks=blocks;}return p;};return c;}`;
   await r.fulfill({contentType:'text/javascript',body:src});
  });
  try {
   await page.goto(`${server.origin}/doc-chats?id=${privateId}`);
   if(!await page.locator('.answer-table').count()) await page.locator(`[data-open="${privateId}"]`).click();
   await page.locator('.answer-table').waitFor();
   assert.equal(await page.locator('.answer-table tbody tr').count(),3);
   assert.equal(await page.locator('.answer-table img').count(),0);
   await page.getByRole('button',{name:'Proposed rent ($/SF/year)',exact:true}).focus();
   await page.keyboard.press('Enter');
   assert.match(await page.locator('.answer-table tbody tr').first().textContent(),/-2/);
   await page.getByRole('searchbox').fill('Gulf');
   assert.equal(await page.locator('.answer-table tbody tr').count(),1);
   const refresh=async mode=>{
    const count=await page.evaluate(mode=>{window.answerMode=mode;return window.answerReads;},mode);
    await page.clock.fastForward(120000);
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await page.waitForFunction(count=>window.answerReads>count,count);
    await page.waitForFunction(async()=> (await import('/js/conversations.js')).view.conversation.state==='read');
   };
   await refresh('bar');
   assert.equal(await page.getByRole('searchbox').inputValue(),'Gulf');
   await page.getByRole('button',{name:'Reset table'}).click();
   await page.locator('.answer-chart rect').first().focus();
   await page.locator('.answer-chart [role="status"]').filter({hasText:'Demo Gulf Breeze: 24'}).waitFor();
   await page.locator('.answer-source summary').first().click();
   assert.match(await page.locator('.answer-source').first().textContent(),/Record 11111111/);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:`out/test-artifacts/interactive-answers/${width}-${theme}.png`,fullPage:true});
   await page.getByRole('searchbox').fill('Crestview');await refresh('changed');
   await page.waitForFunction(()=>document.querySelector('.answer-table input')?.value==='');
   assert.match(await page.locator('.answer-table').textContent(),/99/);
   await refresh('invalid');await page.getByText('Interactive answer unavailable',{exact:true}).waitFor();
   assert.match(await page.locator('#turnList').textContent(),/survey window/);
   await refresh('line');await page.locator('.answer-chart circle').first().waitFor();
   await refresh('none');await page.locator('.answer-table').waitFor({state:'detached'});
   await refresh('bar');await page.locator('.answer-table').waitFor();
   await page.getByRole('searchbox').fill('Gulf');
   await page.evaluate(()=>{history.pushState({},'', '/doc-chats');window.dispatchEvent(new PopStateEvent('popstate'));});
   await page.locator('.answer-table').waitFor({state:'detached'});
   assert.deepEqual(errors,[]);
  } finally {await page.close();}
 });
});
test('bounded DOM, idempotent mounting, independent block reset and disposal',async t=>{
 const server=await fixtureServer();t.after(()=>server.close());
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage();t.after(()=>page.close());
 await page.goto(server.origin+'/doc-chats');
 await page.evaluate(async()=>{
  const api=await import('/js/ui-answers.generated.js');
  const host=document.createElement('div');host.id='reader-test';document.body.append(host);
  const columns=Array.from({length:20},(_,i)=>({key:`c${i}`,label:`Column ${i}`,type:'text'}));
  const table={type:'table.v1',id:'max',columns,rows:Array.from({length:200},()=>Object.fromEntries(columns.map(c=>[c.key,{value:null}])))};
  window.reader={api,host,table};api.mountAnswerBlocks(host,[table],'first');api.mountAnswerBlocks(host,[table],'first');
 });
 await page.locator('#reader-test tbody tr').nth(199).waitFor();
 assert.equal(await page.locator('#reader-test td').count(),4000);
 await page.evaluate(()=>{const {api,host,table}=window.reader;api.mountAnswerBlocks(host,Array.from({length:8},(_,i)=>({...table,id:`table${i}`,rows:[table.rows[0]]})),'first');});
 await page.waitForFunction(()=>document.querySelectorAll('#reader-test table').length===8);
 assert.equal(await page.locator('#reader-test td').count(),160);
 await page.locator('#reader-test input').nth(1).fill('—');
 await page.evaluate(()=>{const {api,host,table}=window.reader;api.mountAnswerBlocks(host,Array.from({length:8},(_,i)=>({...table,id:`table${i}`,rows:i===0?[]:[table.rows[0]]})),'first');});
 await page.waitForFunction(()=>document.querySelectorAll('#reader-test tbody tr').length===7);
 assert.equal(await page.locator('#reader-test input').nth(1).inputValue(),'—');
 await page.evaluate(()=>{const {api,host,table}=window.reader;api.mountAnswerBlocks(host,[table],'second');});
 await page.waitForFunction(()=>document.querySelectorAll('#reader-test tbody tr').length===200);
 assert.equal(await page.locator('#reader-test input').inputValue(),'');
 await page.evaluate(()=>{const {api,host}=window.reader;api.disposeAnswerBlocks(host);api.disposeAnswerBlocks(host);});
 assert.equal(await page.locator('#reader-test').textContent(),'');
 await page.evaluate(()=>{const {api,host}=window.reader;api.mountAnswerBlocks(host,[{type:'html',id:'bad'}],'unavailable');});
 await page.locator('#reader-test').getByText('Interactive answer unavailable',{exact:true}).waitFor();
 await page.evaluate(()=>{const {api,host}=window.reader;api.disposeAnswerBlocks(host);});
 assert.equal(await page.locator('#reader-test').textContent(),'');
 await page.evaluate(()=>{
  const {api,host,table}=window.reader;
  const other=document.createElement('div');other.id='other-answer';document.body.append(other);
  window.reader.other=other;
  api.mountAnswerBlocks(host,[{...table,rows:[table.rows[0]]}],'first');
  api.mountAnswerBlocks(other,[{...table,rows:[table.rows[0]]}],'other');
 });
 await page.locator('#reader-test input').waitFor();
 await page.locator('#other-answer input').fill('kept');
 await page.evaluate(()=>{const {api,host}=window.reader;api.disposeAnswerBlocks(host);host.remove();});
 assert.equal(await page.locator('#reader-test').count(),0);
 assert.equal(await page.locator('#other-answer input').inputValue(),'kept');
 await page.evaluate(()=>{const {api,other}=window.reader;api.disposeAnswerBlocks(other);other.remove();});
});

test('long chart labels stay readable within a 390px page on focus and hover',async t=>{
 await mkdir('out/test-artifacts/interactive-answers',{recursive:true});
 const server=await fixtureServer();t.after(()=>server.close());
 const browser=await chromium.launch();t.after(()=>browser.close());
 for(const kind of ['bar','line']) for(const longCaption of [false,true]) await t.test(`${kind} long ${longCaption?'caption':'value'}`,async()=>{
  const page=await browser.newPage({viewport:{width:390,height:1000}});
  try {
   await page.goto(server.origin+'/doc-chats');
   const label='x'.repeat(2000),columnLabel=longCaption?'y'.repeat(200):'Rent';
   await page.evaluate(async({kind,label,columnLabel})=>{
    const api=await import('/js/ui-answers.generated.js');
    const turn=document.createElement('li');turn.className='turn';
    const host=document.createElement('div');host.className='turn-answer';host.id='long-answer';
    turn.append(host);document.querySelector('#turnList').append(turn);
    api.mountAnswerBlocks(host,[{type:'table.v1',id:'long_labels',columns:[{key:'name',label:'Deal',type:'text'},{key:'rent',label:columnLabel,type:'number'}],rows:[{name:{value:label},rent:{value:24,source:{record_id:'11111111-1111-4111-8111-111111111111'}}}]},{type:'chart.v1',id:'long_chart',table_id:'long_labels',kind,x:'name',y:'rent'}],'long-label');
   },{kind,label,columnLabel});
   const host=page.locator('#long-answer');
   const point=host.locator(kind==='bar'?'rect':'circle');
   await point.waitFor();
   const withinPage=async interaction=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390,`${kind} ${longCaption?'caption':'value'} ${interaction}`);
   await withinPage('before focus');
   await point.focus();
   const status=host.locator('.answer-chart [role="status"]');
   await status.filter({hasText:label+': 24'}).waitFor();
   assert.equal(await point.getAttribute('aria-label'),label+': 24');
   assert.equal(await status.textContent(),label+': 24');
   await withinPage('after focus');
   await host.getByRole('button',{name:'Reset table'}).focus();
   await point.hover();
   await status.filter({hasText:label+': 24'}).waitFor();
   await withinPage('after hover');
   await host.getByRole('button',{name:columnLabel,exact:true}).click();
   await withinPage('after sort');
   await host.getByRole('searchbox').fill('xxxx');
   await withinPage('after filter');
   await host.getByRole('button',{name:'Reset table'}).click();
   await host.locator('.answer-source summary').click();
   await withinPage('after source expansion');
   await host.getByRole('region',{name:'Scrollable answer table'}).focus();
   await withinPage('after table focus');
   await page.screenshot({path:`out/test-artifacts/interactive-answers/long-${kind}-${longCaption}.png`,fullPage:true});
  } finally {await page.close();}
 });
});
