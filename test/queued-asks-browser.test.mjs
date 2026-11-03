import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, fixtureServer } from './browser-harness.mjs';
import { readFile } from 'node:fs/promises';
const conversation='0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01';
for (const width of [390,1280]) for (const theme of ['light','dark']) {
  test(`queued ask keyboard flow at ${width} ${theme}`, async t => {
    const server=await fixtureServer();t.after(()=>server.close());
    const browser=await chromium.launch();t.after(()=>browser.close());
    const page=await browser.newPage({viewport:{width,height:900},colorScheme:theme});
    await page.goto(`${server.origin}/conversations?id=${conversation}`);
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
    const input=page.getByRole('textbox',{name:'Ask Dr. CRE',exact:true}); await input.waitFor();
    await page.context().setOffline(true);
    await input.fill('Please prepare the synthetic lease comparison.');
    await input.press('Tab'); await page.getByRole('button',{name:'Send ask',exact:true}).press('Enter');
    await page.getByText('Saved on this device. Waiting for a connection.',{exact:true}).waitFor();
    await page.context().setOffline(false);
    await page.getByText('Received by Dr. CRE. An answer is still pending.',{exact:true}).waitFor();
    assert.equal(await page.locator('#askText').inputValue(),'');
    await input.fill('A newer draft'); await page.reload();
    await page.getByRole('textbox',{name:'Ask Dr. CRE',exact:true}).waitFor();
    assert.equal(await page.locator('#askText').inputValue(),'A newer draft');
    await page.getByText('Received by Dr. CRE. An answer is still pending.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.addScriptTag({content:await readFile(new URL('../node_modules/axe-core/axe.min.js',import.meta.url),'utf8')});
    const violations=await page.evaluate(async()=> (await window.axe.run(document.querySelector('#askComposer'))).violations);
    assert.deepEqual(violations.map(v=>v.id),[]);
  });
}

for (const width of [390,1280]) test(`recovery after repeated failed reconnects and concurrent asks at ${width}`, async t => {
 const server=await fixtureServer();t.after(()=>server.close());
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height:900}});
 await page.goto(`${server.origin}/conversations`);
 await page.locator('main').waitFor();
 await page.evaluate(async conversation=>{
  const {mountAskComposer}=await import('/js/ui-host.js');
  const host=document.createElement('section');host.id='recoveryProbe';document.querySelector('main').append(host);
  let sessionCalls=0;const calls=[];
  window.askProbe={calls,get sessionCalls(){return sessionCalls;}};
  window.askProbe.dispose=await mountAskComposer(host,{
   askSession:async()=>{if(++sessionCalls<=3)throw Error('temporary offline');return {actor:'recovery-probe'};},
   submitDocRequest:request=>{calls.push(request);return new Promise(resolve=>{
    window.askProbe.release=()=>resolve({ok:true,contract:'doc-request.v1',status:'accepted',conversation_id:request.conversation_id,idempotency_key:request.idempotency_key,request_msg_id:request.idempotency_key});
   });}
  },conversation);
 },conversation);
 const host=page.locator('#recoveryProbe');
 for(let attempt=2;attempt<=3;attempt++){
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await page.waitForFunction(n=>window.askProbe.sessionCalls===n,attempt);
  await host.getByText('Reconnect and sign in to open your saved asks.',{exact:true}).waitFor();
 }
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 const input=host.getByRole('textbox',{name:'Ask Dr. CRE',exact:true});await input.waitFor();
 assert.equal(await page.evaluate(()=>window.askProbe.sessionCalls),4);
 await input.fill('First held synthetic ask');await host.getByRole('button',{name:'Send ask',exact:true}).click();
 await host.getByText('Sending your ask…',{exact:true}).waitFor();
 await input.fill('Second synthetic ask');await host.getByRole('button',{name:'Send ask',exact:true}).click();
 await input.fill('Independent newer draft');
 await page.evaluate(()=>window.askProbe.release());
 await page.waitForFunction(()=>window.askProbe.calls.length===2,{},{timeout:3000});
 await page.evaluate(()=>window.askProbe.release());
 await host.getByText('Received by Dr. CRE. An answer is still pending.',{exact:true}).nth(1).waitFor();
 assert.equal(await input.inputValue(),'Independent newer draft');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 assert.equal(await page.evaluate(()=>window.askProbe.sessionCalls),4);
 await page.evaluate(()=>window.askProbe.dispose());
 assert.equal(await host.textContent(),'');
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 assert.equal(await page.evaluate(()=>window.askProbe.sessionCalls),4);
});

test('session verification stays single-flight and closing prevents later startup', async t => {
 const server=await fixtureServer();t.after(()=>server.close());
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage();await page.goto(`${server.origin}/conversations`);
 await page.locator('main').waitFor();
 await page.evaluate(async conversation=>{
  const {mountAskComposer}=await import('/js/ui-host.js');
  const host=document.createElement('section');host.id='sessionProbe';document.querySelector('main').append(host);
  let calls=0;
  window.sessionProbe={get calls(){return calls;}};
  window.sessionProbe.mounted=mountAskComposer(host,{askSession:()=>{calls++;return new Promise(resolve=>{window.sessionProbe.release=()=>resolve({actor:'closing-probe'});});},submitDocRequest:async()=>({})},conversation);
 },conversation);
 const host=page.locator('#sessionProbe');
 await host.getByText('Verifying your session to open saved asks…',{exact:true}).waitFor();
 await page.evaluate(()=>{window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('online'));});
 assert.equal(await page.evaluate(()=>window.sessionProbe.calls),1);
 await page.evaluate(async()=>{window.dispatchEvent(new Event('doctorcre-session-invalidated'));window.sessionProbe.release();await window.sessionProbe.mounted;window.dispatchEvent(new Event('online'));});
 assert.equal(await host.textContent(),'');
 assert.equal(await page.evaluate(()=>window.sessionProbe.calls),1);
 await page.evaluate(async conversation=>{
  const {mountAskComposer}=await import('/js/ui-host.js');
  const host=document.createElement('section');host.id='unavailableProbe';document.querySelector('main').append(host);
  let calls=0;const dispose=await mountAskComposer(host,{askSession:async()=>{calls++;throw Error('offline');},submitDocRequest:async()=>({})},conversation);
  window.unavailableProbe={get calls(){return calls;},dispose};
 },conversation);
 await page.locator('#unavailableProbe').getByText('Reconnect and sign in to open your saved asks.',{exact:true}).waitFor();
 await page.evaluate(()=>{window.unavailableProbe.dispose();window.dispatchEvent(new Event('online'));});
 assert.equal(await page.locator('#unavailableProbe').textContent(),'');
 assert.equal(await page.evaluate(()=>window.unavailableProbe.calls),1);
});
