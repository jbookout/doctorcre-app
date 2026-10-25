import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createLiveClient} from '../js/live-client.js';
const reconciliation=JSON.parse(readFileSync(new URL('../contracts/app-write-reconciliation.v1.json',import.meta.url)));
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
import {createRetainedCommands} from '../js/retained-commands.mjs';
import {classifyCommandOutcome,commandMessage,performCommand,pendingCommand} from '../js/command-feedback.mjs';
const source=readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
function forms({version=1,lost=false}={}){
 let options,reads=0;const writes=[],nodes=new Map();
 const deal={id:'synthetic-deal',name:'Demo replacement',version:1,next_step:'Prior step',next_date:null,market_agent:'Prior agent',market:'Demo city'};
 const account={account_client_id:'synthetic-account',account_name:'Demo account',base_version:1,account_owner:'joe'};
 const state={selfActor:'joe',deals:new Map([[deal.id,deal]]),accounts:[account],nextStepRequests:new Map(),nextStepInFlight:new Set(),boardSync:{requestRefresh(){}}};
 const live=createLiveClient({selfActor:'joe',docContext:false,fetchImpl:async(path,init)=>{
  if(path==='/auth/session')return Response.json({actor:{slug:'joe'},csrf_token:'synthetic-session-a'});
  assert.equal(path,'/mcp');assert.equal(new Headers(init.headers).get('x-carr-csrf'),'synthetic-session-a');
  const {params}=JSON.parse(init.body),request=params.arguments;
  const expected=reconciliation.replacements[params.name].expected;
  assert.ok(Object.hasOwn(request,expected),`pinned producer requires ${expected}`);
  assert.equal(request[expected],1);assert.match(request.idempotency_key,uuid);
  writes.push(structuredClone(request));if(lost){lost=false;throw new Error('timeout after commit');}
  return Response.json({result:{content:[{type:'text',text:JSON.stringify({ok:true,deal_id:deal.id})}]}});
 }});
 const send=method=>request=>live[method](request);
 state.client={getDeal:async()=>{reads++;return {deal:{...deal,version,market_agent:version===1?'Prior agent':'Partner agent'}};},getBoard:async()=>{reads++;return {actor:'joe',accounts:[{...account,base_version:version,account_owner:version===1?'joe':'dell'}]};},setNextStep:send('setNextStep'),setMarketAgent:send('setMarketAgent'),setNationalAccountOwner:send('setNationalAccountOwner')};
 const $=key=>{if(!nodes.has(key))nodes.set(key,{value:'',disabled:false,textContent:''});return nodes.get(key);};
 const context=vm.createContext({state,$,esc:x=>x,openForm:value=>{options=value;},account:()=>state.accounts[0],createRetainedCommands,structuredClone,classifyCommandOutcome,commandMessage,uuidv4:()=>crypto.randomUUID(),loadHome:async()=>{},confirmLocalWrite:()=>deal,renderBoardOnly(){},showToast(){}});
 const helperStart=source.indexOf('function reviewedReplacementVersion(');
 const start=helperStart<0?source.indexOf('function nextStepForm('):helperStart;
 vm.runInContext(source.slice(start,source.indexOf('function addTeamDealForm('))+'\nObject.assign(globalThis,{nextStepForm,marketAgentForm});',context);
 vm.runInContext(source.slice(source.indexOf('function accountOwnerForm('),source.indexOf('function showConflict('))+'\nObject.assign(globalThis,{accountOwnerForm});',context);
 context.appWrite=(op,args,send)=>{state.commands??=createRetainedCommands({scope:()=>state.selfActor});return state.commands.send(op,args,send);};
 return {open:method=>{context[method](deal.id);return options;},writes,get reads(){return reads;}};
}
for(const method of ['nextStepForm','marketAgentForm','accountOwnerForm']){
 const input=()=>new Map([['text','New step'],['next_date','2026-11-01'],['agent_name','New agent'],['market','Demo city'],['owner','dell']]);
 test(`S2 ${method} sends the expected version from a fresh read`,async()=>{
  const h=forms();await h.open(method).onSubmit(input());assert.equal(h.writes.length,1);assert.equal(h.writes[0].base_version,1);assert.equal(h.reads,1);
 });
 test(`S2 ${method} rejects a changed reviewed version before sending`,async()=>{
  const h=forms({version:2});await assert.rejects(h.open(method).onSubmit(input()),/changed|review/i);assert.equal(h.writes.length,0);assert.equal(h.reads,1);
 });
 test(`S2 ${method} never rereads or rebases an uncertain retry`,async()=>{
  const h=forms({lost:true});await assert.rejects(h.open(method).onSubmit(input()));const reads=h.reads;
  await h.open(method).onSubmit(input());assert.equal(h.reads,reads);assert.deepEqual(h.writes[1],h.writes[0]);
 });
}

