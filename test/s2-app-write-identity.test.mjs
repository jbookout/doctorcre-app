import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { randomUUID } from 'node:crypto';
import { createRetainedCommands } from '../js/retained-commands.mjs';

test('closing and reopening a national form preserves its unknown request and locks its original material', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const dom = new JSDOM('<dialog id="formDialog"><p id="dialogContext"></p><h2 id="dialogTitle"></h2><form id="dialogForm"><div id="dialogBody"></div><p id="formError"></p><button id="dialogSubmit"></button></form></dialog>');
  const doc = dom.window.document;
  const dialog = doc.querySelector('dialog'); dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; };
  const calls = []; let lost = true;
  const state = { selfActor: 'joe', client: { createNationalAccount: async args => { calls.push(structuredClone(args)); if (lost) { lost = false; throw new Error('reply lost after commit'); } return { ok: true }; } } };
  const context = vm.createContext({ document: doc, state, createRetainedCommands, uuidv4: randomUUID, FormData: dom.window.FormData,
    $: (selector, root = doc) => root.querySelector(selector), $$: (selector, root = doc) => [...root.querySelectorAll(selector)],
    esc: String, actorName: String, setTimeout: () => 0, loadHome: async () => {}, showToast: () => {} });
  const start = source.includes('function appWrite(') ? source.indexOf('function appWrite(') : source.indexOf('function openForm(');
  vm.runInContext(source.slice(start, source.indexOf('function nextStepForm(')) +
    source.slice(source.indexOf('function addAccountForm('), source.indexOf('function showConflict(')) + '\nglobalThis.open = addAccountForm;', context);
  context.open(); doc.querySelector('#accountName').value = 'Synthetic reviewed account';
  await doc.querySelector('#dialogForm').onsubmit({ preventDefault() {}, currentTarget: doc.querySelector('#dialogForm') });
  assert.equal(calls.length, 1);
  dialog.close(); context.open();
  assert.equal(doc.querySelector('#accountName').value, 'Synthetic reviewed account');
  assert.equal(doc.querySelector('#accountName').disabled, true);
  assert.match(doc.querySelector('#dialogSubmit').textContent, /Check outcome/i);
  await doc.querySelector('#dialogForm').onsubmit({ preventDefault() {}, currentTarget: doc.querySelector('#dialogForm') });
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(dialog.open, false);
  dom.window.close();
});

