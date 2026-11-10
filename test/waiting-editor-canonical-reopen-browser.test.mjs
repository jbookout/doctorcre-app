import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from './browser-harness.mjs';
const built = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {WaitingEditor} from './src/ui/home/waiting-editor'; import {fixtureInboxRpc} from './src/ui/home/fixture'; import {createInboxClient} from './src/ui/home/inbox';
const rpc=fixtureInboxRpc(); let item; let mode='normal'; let release; const writes=[]; const client=createInboxClient(async(name,args)=>{if(name==='read-home-inbox-v5' && mode==='readfail') {mode='normal';throw Error('Read unavailable');} if(name.endsWith('-home-waiting')) {writes.push(structuredClone(args)); if(mode==='conflict') {mode='normal';throw Object.assign(Error(),{payload:{error:'version_conflict'}});} const value=await rpc(name,args);if(mode==='lost'){mode='normal';throw Error('Lost reply');}if(mode==='held')await new Promise(r=>release=r);return value;}return rpc(name,args);}); const root=createRoot(document.getElementById('host')); const render=()=>root.render(React.createElement(WaitingEditor,{item,client,disabled:false,update:value=>{item=value;render();},activity:()=>{}}));
window.harness={async seed(reason){const row=(await client.read()).items[0];await rpc('set-home-waiting',{idempotency_key:crypto.randomUUID(),item_id:row.item_id,item_version:row.base_version,base_version:row.waiting_version,reason,evidence:['proof:'+reason],target:{kind:'party',id:'00000000-0000-0000-0000-000000000099'}});item=(await client.read()).items[0];render();},mode(value){mode=value},writes,dispose(){root.unmount()},release(){release?.()},retire(){item={...item,source_state:'done',section:'done'};render()}}; await window.harness.seed('Old reason');`, resolveDir: process.cwd(), sourcefile: 'waiting-harness.tsx' }, bundle: true, write: false, format: 'esm', platform: 'browser' });
async function mount(t,width=390,theme='light') {
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage({viewport:{width,height:900},colorScheme:theme});
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<main id="host"></main>'}));await page.goto('http://127.0.0.1/inbox');await page.addScriptTag({type:'module',content:built.outputFiles[0].text});
 return page;
}
for (const width of [390,1440]) for (const theme of ['light','dark']) test(`canonical reopen and draft lifecycle ${width} ${theme}`, async t => {
 const page=await mount(t,width,theme);
 const open=()=>page.getByRole('button',{name:'Correct waiting person',exact:true}).click();const reason=page.getByLabel('Reason',{exact:true}); const evidence=page.getByLabel('Evidence references, one per line');
 await open();assert.equal(await reason.inputValue(),'Old reason');await page.getByRole('button',{name:'Close editor'}).click();
 await page.evaluate(()=>window.harness.seed('New canonical reason'));await open();assert.equal(await reason.inputValue(),'New canonical reason');assert.equal(await evidence.inputValue(),'proof:New canonical reason');
 await reason.fill('Deliberate draft');await evidence.fill('proof:local');await page.evaluate(()=>window.harness.seed('Background reason'));assert.equal(await reason.inputValue(),'Deliberate draft');
 await page.getByRole('button',{name:'Load people',exact:true}).click();await page.getByLabel('Search people by name').fill('Demo');await page.getByLabel('Person',{exact:true}).selectOption('00000000-0000-0000-0000-000000000099');
 await page.evaluate(()=>window.harness.mode('conflict'));await page.getByRole('button',{name:'Save waiting person'}).click();await page.evaluate(()=>window.harness.mode('readfail'));await page.getByRole('button',{name:'Refresh this card'}).click();await page.getByText(/Refresh unavailable/).waitFor();assert.equal(await reason.inputValue(),'Deliberate draft');await page.getByRole('button',{name:'Refresh this card'}).click();await page.getByText(/Latest card loaded/).waitFor();assert.equal(await reason.inputValue(),'Deliberate draft');assert.equal(await evidence.inputValue(),'proof:local');
 await page.evaluate(()=>window.harness.mode('lost'));await page.getByRole('button',{name:'Save waiting person'}).click();await page.getByRole('button',{name:'Retry same waiting request'}).waitFor();assert.equal(await reason.isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Close editor'}).isDisabled(),true);
 await page.getByRole('button',{name:'Retry same waiting request'}).click();await open();assert.equal(await reason.inputValue(),'Deliberate draft');assert.equal(await evidence.inputValue(),'proof:local');
 const writes=await page.evaluate(()=>window.harness.writes);assert.deepEqual(writes[1],writes[2]);assert.equal(writes[0].base_version,2);assert.equal(writes[1].base_version,3);
 await reason.fill('Cancelled');await page.getByRole('button',{name:'Close editor'}).click();await open();assert.equal(await reason.inputValue(),'Deliberate draft');assert.equal(await page.getByLabel('Person',{exact:true}).inputValue(),'');
 await page.evaluate(()=>window.harness.retire());await reason.waitFor({state:'detached'});await page.evaluate(()=>window.harness.dispose());assert.equal(await page.locator('#host').textContent(),'');
});

test('person selection evidence limits and disposal',async t=>{
 const page=await mount(t);const open=()=>page.getByRole('button',{name:'Correct waiting person',exact:true}).click();await open();
 const reason=page.getByLabel('Reason',{exact:true}), evidence=page.getByLabel('Evidence references, one per line');
 await page.getByRole('button',{name:'Save waiting person'}).click();await page.getByText('Choose a person, add a reason and 1 to 20 evidence references.').waitFor();assert.equal((await page.evaluate(()=>window.harness.writes)).length,0);
 await page.getByRole('button',{name:'Load people',exact:true}).click();await page.getByLabel('Search people by name').fill('Demo');await page.getByLabel('Person',{exact:true}).selectOption('00000000-0000-0000-0000-000000000099');
 await evidence.fill(Array.from({length:21},(_,i)=>'proof:'+i).join('\n'));await page.getByRole('button',{name:'Save waiting person'}).click();assert.equal((await page.evaluate(()=>window.harness.writes)).length,0);
 await evidence.fill(Array.from({length:20},(_,i)=>'proof:'+i).join('\n'));await page.evaluate(()=>window.harness.mode('held'));await page.getByRole('button',{name:'Save waiting person'}).click();await page.getByText('Waiting for confirmation…').waitFor();
 await page.evaluate(()=>window.harness.dispose());await page.evaluate(()=>window.harness.release());assert.equal(await page.locator('#host').textContent(),'');
});
for(const state of ['closed','editing'])test(`disposal from ${state}`,async t=>{const page=await mount(t);await page.getByRole('button',{name:'Correct waiting person',exact:true}).waitFor();if(state==='editing')await page.getByRole('button',{name:'Correct waiting person',exact:true}).click();await page.evaluate(()=>window.harness.dispose());assert.equal(await page.locator('#host').textContent(),'');});