for(const changed of [false,true])test(`S2 move follow-up ${changed?'refuses a concurrent next step':'uses a freshly read version and retains it on retry'}`,async()=>{
 const raw=readFileSync(new URL('../js/pipeline.js',import.meta.url),'utf8'),writes=[];let reads=0,lost=true;
 const state={panelDeal:null,deals:new Map([['demo',{next_step:'Original step',next_date:null}]]),client:{getDeal:async()=>{reads++;return {deal:{id:'demo',version:3,next_step:changed?'Partner step':'Original step',next_date:null}};},setNextStep:async request=>{writes.push(structuredClone(request));if(lost){lost=false;throw new Error('timeout');}return {ok:true};}},boardSync:{requestRefresh(){}}};
 const operations=new Map(),records=[];
 const context=vm.createContext({state,operations,commandState:{},pendingCommand,performCommand,uuidv4:()=>crypto.randomUUID(),dock:{record:(...args)=>records.push(args)},nextStepKey:deal=>`next-step:${deal}`,FOLLOW_UP_SENDERS:{'set-next-step':args=>state.client.setNextStep(args)},noteText:value=>value||'',syncUpdateForm(){},settleConflictChoice:async()=>{}});
 vm.runInContext(raw.slice(raw.indexOf('async function runFollowUp('),raw.indexOf('async function runMove('))+'\nObject.assign(globalThis,{runFollowUp});',context);
 const step={verb:'set-next-step',args:{deal:'demo',text:'My proposed step',next_date:null},summary:'Next step',reviewed:{next_step:'Original step',next_date:null}};
 await context.runFollowUp('step',step);
 if(changed){assert.equal(writes.length,0);assert.match(JSON.stringify(records),/changed|review/i);return;}
 assert.equal(writes[0].base_version,3);const originalReads=reads;await context.runFollowUp('step',step);
 assert.equal(reads,originalReads);assert.deepEqual(writes[1],writes[0]);
});

test('S2 fixture replacement contracts match producer CAS and receipt replay',async()=>{
 const {createFixtureClient}=await import('../js/fixture-client.js');
 const seed=readFileSync(new URL('../data/board-seed.json',import.meta.url),'utf8');
 const client=await createFixtureClient({seedUrl:`data:application/json;base64,${Buffer.from(seed).toString('base64')}`});
 for(const method of ['setNextStep','setMarketAgent','setNationalAccountOwner']){
  const board=await client.getBoard(),deal=board.deals[0],account=board.accounts[0];
  const args=method==='setNationalAccountOwner'?{account_client_id:account.account_client_id,owner:'joe',base_version:account.base_version}
   :{deal:deal.id,base_version:deal.version,...(method==='setNextStep'?{text:'Synthetic new step',next_date:null}:{agent_name:'Synthetic agent',source:'Synthetic stated',market:'Demo city'})};
  assert.ok(Number.isSafeInteger(args.base_version));
  const request={...args,idempotency_key:`synthetic-${method}`};
  const result=await client[method](request);assert.deepEqual(await client[method](request),result);
  await assert.rejects(client[method]({...args,idempotency_key:`stale-${method}`}),error=>error.payload?.error==='version_conflict');
 }
});