for (const [method, values, currentText] of [
 ['nextStepForm', {text:'Synthetic unsent step',next_date:'2026-11-12'}, 'Partner step'],
 ['marketAgentForm', {agent_name:'Synthetic unsent agent',market:'Synthetic unsent city'}, 'Partner agent'],
 ['accountOwnerForm', {owner:'joe'}, 'dell'],
]) test(`${method} preserves an unsent draft across conflict, review and reopen`, async () => {
 const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
 const dom = new JSDOM('<dialog id="formDialog"><p id="dialogContext"></p><h2 id="dialogTitle"></h2><form id="dialogForm"><div id="dialogBody"></div><p id="formError"></p><button id="dialogSubmit"></button></form></dialog>');
 const document = dom.window.document, dialog = document.querySelector('dialog');
 dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; };
 const deal = {id:'synthetic-deal',name:'Synthetic deal',version:1,next_step:'Prior step',next_date:null,market_agent:'Prior agent',market:'Prior city'};
 const selected = {account_client_id:'synthetic-account',account_name:'Synthetic account',base_version:1,account_owner:'joe'};
 const writes = [];
 const send = async args => { writes.push(structuredClone(args)); return {ok:true}; };
 const state = {selfActor:'joe',deals:new Map([[deal.id,deal]]),accounts:[selected],nextStepRequests:new Map(),nextStepInFlight:new Set(),client:{
   getDeal:async()=>({deal:{...deal,version:2,next_step:'Partner step',market_agent:'Partner agent'}}),
   getBoard:async()=>({actor:'joe',accounts:[{...selected,base_version:2,account_owner:'dell'}]}),
   setNextStep:send,setMarketAgent:send,setNationalAccountOwner:send,
 }};
 const context = vm.createContext({document,state,createRetainedCommands,uuidv4:randomUUID,FormData:dom.window.FormData,
   $:(selector,root=document)=>root.querySelector(selector),$$:(selector,root=document)=>[...root.querySelectorAll(selector)],
   esc:String,actorName:String,setTimeout:()=>0,account:()=>state.accounts[0],loadHome:async()=>{},showToast(){},renderBoardOnly(){},confirmLocalWrite:()=>deal});
 vm.runInContext(source.slice(source.indexOf('function appWrite('),source.indexOf('function addTeamDealForm(')) +
   source.slice(source.indexOf('function accountOwnerForm('),source.indexOf('function showConflict(')) + `\nglobalThis.open = () => ${method}('synthetic-deal');`,context);
 const submit = () => document.querySelector('#dialogForm').onsubmit({preventDefault(){},currentTarget:document.querySelector('#dialogForm')});
 context.open();
 for (const [name,value] of Object.entries(values)) document.querySelector(`[name="${name}"]`).value = value;
 await submit();
 assert.equal(writes.length,0);
 assert.match(document.querySelector('#formError').textContent,new RegExp(currentText));
 dialog.close(); context.open();
 for (const [name,value] of Object.entries(values)) assert.equal(document.querySelector(`[name="${name}"]`).value,value);
 await submit(); assert.equal(writes.length,0,'reopening alone does not approve the new version');
 const review = [...document.querySelectorAll('button')].find(node=>node.textContent === 'Review current values');
 assert.ok(review,'the current values require explicit review');
 review.click();
 await submit();
 assert.equal(writes.length,1); assert.equal(writes[0].base_version,2);
 for (const [name,value] of Object.entries(values)) assert.equal(writes[0][name],value);
 dom.window.close();
});

for (const live of [true,false]) test(`agenda start retains its exact request until a complete receipt arrives (${live?'live MCP':'injected client'})`, async () => {
 const source = await readFile(new URL('../js/app.js',import.meta.url),'utf8');
 const {createLiveClient} = await import('../js/live-client.js');
 const reviewModel = await import('../js/deal-review-model.js');
 const requests = []; let renders = 0;
 const receipt = () => requests.length === 1 ? {ok:true} : {ok:true,session_id:'synthetic-review-session'};
 const client = live ? createLiveClient({fetchImpl:async(path,init)=>{
   if(path==='/auth/session') return Response.json({actor:{slug:'joe'},csrf_token:'synthetic-session'});
   requests.push(JSON.parse(init.body).params.arguments);
   return Response.json({result:{content:[{type:'text',text:JSON.stringify(receipt())}]}});
 }}) : {startReview:async request=>{requests.push(structuredClone(request));return receipt();}};
 const state = {selfActor:'joe',workspace:'team',accountId:null,client};
 const context = vm.createContext({state,createRetainedCommands,...reviewModel,
   agendaDeals:()=>[{id:'synthetic-deal'}],$:()=>({hidden:true}),showToast(){},renderAgenda(){renders++;}});
 vm.runInContext(source.slice(source.indexOf('function appWrite('),source.indexOf('function openForm(')) +
   source.slice(source.indexOf('async function startAgenda('),source.indexOf('function renderAgenda('))+'\nglobalThis.start = startAgenda;',context);
 await assert.rejects(context.start(), /receipt|unknown|confirm/i);
 assert.equal(renders,0); assert.equal(state.review,undefined);
 assert.ok(state.commands.pending('agenda:start:team:'));
 await context.start();
 assert.deepEqual(requests[1],requests[0]);
 assert.equal(state.review.sessionId,'synthetic-review-session'); assert.equal(renders,1);
 assert.equal(state.commands.pending('agenda:start:team:'),null);
});
