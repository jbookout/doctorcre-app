import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { readFile } from 'node:fs/promises';
const conversation='0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01';
for (const width of [390,1280]) for (const theme of ['light','dark']) test(`corrupt neighbors survive reload at ${width} ${theme}`,async t=>{
 const server=await fixtureServer();t.after(()=>server.close());
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width,height:900},colorScheme:theme});
 await page.goto(server.origin+'/conversations');
 const mount=async seed=>page.evaluate(async({conversation,seed,theme})=>{
  document.documentElement.dataset.theme=theme;
  const {mountAskComposer}=await import('/js/ui-host.js');
  const prefix=`doctorcre:asks:v1:isolated-browser:${conversation}:`,key='22222222-2222-4222-8222-222222222222';
  if(seed){
   localStorage.setItem(prefix+'before','{');
   localStorage.setItem(prefix+key,JSON.stringify({kind:'queued',request:{body:'Valid beside corruption',idempotency_key:key,conversation_id:conversation}}));
   localStorage.setItem(prefix+'after','{');
   localStorage.setItem(prefix+'draft',JSON.stringify({text:'Preserved current draft',version:1}));
   localStorage.setItem('doctorcre:asks:v1:other-actor:'+conversation+':bad','{');
  }
  const host=document.createElement('section');host.id='isolation';document.querySelector('main').append(host);
  window.isolation={prefix,calls:[]};
  await mountAskComposer(host,{askSession:async()=>({actor:'isolated-browser'}),submitDocRequest:async request=>{
   window.isolation.calls.push(request);
   return {ok:true,contract:'doc-request.v1',status:'accepted',...request,request_msg_id:request.idempotency_key};
  }},conversation);
 },{conversation,seed,theme});
 await mount(true);
 const host=page.locator('#isolation');
 await host.getByText('Received by Dr. CRE. An answer is still pending.',{exact:true}).waitFor();
 await host.getByText(/Some saved asks or the saved draft need recovery/).waitFor();
 assert.equal(await host.locator('textarea').inputValue(),'Preserved current draft');
 assert.equal(await page.evaluate(()=>window.isolation.calls.length),1);
 await page.reload();await mount(false);
 await host.getByText('Received by Dr. CRE. An answer is still pending.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.isolation.calls.length),0);
 assert.deepEqual(await page.evaluate(()=>['before','after'].map(k=>localStorage.getItem(window.isolation.prefix+k))),['{','{']);
 await host.locator('textarea').fill('Text kept during access failure');
 await page.evaluate(()=>{window.originalGetItem=Storage.prototype.getItem;Storage.prototype.getItem=()=>{throw Error('unavailable');};window.dispatchEvent(new Event('storage'));});
 await host.getByText('Device storage is unavailable. Saved asks cannot be read or confirmed.',{exact:true}).waitFor();
 assert.equal(await host.locator('textarea').inputValue(),'Text kept during access failure');
 await page.evaluate(()=>{Storage.prototype.getItem=window.originalGetItem;window.dispatchEvent(new Event('storage'));});
 await host.getByText(/Some saved asks or the saved draft need recovery/).waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await host.screenshot({path:`/tmp/WR617.S19.J1-${width}-${theme}.png`});
});
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

test('malformed draft reports recovery while typing and sending',async t=>{
 const server=await fixtureServer();t.after(()=>server.close());
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage();await page.goto(server.origin+'/conversations');
 await page.evaluate(async conversation=>{
  const {mountAskComposer}=await import('/js/ui-host.js');
  const host=document.createElement('section');host.id='draftProbe';document.querySelector('main').append(host);
  window.draftProbe={key:`doctorcre:asks:v1:draft-probe:${conversation}:draft`,calls:0};
  localStorage.setItem(window.draftProbe.key,'{');
  await mountAskComposer(host,{askSession:async()=>({actor:'draft-probe'}),submitDocRequest:async()=>{window.draftProbe.calls++;return {};}},conversation);
 },conversation);
 const host=page.locator('#draftProbe');await host.locator('textarea').fill('New current draft.');
 await host.locator('#askNotice').filter({hasText:/Saved draft needs recovery/}).waitFor();
 assert.match(await host.locator('#askNotice').textContent(),/Saved draft needs recovery/);
 assert.doesNotMatch(await host.textContent(),/storage is unavailable|changed in another tab/);
 await host.getByRole('button',{name:'Send ask',exact:true}).click();
 await host.locator('#askNotice').filter({hasText:/^Saved draft needs recovery/}).waitFor();
 assert.match(await host.locator('#askNotice').textContent(),/Saved draft needs recovery/);
 assert.equal(await host.locator('textarea').inputValue(),'New current draft.');
 assert.deepEqual(await page.evaluate(()=>{localStorage.setItem('probe','ok');return [localStorage.getItem(window.draftProbe.key),localStorage.getItem('probe'),window.draftProbe.calls];}),['{','ok',0]);
});
test('session invalidation during submission ignores held receipt and stops queued neighbor',async t=>{
 const server=await fixtureServer();t.after(()=>server.close());
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage();await page.goto(server.origin+'/conversations');
 await page.evaluate(async conversation=>{
  const {mountAskComposer}=await import('/js/ui-host.js');
  const prefix=`doctorcre:asks:v1:retirement-probe:${conversation}:`;
  for(const key of ['22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'])localStorage.setItem(prefix+key,JSON.stringify({kind:'queued',request:{body:'Saved '+key,idempotency_key:key,conversation_id:conversation}}));
  const host=document.createElement('section');host.id='retirementProbe';document.querySelector('main').append(host);
  window.retirementProbe={prefix,calls:0};
  await mountAskComposer(host,{askSession:async()=>({actor:'retirement-probe'}),submitDocRequest:request=>{
   window.retirementProbe.calls++;return new Promise(resolve=>{window.retirementProbe.release=()=>resolve({ok:true,contract:'doc-request.v1',status:'accepted',...request,request_msg_id:request.idempotency_key});});
  }},conversation);
 },conversation);
 await page.locator('#retirementProbe').getByText('Sending your ask…',{exact:true}).waitFor();
 const result=await page.evaluate(async()=>{
  const saved=()=>Object.keys(localStorage).filter(k=>k.startsWith(window.retirementProbe.prefix)).map(k=>[k,localStorage.getItem(k)]);
  const before=saved();window.dispatchEvent(new Event('doctorcre-session-invalidated'));
  window.retirementProbe.release();await new Promise(resolve=>setTimeout(resolve,0));
  window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('storage'));
  await new Promise(resolve=>setTimeout(resolve,0));
  return {before,after:saved(),calls:window.retirementProbe.calls};
 });
 assert.equal(await page.locator('#retirementProbe').textContent(),'');
 assert.deepEqual(result.after,result.before);assert.equal(result.calls,1);
});
for (const corruption of ['conversation_id','idempotency_key']) test(`late acceptance preserves ${corruption} recovery notice and bytes`,async t=>{
 const server=await fixtureServer();t.after(()=>server.close());
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage();await page.goto(server.origin+'/conversations');
 await page.evaluate(async conversation=>{
  const {mountAskComposer}=await import('/js/ui-host.js');
  const host=document.createElement('section');host.id='receiptProbe';document.querySelector('main').append(host);
  const prefix=`doctorcre:asks:v1:receipt-probe:${conversation}:`;
  for(const [i,key] of ['22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'].entries())localStorage.setItem(prefix+key,JSON.stringify({kind:'queued',request:{body:i?'Second':'First',idempotency_key:key,conversation_id:conversation}}));
  window.receiptProbe={prefix,calls:[]};
  await mountAskComposer(host,{askSession:async()=>({actor:'receipt-probe'}),submitDocRequest:request=>{
   window.receiptProbe.calls.push(request);
   const receipt={ok:true,contract:'doc-request.v1',status:'accepted',...request,request_msg_id:request.idempotency_key};
   return window.receiptProbe.calls.length===1?new Promise(resolve=>{window.receiptProbe.release=()=>resolve(receipt);}):Promise.resolve(receipt);
  }},conversation);
 },conversation);
 const host=page.locator('#receiptProbe');await host.getByText('Sending your ask…',{exact:true}).waitFor();
 await host.locator('textarea').fill('Current draft');
 await page.evaluate(corruption=>{
  const probe=window.receiptProbe,key=probe.prefix+probe.calls[0].idempotency_key;
  const row=JSON.parse(localStorage.getItem(key));row.request[corruption]='44444444-4444-4444-8444-444444444444';
  probe.raw=JSON.stringify(row);probe.key=key;localStorage.setItem(key,probe.raw);window.dispatchEvent(new Event('storage'));
 },corruption);
 await host.getByText(/Some saved asks or the saved draft need recovery/).waitFor();
 await page.evaluate(()=>window.receiptProbe.release());
 await host.getByText('Received by Dr. CRE. An answer is still pending.',{exact:true}).waitFor();
 await host.getByText(/Some saved asks or the saved draft need recovery/).waitFor();
 assert.equal(await host.locator('textarea').inputValue(),'Current draft');
 assert.equal(await host.getByText('First',{exact:true}).count(),0);
 assert.deepEqual(await page.evaluate(()=>({preserved:localStorage.getItem(window.receiptProbe.key)===window.receiptProbe.raw,calls:window.receiptProbe.calls.map(r=>r.body)})),{preserved:true,calls:['First','Second']});
});
