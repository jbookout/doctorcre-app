import { authGeneration, authReadable } from '../js/progress-auth.js';
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { observeDocRead, selectDocRecord, setDocFilters } from "../js/doc-context.js";
import { createDocContext } from "../js/doc-context-model.js";
import { createLiveClient } from "../js/live-client.js";
import { createSystemWorkClient } from "../js/system-work-client.js";
import { mountPrefs } from "../js/shell.js";
import { statusHeadline } from "../js/status-model.js";
import { classifyPriority } from "../js/visual-system.js";
import { createCommandState, performCommand, classifyCommandOutcome } from "../js/command-feedback.mjs";
import { JSDOM } from "jsdom";

const source = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const noop = () => {};
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
// Execute the real page handlers against isolated transports and DOMs. No
// production module is rewritten or reimplemented by the harness.
function handlers(path, start, end, globals = {}, expose = []) {
  const text = source(path); const offset = text.indexOf(start);
  assert.ok(offset >= 0, start);
  const finish = end ? text.indexOf(end, offset + start.length) : text.length;
  assert.ok(finish > offset, end);
  const context = vm.createContext({observeDocRead,selectDocRecord,setDocFilters,pageDocContext:null,authGeneration,authReadable, console, Date, Map, Set, Promise, URL, URLSearchParams, setTimeout, clearTimeout, ...globals });
  vm.runInContext(text.slice(offset, finish).replace(/export /g, "") + "\nObject.assign(globalThis, {" + expose.join(",") + "});", context);
  return context;
}
const rpc = payload => new Response(JSON.stringify({result:{content:[{text:JSON.stringify(payload)}]}}));
const elements = () => { const rows = new Map(); return key => { if(!rows.has(key)) rows.set(key, {value:"",textContent:"",hidden:false,disabled:false,listeners:{},addEventListener(type,listener){this.listeners[type]=listener;},setAttribute:noop}); return rows.get(key); }; };

for (const terminal of ["review_ready", "failed"]) test(`PR111 #1: overlapping slow status reads apply ${terminal}`, async () => {
  const reply=deferred(); let reads=0, stops=0;
  const state={postCall:{session:"A",status:"waiting_for_transcript"}};
  const h=handlers("js/call-mode.js","  async function refreshPostCall(","  function startPolling(",{state,deps:{postCallClient:{getStatus:()=>{reads++;return reply.promise;}}},stopPolling:()=>stops++,renderPostCall:noop,publishOrRecord:async()=>{},toast:noop},["refreshPostCall"]);
  const first=h.refreshPostCall(),second=h.refreshPostCall();
  reply.resolve({status:terminal});await Promise.all([first,second]);
  assert.equal(state.postCall.status,terminal);assert.equal(reads,1);assert.equal(stops,1);
});

for (const fails of [false,true]) test(`PR111 #2: late context ${fails ? "failure" : "success"} leaves the newer call alone`, async () => {
  const read=deferred();const state={postCall:{session:"A",weekly:true},pollTimer:"B-timer"};let stops=0,publishes=0;
  const h=handlers("js/call-mode.js","  async function publishWeeklyCallContext(","  // ----------------------------------------------------------- report poll",{state,readCallContextIndex:()=>read.promise,deps:{client:()=>({}),agendaDeals:()=>[],scope:()=>({}),postCallClient:{publishCallContext:async()=>{publishes++;}}},now:()=>0,renderPostCall:noop,stopPolling:()=>stops++},["publishOrRecord"]);
  const pending=h.publishOrRecord("A");state.postCall={session:"B",status:"waiting_for_transcript"};
  if(fails)read.reject(new Error("old failure"));else read.resolve([]);await pending;
  assert.equal(state.postCall.session,"B");assert.equal(state.postCall.status,"waiting_for_transcript");assert.equal(stops,0);assert.equal(publishes,0);
});

test("Dot 4: blocked storage does not abort preference mounting", () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "localStorage"); const doc = globalThis.document;
  Object.defineProperty(globalThis,"localStorage",{configurable:true,get(){throw new DOMException("blocked","SecurityError");}});
  globalThis.document = {documentElement:{setAttribute:noop},querySelectorAll:()=>[],getElementById:()=>null};
  try { assert.doesNotThrow(() => mountPrefs()); }
  finally { if(old) Object.defineProperty(globalThis,"localStorage",old); else delete globalThis.localStorage; globalThis.document=doc; }
});

test("Dot 6: deal dates use calendar-day offsets", () => {
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : ["2026-09-30T08:00:00"])); } }
  const h=handlers("js/app.js","function daysFromNow(","function relative(",{Date:Clock,today:()=>new Clock("2026-09-30T00:00:00")},["dateLabel","daysFromNow"]);
  assert.equal(h.dateLabel("2026-09-29"),"Sep 29 · 1d overdue");
  assert.equal(h.dateLabel("2026-09-30"),"Today");
  assert.equal(h.dateLabel("2026-10-01"),"Tomorrow");
});

test("Dot 7: double Reviewed advances only one agenda item", async () => {
  const pending=deferred(); const calls=[];
  const review={deals:[{id:"A"},{id:"B"},{id:"C"}],index:0,reviewed:0,skipped:0,sessionId:"review"};
  const h=handlers("js/app.js","async function advanceAgenda(","async function finishAgenda(",{state:{review,client:{reviewDeal:args=>{calls.push(args);return pending.promise;}}},uuidv4:()=>"key",renderAgenda:noop},["advanceAgenda"]);
  const first=h.advanceAgenda("reviewed"),second=h.advanceAgenda("reviewed"); pending.resolve({ok:true}); await Promise.all([first,second]);
  assert.equal(calls.length,1); assert.equal(review.index,1); assert.equal(review.reviewed,1);
});

test("Dot 23: historical next-step notes cannot replace the current action", async () => {
  const client=createLiveClient({fetchImpl:async()=>rpc({deal_id:"demo",next_step:"Call banker",next_action:"Call banker",thread:[{kind:"next_step",text:"Call lawyer"}],events:[]})});
  const page=await client.getDeal("demo"); assert.equal(page.deal.next_step,"Call banker");
  assert.equal(page.thread[0]?.text,"Call lawyer");assert.equal(page.thread[0]?.kind,"archived_step");
});

test("Dot 24: producer city is displayed as the deal market", async () => {
  const client=createLiveClient({fetchImpl:async()=>rpc({deal_id:"demo",city:"Demo City",thread:[],events:[]})});
  assert.equal((await client.getDeal("demo")).deal.market,"Demo City");
});

test("Dot 21: closing outcome uses the producer base_version", async () => {
  const writes=[];
  const client=createLiveClient({fetchImpl:async(_path,init)=>{const req=JSON.parse(init.body).params; if(req.name==="get-deal-room")return rpc({deal_id:"demo",base_version:7,thread:[],events:[]});writes.push(req); return rpc({ok:true});}});
  const h=handlers("js/pipeline.js","async function runOutcomeWrite(","/** One follow-up",{state:{client,boardSync:{requestRefresh:noop}},dock:{record:noop},operations:new Map(),commandState:createCommandState(),performCommand,uuidv4:()=>"00000000-0000-4000-8000-000000000001"},["runOutcomeWrite"]);
  await h.runOutcomeWrite("close",{verb:"update-deal",summary:"Close",args:{deal:"demo",outcome:"won",closed_on:"2026-09-30"}},{deal:"demo",name:"Demo"});
  assert.equal(writes.length,1);assert.equal(writes[0].arguments.base_version,7);assert.equal(writes[0].arguments.outcome,"won");
});

test("Dot 22: creating a deal assigns its lead with a fresh version", async () => {
  const calls=[];
  const client=createLiveClient({selfActor:"joe",fetchImpl:async(_path,init)=>{
    const req=JSON.parse(init.body).params; calls.push(req);
    if(req.name==="new-deal")return rpc({deal_id:"demo"});
    if(req.name==="get-deal-room")return rpc({deal_id:"demo",base_version:2,thread:[],events:[]});
    if(req.name==="set-lead")assert.equal(req.arguments.base_version,2,"set-lead requires the fresh base_version");
    return rpc({ok:true});
  }});
  await client.createDeal({client:"C-demo",name:"Demo deal",idempotency_key:"00000000-0000-4000-8000-000000000001"});
  assert.equal(calls.at(-1).name,"set-lead");
});

test("PR111 #4: deal recovery retains creation receipt and exact lead request", async () => {
  const calls=[];let failRead=true,failLead=true,version=2;
  const client=createLiveClient({selfActor:"joe",fetchImpl:async(_path,init)=>{
    const req=JSON.parse(init.body).params;calls.push(req);
    if(req.name==="new-deal")return rpc({deal_id:"demo"});
    if(req.name==="get-deal-room") {if(failRead){failRead=false;throw new Error("read lost");}return rpc({base_version:version});}
    if(failLead){failLead=false;throw new Error("lead committed, receipt lost");}return rpc({ok:true});
  }});
  const args={client:"C-demo",name:"Demo",idempotency_key:"key-one"};
  await assert.rejects(client.createDeal(args));await assert.rejects(client.createDeal(args));version=9;await client.createDeal(args);
  assert.equal(calls.filter(c=>c.name==="new-deal").length,1);
  const lead=calls.filter(c=>c.name==="set-lead");assert.equal(lead.length,2);assert.deepEqual(lead[0].arguments,lead[1].arguments);assert.equal(lead[1].arguments.base_version,2);
});

test("PR111 #4: unchanged creation form retry keeps its outer key", async () => {
  let form;const calls=[];
  const h=handlers("js/app.js","function addTeamDealForm()","function addAccountForm()",{openForm:value=>{form=value;},phaseOptions:()=>"",state:{client:{createDeal:async args=>{calls.push(args);if(calls.length===1)throw new Error("lost");}}},uuidv4:(()=>{let n=0;return()=>`key-${++n}`;})(),loadHome:async()=>{},showToast:noop},["addTeamDealForm"]);
  h.addTeamDealForm();const data=new Map([["client","C-demo"],["name","Demo"]]);await assert.rejects(form.onSubmit(data));await form.onSubmit(data);
  assert.equal(calls[0].idempotency_key,calls[1].idempotency_key);
});

test("PR111 #4: malformed creation receipt replays creation with the same key",async()=>{
  const calls=[];let creates=0;
  const client=createLiveClient({selfActor:"joe",fetchImpl:async(_path,init)=>{const req=JSON.parse(init.body).params;calls.push(req);return rpc(req.name==="new-deal" ? (++creates===1 ? {} : {deal_id:"demo"}) : req.name==="get-deal-room" ? {base_version:2} : {ok:true});}});
  const args={client:"C-demo",name:"Demo",idempotency_key:"same-key"};await assert.rejects(client.createDeal(args));await client.createDeal(args);
  assert.equal(creates,2);assert.equal(calls[0].arguments.idempotency_key,calls[1].arguments.idempotency_key);
});

test("PR111 #4: reopened creation form recovers the retained intent",async()=>{
  let form;const calls=[];const state={client:{createDeal:async args=>{calls.push(args);if(calls.length===1)throw new Error("lost");}}};
  const h=handlers("js/app.js","function addTeamDealForm()","function addAccountForm()",{state,openForm:value=>{form=value;},phaseOptions:()=>"",uuidv4:()=>"key",esc:value=>String(value??""),loadHome:async()=>{},showToast:noop,$:elements()},["addTeamDealForm"]);
  h.addTeamDealForm();await assert.rejects(form.onSubmit(new Map([["client","C-demo"],["name","Demo record"]])));
  h.addTeamDealForm();assert.equal(form.submit,"Check creation outcome");assert.match(form.body,/Demo record/);await form.onSubmit(new Map());assert.deepEqual(calls[1],calls[0]);
});

for (const refusal of ["not_a_client", "subject_not_found", "needs_disambiguation"])
for (const reopen of [false,true]) test(`PR111 R1: ${refusal} permits corrected input${reopen ? " after reopen" : ""}`, async () => {
  const calls=[];let form,keys=0;
  const client=createLiveClient({selfActor:"joe",fetchImpl:async(_path,init)=>{
    const req=JSON.parse(init.body).params;calls.push(req);
    if(req.name==="new-deal" && req.arguments.client==="invalid-client") return new Response(JSON.stringify({result:{isError:true,content:[{text:JSON.stringify({error:refusal})}]}}));
    return rpc(req.name==="new-deal" ? {deal_id:"demo"} : req.name==="get-deal-room" ? {base_version:2} : {ok:true});
  }});
  const state={client};
  const h=handlers("js/app.js","function addTeamDealForm()","function addAccountForm()",{state,openForm:value=>{form=value;},phaseOptions:()=>"",uuidv4:()=>`key-${++keys}`,esc:value=>String(value??""),loadHome:async()=>{},showToast:noop},["addTeamDealForm"]);
  h.addTeamDealForm();await assert.rejects(form.onSubmit(new Map([["client","invalid-client"],["name","Demo"]])));
  assert.equal(state.pendingDealCreation,null);
  if(reopen){h.addTeamDealForm();assert.equal(form.submit,"Create work record");}
  await form.onSubmit(new Map([["client","C-demo"],["name","Demo"]]));
  const creates=calls.filter(req=>req.name==="new-deal");assert.equal(creates.length,2);
  assert.equal(creates[1].arguments.client,"C-demo");assert.notEqual(creates[0].arguments.idempotency_key,creates[1].arguments.idempotency_key);
  assert.equal(calls.filter(req=>req.name==="set-lead").length,1);
});

for (const errorCode of ["unhandled_verb_failure", "unknown_creation_failure"]) test(`PR111 R3: ${errorCode} after commit recovers one creation and its lead on reopen`, async () => {
  const calls=[];let form,keys=0,committedKey=null,created=0,assigned=0;
  const client=createLiveClient({selfActor:"joe",fetchImpl:async(_path,init)=>{
    const req=JSON.parse(init.body).params;calls.push(req);
    if(req.name==="new-deal") {
      if(!committedKey) {
        committedKey=req.arguments.idempotency_key;created++;
        return new Response(JSON.stringify({result:{isError:true,content:[{type:"text",text:JSON.stringify({error:errorCode,verb:"new-deal",cause:"synthetic commit acknowledgment lost"})}]}}));
      }
      if(req.arguments.idempotency_key!==committedKey) return new Response(JSON.stringify({result:{isError:true,content:[{text:JSON.stringify({error:"deal_name_exists"})}]}}));
      return rpc({ok:true,deal_id:"demo"});
    }
    if(req.name==="get-deal-room") return rpc({deal_id:"demo",base_version:2});
    if(req.name==="set-lead") {assigned++;return rpc({ok:true});}
    throw new Error(`Unexpected verb ${req.name}`);
  }});
  const state={client};
  const h=handlers("js/app.js","function addTeamDealForm()","function addAccountForm()",{state,openForm:value=>{form=value;},phaseOptions:()=>"",uuidv4:()=>`key-${++keys}`,esc:value=>String(value??""),loadHome:async()=>{},showToast:noop},["addTeamDealForm"]);
  h.addTeamDealForm();const data=new Map([["client","C-demo"],["name","Demo record"]]);
  await assert.rejects(form.onSubmit(data));
  assert.ok(state.pendingDealCreation,"an internal or unknown failure cannot prove rollback");
  h.addTeamDealForm();assert.equal(form.submit,"Check creation outcome");
  await form.onSubmit(new Map());
  const creates=calls.filter(req=>req.name==="new-deal");
  assert.deepEqual(creates[1].arguments,creates[0].arguments);
  assert.equal(created,1);assert.equal(assigned,1);assert.equal(state.pendingDealCreation,null);
});

for (const stage of ["uncertain creation","lead assignment"]) test(`PR111 R1: ${stage} refusal retains the creation intent`, async () => {
  const calls=[];let form;
  const refused=()=>new Response(JSON.stringify({result:{isError:true,content:[{text:JSON.stringify({error:"conflict"})}]}}));
  const client=createLiveClient({selfActor:"joe",fetchImpl:async(_path,init)=>{
    const req=JSON.parse(init.body).params;calls.push(req);
    if(stage==="uncertain creation" && req.name==="new-deal") {if(calls.length===1)throw new Error("reply lost");return refused();}
    return req.name==="new-deal" ? rpc({deal_id:"demo"}) : req.name==="get-deal-room" ? rpc({base_version:2}) : refused();
  }});
  const state={client};const h=handlers("js/app.js","function addTeamDealForm()","function addAccountForm()",{state,openForm:value=>{form=value;},phaseOptions:()=>"",uuidv4:()=>"same-key",loadHome:async()=>{},showToast:noop},["addTeamDealForm"]);
  h.addTeamDealForm();const data=new Map([["client","C-demo"],["name","Demo"]]);
  await assert.rejects(form.onSubmit(data));const pending=state.pendingDealCreation;
  await assert.rejects(form.onSubmit(data));assert.equal(state.pendingDealCreation,pending);
  const writes=calls.filter(req=>req.name===(stage==="uncertain creation" ? "new-deal" : "set-lead"));
  assert.deepEqual(writes[1].arguments,writes[0].arguments);
});

test("Dot 25: a task due today is not overdue at 8 AM Central", () => {
  const result=classifyPriority({due:"2026-09-30"},"2026-09-30T08:00:00-05:00");
  assert.equal(result.priority,"deadline"); assert.equal(result.reason,"due in 0 days");
});

function tourHarness() {
  const $=elements(); const replies=new Map(); const state={tour:{id:"A"},feedbackSeq:0,hydrationSeq:0,cheatDirty:false};
  const h=handlers("tours/app.js","  async function loadTour(","  function moveStop(",{state,$,restoredTourId:"",navigationBusy:false,composer:null,createPending:null,tourLoadSeq:0,status:noop,renderComposer:noop,renderCreate:noop,validateDetail:noop,routeSnapshot:()=>"snapshot",initComposer:noop,renderTour:noop,renderSelection:noop,loadSelectionCart:async()=>{},loadProjectionPreview:async()=>{},loadFeedback:async()=>{},request:path=>replies.get(new URL(path,"https://example.test").searchParams.get("tour_id"))},["loadTour"]);
  return {h,state,$,replies};
}
test("Dot 1: current main serializes Tour navigation instead of applying out-of-order loads", async () => {
  const {h,state,replies}=tourHarness();const a=deferred(),b=deferred(); replies.set("A",a.promise);replies.set("B",b.promise);
  const first=h.loadTour("A"),second=h.loadTour("B");b.resolve({id:"B"});a.resolve({id:"A"});await Promise.all([first,second]);
  assert.equal(h.tourLoadSeq,1,"PR109 blocks a second navigation while loading");assert.equal(state.tour.id,"A");
});
test("Dot 2: switching Tours clears the prior confidential link", async () => {
  const {h,state,$,replies}=tourHarness();state.rawShareToken="secret-synthetic";state.shareGrantId="grant-A";$("#share-url").value="https://example.test/share#token=synthetic";$("#share-link").hidden=false;replies.set("B",Promise.resolve({id:"B"}));
  await h.loadTour("B");assert.equal($("#share-url").value,"");assert.equal($("#share-link").hidden,true);assert.equal(state.rawShareToken,"");
});

test("Dot 3: sheet save preserves typing made while saving", async () => {
  const $=elements();$("#cheat-content").value="First edit";const saved=deferred();
  const state={tour:{id:"A",cheat_sheet:{revision_number:1}},cheatDirty:true};
  const h=handlers("tours/app.js","  async function saveSheet(","  async function issueShare(",{state,$,uuid:()=>"key",post:()=>saved.promise,status:noop,loadTour:async()=>{if(!state.cheatDirty)$("#cheat-content").value="First edit";}},["saveSheet"]);
  const pending=h.saveSheet();$("#cheat-content").value="Newer unsaved edit";state.cheatDirty=true;saved.resolve({ok:true});await pending;
  assert.equal($("#cheat-content").value,"Newer unsaved edit");assert.equal(state.cheatDirty,true);
});

test("Dot 5: report retry after a lost response keeps one idempotency key", async () => {
  const requests=[];let keys=0;
  const client=createSystemWorkClient({uuid:()=>`key-${++keys}`,fetchImpl:async(path,init)=>{
    if(path.endsWith("session"))return new Response(JSON.stringify({csrf_token:"synthetic"}));
    requests.push(JSON.parse(init.body));if(requests.length===1)throw new Error("response lost");return new Response(JSON.stringify({data:{human_ref:"WR-1"}}));
  }});
  await client.bootstrap(); const report={situation:"Demo problem",title:"Demo",desired_outcome:"Demo resolution",acceptance_criteria:[]};
  await assert.rejects(client.report(report));await client.report({...report});
  assert.equal(requests[0].idempotency_key,requests[1].idempotency_key);
});

test("PR111 #6: proxy 408 after commit preserves the report key", async () => {
  const requests=[];let keys=0;
  const client=createSystemWorkClient({uuid:()=>`key-${++keys}`,fetchImpl:async(path,init)=>{
    if(path.endsWith("session"))return new Response(JSON.stringify({csrf_token:"synthetic"}));
    requests.push(JSON.parse(init.body));return requests.length===1 ? new Response("",{status:408}) : new Response(JSON.stringify({data:{human_ref:"WR-1"}}));
  }});
  await client.bootstrap();const report={situation:"Demo",title:"Demo",desired_outcome:"Demo",acceptance_criteria:[]};
  await assert.rejects(client.report(report));await client.report(report);assert.equal(requests[0].idempotency_key,requests[1].idempotency_key);
});

test("PR111 #7: cancel/reopen offers the retained report for same-request recovery", async () => {
  const requests=[];let options;
  const client=createSystemWorkClient({uuid:()=>"report-key",fetchImpl:async(path,init)=>{
    if(path.endsWith("session"))return new Response(JSON.stringify({csrf_token:"synthetic"}));
    requests.push(JSON.parse(init.body));if(requests.length===1)throw new Error("lost response");return new Response(JSON.stringify({data:{human_ref:"WR-1"}}));
  }});
  await client.bootstrap();const h=handlers("js/system-work-app.js","function reportForm()","function triageForm()",{client,openForm:value=>{options=value;},field:(_label,body)=>body,esc:value=>String(value).replaceAll('"','&quot;'),refresh:async()=>{}},["reportForm"]);
  h.reportForm();const data=new Map([["situation","Demo concern"],["title","Demo title"],["desired_outcome","Demo result"],["criteria","One measure"]]);await assert.rejects(options.onSubmit(data));
  h.reportForm();assert.equal(options.submit,"Check report outcome");assert.match(options.body,/Demo concern/);assert.match(options.body,/Demo title/);
  await options.onSubmit(new Map());assert.deepEqual(requests[1],requests[0]);assert.equal(client.pendingReport,null);
});

test("Dot 10: an answered app release with pending CARR reads cannot claim success", () => {
  const model=statusHeadline({release:{state:"read"},reads:{},snapshot:null});
  assert.notEqual(model.scenario,1);assert.doesNotMatch(model.headline,/record layer answered/);assert.notEqual(model.action,"Nothing to do.");
});

test("Dot 11: a blocked second rename cannot replace the retained recovery intent", async () => {
  const calls=[];const operations=new Map();
  const h=handlers("js/conversations.js","async function dispatch(","function rename",{performCommand,commandState:createCommandState(),uuidv4:()=>"00000000-0000-4000-8000-000000000001",operations,dock:{record:noop},announce:noop,load:async()=>{},createOperationKey:()=>"create",open:noop},["dispatch"]);
  const send=async args=>{calls.push(args);if(calls.length===1)throw new Error("lost response");return {ok:true};};
  await h.dispatch("rename:A",{name:"First"},"Rename",send);await h.dispatch("rename:A",{name:"Second"},"Rename",send);
  const saved=operations.get("rename:A");await h.dispatch("rename:A",saved.args,saved.summary,saved.send);
  assert.equal(calls.length,2);assert.equal(calls[1].name,"First");assert.equal(calls[0].idempotency_key,calls[1].idempotency_key);
});

function searchHarness() {
  const view={query:"Alpha",kinds:[],sequence:0};const replies=new Map();
  const globals={view,client:{find:args=>replies.get(args.q),findAndCatchUp:async()=>({})},queryIsSendable:q=>q.trim().length>0,render:noop,pushAddress:noop,acceptsSearchResponse:(a,b)=>a===b,validSearchPayload:()=>true,validCatchUpPayload:()=>true,buildFindArguments:q=>({q}),buildFindAndCatchUpArguments:q=>({q}),FIND_CATCH_UP_LIMIT_DEFAULT:10,classifySearchFailure:()=>"unknown",refusalDetail:()=>({}),parseSearchAddress:query=>({query:new URLSearchParams(query).get("q")||"",kinds:[],present:true}),location:{search:"?q=Alpha"},history:{pushState:noop,replaceState:noop},searchAddress:()=>""};
  const h=handlers("js/search.js","async function read(","/* ------------------------------------------------------------------ the wiring",globals,["read","restoreFromAddress"]);
  return {h,view,replies};
}
test("Dot 12: Back restores results for the restored query", async () => {
  const {h,view,replies}=searchHarness();replies.set("Alpha",Promise.resolve({label:"Alpha results"}));replies.set("Beta",Promise.resolve({label:"Beta results"}));
  await h.read();view.query="Beta";await h.read();h.restoreFromAddress();await tick();
  assert.equal(view.query,"Alpha");assert.equal(view.payload.label,"Alpha results");
});

test("Dot 13: clearing Search invalidates its pending query", async () => {
  const {h,view,replies}=searchHarness();const answer=deferred();replies.set("Alpha",answer.promise);
  const pending=h.read();view.query="";await h.read();answer.resolve({label:"Alpha results"});await pending;
  assert.equal(view.status,"idle");assert.equal(view.payload,null);
});

test("Dot 14: Updates follows the event cursor to current activity", async () => {
  const view={sequence:1};const cursors=[];
  const h=handlers("js/notifications.js","async function takeActivity(","async function load(",{view,render:noop,client:{getChanges:async cursor=>{cursors.push(cursor);return cursor === "201" ? {cursor:"201",events:[]} : cursor ? {cursor:"201",events:[{seq:201,verb:"new"}]} : {cursor:"200",events:Array.from({length:200},(_,i)=>({seq:i+1,verb:"old"}))};}}},["takeActivity"]);
  await h.takeActivity();assert.equal(view.activity.payload.events.at(-1).seq,201);assert.equal(cursors.length,3);
});

test("Dot 15: an old call status cannot replace the new session review pack", async () => {
  const old=deferred();const state={postCall:{session:"A"}};let stops=0;
  const h=handlers("js/call-mode.js","  async function refreshPostCall(","  function startPolling(",{state,deps:{postCallClient:{getStatus:()=>old.promise}},stopPolling:()=>stops++,renderPostCall:noop,publishOrRecord:async()=>{},toast:noop},["refreshPostCall"]);
  const pending=h.refreshPostCall();state.postCall={session:"B",status:"waiting",report:null};old.resolve({status:"review_ready",report:{session:"A"}});await pending;
  assert.equal(state.postCall.session,"B");assert.equal(state.postCall.report,null);assert.equal(stops,0);
});

test("Dot 16: Calendar uses an admitted CARR authentication gate", async () => {
  const {handleDoctorcreRequest}=await import("../src/worker.js");let path;
  const env={APP_ENV:"staging",GIT_SHA:"1".repeat(40),CARR:{fetch:async request=>{path=new URL(request.url).pathname;return path==="/business" ? new Response("signed in") : new Response("OAuth fallback",{status:404});}},ASSETS:{fetch:async request=>new Response(new URL(request.url).pathname)}};
  const res=await handleDoctorcreRequest(new Request("https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev/calendar"),env);
  assert.equal(res.status,200);assert.equal(await res.text(),"/calendar.html");assert.equal(path,"/business");
});

test("Dot 17: retrying an unanswered room message replays its key", async () => {
  const {composerRequest,composerDraftAfterAttempt}=await import("../js/model-room-model.js");const calls=[];let keys=0;
  const view={composer:{text:"Demo message"},composerSend:{state:"idle"}};
  const h=handlers("js/model-room.js","async function submitComposer(","/* ------------------------------------------------- V5-UX-C13c",{view,composerRequest,composerDraftAfterAttempt,classifyCommandOutcome,client:{addRoomTurn:async args=>{calls.push(args);if(calls.length===1)throw new Error("response lost");return {seq:9};}},uuidv4:()=>`key-${++keys}`,renderComposer:noop,$:elements(),announce:noop},["submitComposer"]);
  await h.submitComposer();const message=view.composerSend.message;await h.submitComposer();
  assert.doesNotMatch(message,/Not sent/);
  assert.equal(calls.length,2);assert.equal(calls[0].idempotency_key,calls[1].idempotency_key);
});

for(const receipt of [null,{}, {seq:"nine"}, {seq:0}]) test(`PR111 #11: composer retains its request after invalid acknowledgment ${JSON.stringify(receipt)}`,async()=>{
  const {composerRequest,composerDraftAfterAttempt}=await import("../js/model-room-model.js");const calls=[];const view={composer:{text:"Demo message"},composerSend:{state:"idle"}};let keys=0;
  const h=handlers("js/model-room.js","async function submitComposer(","/* ------------------------------------------------- V5-UX-C13c",{view,composerRequest,composerDraftAfterAttempt,classifyCommandOutcome,client:{addRoomTurn:async args=>{calls.push(args);return calls.length===1 ? receipt : {seq:9};}},uuidv4:()=>`key-${++keys}`,renderComposer:noop,$:elements(),announce:noop},["submitComposer"]);
  await h.submitComposer();assert.equal(view.composerSend.state,"unknown");assert.equal(view.composer.text,"Demo message");assert.ok(view.composerPending);
  await h.submitComposer();assert.deepEqual(calls[0],calls[1]);assert.equal(view.composerSend.state,"sent");assert.equal(view.composer.text,"");
});

test("PR111 #11: composer accepts the producer's decimal-string sequence receipt",async()=>{
  const {composerRequest,composerDraftAfterAttempt}=await import("../js/model-room-model.js");const view={composer:{text:"Demo message"},composerSend:{state:"idle"}};
  const h=handlers("js/model-room.js","async function submitComposer(","/* ------------------------------------------------- V5-UX-C13c",{view,composerRequest,composerDraftAfterAttempt,classifyCommandOutcome,client:{addRoomTurn:async()=>({ok:true,seq:"9"})},uuidv4:()=>"key",renderComposer:noop,$:elements(),announce:noop},["submitComposer"]);
  await h.submitComposer();assert.equal(view.composerSend.state,"sent");assert.equal(view.composer.text,"");
});

test("Dot 18: a late answer cannot clear another Work Requests draft", async () => {
  const {answerWorkRequestRequest,answerDraftAfterAttempt,workRequestCardRequest}=await import("../js/model-room-model.js");const pending=deferred();const announcements=[];
  const view={historyWorkItemId:"WR-1",answer:{answerText:"First answer",evidenceRef:"safe:test",scopeConfirmed:true},answerSend:{state:"idle"}};
  const h=handlers("js/model-room.js","async function submitAnswer(","function render()",{view,currentAnswerBaseVersion:()=>2,answerWorkRequestRequest,answerDraftAfterAttempt,workRequestCardRequest,client:{answerWorkRequestForJoe:()=>pending.promise,workRequestCard:async()=>({}),currentWorkRequests:async()=>({})},uuidv4:()=>"key",renderAnswer:noop,announce:message=>announcements.push(message),take:async()=>{},refuseWorkRequestCard:noop,validCurrentWorkRequestsPayload:()=>true},["submitAnswer"]);
  const sending=h.submitAnswer();view.historyWorkItemId="WR-2";view.answer={answerText:"Second draft",evidenceRef:"",scopeConfirmed:false};view.answerSend={state:"idle"};pending.resolve({state:"triaged"});await sending;
  assert.equal(view.answer.answerText,"Second draft");assert.ok(!announcements.some(text=>text.includes("WR-2")));
});

test("PR111 #3: successful answer preserves newer edits in the same draft", async () => {
  const {answerWorkRequestRequest,answerDraftAfterAttempt,workRequestCardRequest}=await import("../js/model-room-model.js");const pending=deferred();
  const view={historyWorkItemId:"WR-1",answer:{answerText:"First answer",evidenceRef:"safe:first",scopeConfirmed:true},answerSend:{state:"idle"}};
  const h=handlers("js/model-room.js","async function submitAnswer(","function render()",{view,currentAnswerBaseVersion:()=>2,answerWorkRequestRequest,answerDraftAfterAttempt,workRequestCardRequest,client:{answerWorkRequestForJoe:()=>pending.promise},uuidv4:()=>"key",renderAnswer:noop,announce:noop,take:async()=>{},refuseWorkRequestCard:noop,validCurrentWorkRequestsPayload:()=>true},["submitAnswer"]);
  const sending=h.submitAnswer();view.answer.answerText="New answer";view.answer.evidenceRef="safe:new";pending.resolve({state:"triaged"});await sending;
  assert.equal(view.answer.answerText,"New answer");assert.equal(view.answer.evidenceRef,"safe:new");assert.equal(view.answerSend.state,"sent");
});

function roomHarness(total=6000) {
  const state={cursor:0,latestSeqHint:0,turns:[],byMsgId:new Map(),oldestSeq:null,following:true,pending:new Map(),filters:{},viewer:"joe",missed:0};const reads=[];let displayed=[];
  const globals={state,scope:{},scopedTurn:()=>true,onRead:noop,PAGE_SIZE:60,DOM_TURN_CAP:300,POLL_BACKOFF_CEILING_MS:60000,POLL_VISIBLE_MS:4000,$:(()=>{const get=elements();get("roomHealth").dataset={};return get;})(),PARTNER_LABEL:{},seqOf:t=>Number(t.seq),fetchTurns:async(from,limit)=>{reads.push([from,limit]);const turns=Array.from({length:Math.min(limit,Math.max(0,total-from))},(_,i)=>({seq:from+i+1,msg_id:`turn-${from+i+1}`}));return {turns,latest_seq:turns.at(-1)?.seq||from,more:turns.length===limit};},deriveModel:()=>({jobPassports:{enabled:true}}),renderStage:noop,renderSeatChips:noop,renderDesks:noop,renderWire:noop,renderAssignments:noop,renderSessions:noop,renderJobPassport:noop,renderHealth:noop,animateArrivals:noop,banner:noop,setState:noop,document:{hidden:false},setTimeout:()=>0,clearTimeout:noop,turnPasses:()=>true,reconcile:(_root,items)=>{displayed=items.filter(i=>i.kind==="turn").map(i=>i.turn.seq);},scrollToBottom:noop};
  const h=handlers("js/room.js","  function absorb(","  /* ------------------------------------------------------------- wiring up",globals,["poll","loadEarlier","absorb"]);
  const wire=handlers("js/room.js","  function renderWire(","  function turnNode(",globals,["renderWire"]);
  return {h,wire,state,reads,displayed:()=>displayed};
}
test("Dot 19: first room poll catches up immediately to the current window", async () => {
  const {h,state}=roomHarness();await h.poll();assert.equal(state.turns.at(-1).seq,6000);assert.ok(state.turns[0].seq>5700);
});

test("Dot 20: Load earlier moves the visible history beyond the display cap", async () => {
  const {h,wire,state,displayed}=roomHarness(600);state.cursor=600;state.turns=Array.from({length:300},(_,i)=>({seq:301+i,msg_id:`turn-${301+i}`}));state.oldestSeq=301;state.byMsgId=new Map(state.turns.map(t=>[t.msg_id,t]));
  await h.loadEarlier();wire.renderWire(false);assert.ok(displayed()[0]<301);assert.equal(displayed().length,300);
});

test("PR111 #8: earlier history traverses sparse global room sequences", async () => {
  const {h,state}=roomHarness();state.turns=[{seq:1000,msg_id:"last"}];state.oldestSeq=1000;
  h.fetchTurns=async(from,limit)=>{const turns=[{seq:1,msg_id:"first"},{seq:1000,msg_id:"last"}].filter(t=>t.seq>from).slice(0,limit);return {turns,latest_seq:turns.at(-1)?.seq||from,more:turns.length===limit};};
  await h.loadEarlier();assert.equal(state.historyTurns[0].seq,1);assert.equal(state.historyTurns.at(-1).seq,1000);
});

for(const start of [1,301]) test(`PR111 #9: history stays contiguous with buffered turns beginning at ${start}`,async()=>{
  const {h,wire,state,displayed}=roomHarness(900);state.cursor=start+599;state.turns=Array.from({length:600},(_,i)=>({seq:start+i,msg_id:`turn-${start+i}`}));state.oldestSeq=start;
  wire.renderWire(false);assert.equal(displayed()[0],start+300);
  await h.loadEarlier();wire.renderWire(false);
  assert.deepEqual(Array.from(displayed()),Array.from({length:300},(_,i)=>start+240+i));
});

for(const fails of [false,true]) test(`PR111 #10: delayed history ${fails ? "failure" : "success"} respects Resume live`,async()=>{
  const {h,state}=roomHarness();const reply=deferred();state.historyTurns=[{seq:241,msg_id:"old"}];state.following=false;state.turns=[{seq:600,msg_id:"live"}];h.fetchTurns=()=>reply.promise;
  const resume=handlers("js/room.js",'  $("wireResume").addEventListener', '  $("composerInput").addEventListener',{state,$:h.$,render:noop,scrollToBottom:noop},[]);
  const pending=h.loadEarlier();h.$("wireResume").listeners.click();
  if(fails)reply.reject(new Error("old history failure"));else reply.resolve({turns:[{seq:181,msg_id:"earlier"}],latest_seq:181,more:false});
  await pending;assert.equal(state.historyTurns,null);assert.equal(state.following,true);
});

test("Dot 26: replaying a conflicted version cannot restore verified completion", async () => {
  const {deriveJobPassports}=await import("../js/job-passport.js");const digest=letter=>`sha256:${letter.repeat(64)}`;
  const projection={schema_version:"observatory-attempt-projection.v1",projection_digest:digest("a"),work_request_id:"WR-1",generated_at:"2026-09-30T12:00:00Z",source_state:{state_version:1,canonical_record_digest:digest("a"),plan_revision_digest:digest("c")},attempt_lane:{attempt_id:"attempt-one",persistent_profile:{profile_id:"profile-one",display_label:"Demo"},actual_staffing:{surface:"codex_desktop",adapter_id:"adapter-one",harness_id:"harness-one",model_id:"model-one"}},state:{progress:"verified_complete",lifecycle:"succeeded",verification:"verified_success"},component_map:[],observed_movement:{},timeline:[],evidence_refs:[]};
  const turn=(seq,payload)=>({seq,kind:"receipt",body:JSON.stringify({job_passport:{schema_version:"job-passport-wire.v1",kind:"observatory_projection",payload}})});
  const conflict={...projection,source_state:{...projection.source_state,canonical_record_digest:digest("b")}};
  const result=deriveJobPassports([turn(1,projection),turn(2,conflict),turn(3,projection)]);
  assert.equal(result.passports.length,1);assert.equal(result.passports[0].conflict,true);assert.equal(result.passports[0].status,"unknown_partial");
});

test("Dot 27: automatic board refresh preserves an unchanged questions answer draft", async () => {
  const {mountBoard}=await import("../js/progress-board.js");
  const dom=new JSDOM(source("progress-board.html"));
  const payload={snapshot:{board_id:"demo-board",version:1,snapshot_json:{title:"Demo board",tasks:{}}},questions:[{question_id:"demo-question",revision:1,prompt:"Demo question",choices:[],allow_free_text:true,status:null}]};
  const board=mountBoard({window:dom.window,document:dom.window.document,client:{readProgressBoard:async()=>payload},storage:null,search:"?board=demo-board",setInterval:()=>0,setTimeout:()=>0,clearTimeout:()=>{}});
  board.start();await tick();const input=dom.window.document.querySelector("textarea");input.value="Unsaved answer";input.dispatchEvent(new dom.window.Event("input"));await board.refresh();
  assert.equal(dom.window.document.querySelector("textarea").value,"Unsaved answer");dom.window.close();
});

test("Dot 28: queue assets resolve on its nested route through the Worker", async () => {
  const {handleDoctorcreRequest}=await import("../src/worker.js");const base="https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev/control-room/agents/queue";
  const dom=new JSDOM(source("queue.html"));const assets=[...dom.window.document.querySelectorAll('link[rel="stylesheet"],script[src]')].map(node=>new URL(node.getAttribute("href")||node.getAttribute("src"),base));
  const env={APP_ENV:"staging",CARR:{fetch:async()=>new Response("gate")},ASSETS:{fetch:async()=>new Response("asset")}};
  for(const asset of assets){const result=await handleDoctorcreRequest(new Request(asset),env);assert.equal(result.status,200,asset.pathname);}
  dom.window.close();
});

test("Dot 29: Quick Add completion preserves a newer task draft and date", async () => {
  const $=elements();$("quickAddInput").value="First task";$("quickAddDate").value="2026-09-30";const pending=deferred();
  handlers("js/task-records.js",'  $("quickAddForm")?.addEventListener("submit",', '  $("quickAddDraft")?.addEventListener',{$,draftViewer:"joe",viewer:"joe",renderQuickAdd:()=>({sentence:$("quickAddInput").value,plan:{args:{title:$("quickAddInput").value},summary:"Demo task"}}),announce:noop,operationKeys:{quickAdd:()=>"task-key"},matchingDraftId:()=>null,localDrafts:{list:()=>[]},restoredDraftId:null,draftOperations:new Map(),operations:new Map(),client:{addLoop:noop},dispatch:()=>pending.promise,renderDrafts:noop});
  const saving=$("quickAddForm").listeners.submit({preventDefault:noop});$("quickAddInput").value="Second task";$("quickAddDate").value="2026-10-01";pending.resolve({status:"ok"});await saving;
  assert.equal($("quickAddInput").value,"Second task");assert.equal($("quickAddDate").value,"2026-10-01");
});

test("Dot 30: source review closure does not prove merge release activation or consumer delivery", async () => {
  const {deliveryStages}=await import("../js/delivery-evidence-model.js");
  const fixture=handlers("test/delivery-evidence.test.mjs","const evidenceRef", "const card",{},["passport","facet"]);
  const passport=fixture.passport({closure_state:"complete",closure:{work:fixture.facet("complete"),proof:fixture.facet("complete"),release:fixture.facet("complete")}});
  const stages=deliveryStages(passport);assert.equal(stages.find(s=>s.stage==="source_verified").state,"complete");
  for(const stage of ["merged","released","activated","consumer_proven"])assert.equal(stages.find(s=>s.stage===stage).state,"unknown",stage);
});

test("Dot 9: phase reconciliation resumes the originally requested follow-up writes", async () => {
  const {completionPlan,moveIntent}=await import("../js/pipeline-model.js");const {cellKey,pendingFieldWrite}=await import("../js/field-write-reconciliation.mjs");
  const operations=new Map(),followUps=[];let phaseCalls=0;
  const state={fieldWrites:{},deals:new Map([["demo",{name:"Demo"}]]),boardSync:{requestRefresh:noop}};
  const request={deal:"demo",field:"phase",value:"Legal"};
  const h=handlers("js/pipeline.js","async function runMove(","async function runUndo(",{state,operations,completionPlan,cellKey,pendingFieldWrite,moveSummary:()=>"Demo to Legal",dock:{record:noop},renderBoard:noop,fieldWriteMessage:()=>"",fieldLabel:()=>"Phase",columnLabel:()=>"Legal",showConflict:noop,showToast:noop,say:noop,announce:noop,confirmLocalWrite:noop,refreshPanel:noop,fieldPatch:(field,value)=>({[field]:value}),sendFieldWrite:async()=>({status:"ok",request}),uuidv4:()=>"key",runOutcomeWrite:async(_key,step)=>followUps.push(step),runFollowUp:async(_key,step)=>followUps.push(step),sendPhaseWrite:async()=>{phaseCalls++;if(phaseCalls===1){state.fieldWrites[cellKey("demo","phase")]={request,status:"unknown"};return {status:"unknown",request};}return {status:"ok",request};}},["runMove","retryFieldWrite"]);
  const intent=moveIntent({id:"demo",name:"Demo",phase:"On Deck"},"legal");
  await h.runMove(intent,{evidence:"Demo note",nextStep:"Demo follow-up",nextWhen:"2026-10-01",effectiveDate:"2026-09-30",recordCriticalDate:true,dateSource:"Demo source"});
  assert.equal(followUps.length,0);await h.retryFieldWrite(cellKey("demo","phase"));
  assert.equal(followUps.length,3);assert.equal(followUps[0].verb,"add-deal-note");assert.equal(followUps[1].args.text,"Demo follow-up");assert.equal(followUps[2].args.due_on,"2026-09-30");
});

test("Closing outcome recovery after Dot 21 replays update-deal through the dock sender", async () => {
  const {pendingCommand}=await import('../js/command-feedback.mjs');
  const writes=[];const state={client:{updateDeal:async args=>{writes.push(args);if(writes.length===1)throw new Error("lost response");return {ok:true};}}};
  const h=handlers("js/pipeline.js","const FOLLOW_UP_SENDERS", "/**\n * The whole Move",{state,operations:new Map(),dock:{record:noop},commandState:createCommandState(),performCommand,pendingCommand,uuidv4:()=>"00000000-0000-4000-8000-000000000001"},["runFollowUp"]);
  const step={verb:"update-deal",summary:"Outcome",args:{deal:"demo",base_version:7,outcome:"won"}};
  await h.runFollowUp("outcome",step);await h.runFollowUp("outcome",step);
  assert.equal(writes.length,2);assert.equal(writes[0].idempotency_key,writes[1].idempotency_key);
});

test("PR111 #5: outcome read failure remains retryable from the receipt dock", async () => {
  const writes=[],receipts=[],operations=new Map();let reads=0;let dockOptions;
  const globals={state:{client:{getDeal:async()=>{if(++reads===1)throw new Error("read failed");return {deal:{version:7}};},updateDeal:async args=>{writes.push(args);return {ok:true};}},boardSync:{requestRefresh:noop}},dock:{record:(_key,value)=>receipts.push(value)},operations,commandState:createCommandState(),performCommand,uuidv4:()=>"00000000-0000-4000-8000-000000000001",$:()=>({}),createCommandDock:options=>{dockOptions=options;return {mount:noop,record:globals.dock.record};}};
  const h=handlers("js/pipeline.js","const FOLLOW_UP_SENDERS","/**\n * The whole Move",globals,["runOutcomeWrite","runFollowUp"]);
  const step={verb:"update-deal",summary:"Outcome",args:{deal:"demo",outcome:"won",closed_on:"2026-09-30"}};
  await h.runOutcomeWrite("close",step,{deal:"demo",name:"Demo"});
  assert.equal(receipts.at(-1).retry,true);assert.ok(operations.has("close"));assert.equal(writes.length,0);
  const mount=handlers("js/pipeline.js","function mountDock()","/* ------------------------------------------------------------------------ boot",{...globals,runOutcomeWrite:h.runOutcomeWrite,runFollowUp:h.runFollowUp},["mountDock"]);mount.mountDock();
  await dockOptions.onDispatch("close");await tick();assert.equal(writes.length,1);assert.equal(writes[0].base_version,7);assert.equal(writes[0].outcome,"won");
});


test("Dot 2 follow-through: a late confidential link cannot reappear under another Tour", async () => {
  const $=elements();$("#share-expiry").value="2026-10-02";$("#receipt-digest").value="sha256:"+"a".repeat(64);
  const state={tour:{id:"A"},projectionId:"projection-A",shareGrantId:"",rawShareToken:""};const pending=deferred();
  const h=handlers("tours/app.js","  async function issueShare(","  async function revokeShare(",{state,$,document:{querySelectorAll:()=>[{value:"view_packet"}]},newShareToken:()=>"synthetic-token",sha256:async()=>"digest",digest:()=>true,uuid:()=>"key",post:()=>pending.promise,text:(value,fallback)=>value||fallback,status:noop},["issueShare"]);
  const issuing=h.issueShare();await tick();state.tour={id:"B"};state.projectionId="projection-B";$("#share-link").hidden=true;
  pending.resolve({share_grant_id:"grant-A"});await issuing;
  assert.equal($("#share-link").hidden,true);assert.equal($("#share-url").value,"");assert.equal(state.rawShareToken,"");
});

const grantId="00000000-0000-4000-8000-000000000002";
function shareHarness(receipt,rotate=false) {
  const $=elements();$("#share-expiry").value="2026-10-02";$("#receipt-digest").value="sha256:"+"a".repeat(64);$("#share-link").hidden=true;
  const state={tour:{id:"A"},projectionId:"projection-A",shareGrantId:rotate ? grantId : "",rawShareToken:""};const calls=[];
  const h=handlers("tours/app.js","  async function issueShare(","  async function revokeShare(",{state,$,document:{querySelectorAll:()=>[{value:"view_packet"}]},newShareToken:()=>"synthetic-token",sha256:async()=>"digest",digest:()=>true,id:value=>typeof value==="string"&&/^[0-9a-f-]{36}$/.test(value),uuid:()=>"key",post:async(path,args)=>{calls.push({path,args});return typeof receipt==="function" ? receipt(calls.length) : receipt;},text:(value,fallback)=>value||fallback,status:noop},["issueShare"]);
  return {h,state,$,calls};
}
for(const receipt of [{},null,{share_grant_id:9},{share_grant_id:"invalid"}]) for(const rotate of [false,true]) test(`PR111 #12: ${rotate?"rotation":"issue"} requires valid grant receipt ${JSON.stringify(receipt)}`,async()=>{
  const {h,state,$}=shareHarness(receipt,rotate);await assert.rejects(h.issueShare(rotate));
  assert.equal($("#share-link").hidden,true);assert.equal($("#share-url").value,"");assert.equal(state.rawShareToken,"");assert.notEqual($("#share-state").textContent,"Active");
});

for(const rotate of [false,true]) test(`PR111 #13: lost ${rotate?"rotation":"issue"} receipt replays its retained token and request`,async()=>{
  const successor="00000000-0000-4000-8000-000000000003";
  const {h,state,$,calls}=shareHarness(n=>{if(n===1)throw new Error("committed; reply lost");return {ok:true,share_grant_id:successor};},rotate);let tokens=0,keys=0;
  h.newShareToken=()=>`token-${++tokens}`;h.uuid=()=>`key-${++keys}`;h.sha256=async raw=>`digest-${raw}`;
  await assert.rejects(h.issueShare(rotate));assert.ok(state.pendingShare);assert.match($("#share-state").textContent,/unknown/i);
  $("#share-expiry").value="2026-11-10";
  await h.issueShare(!rotate);assert.equal(calls.length,2);assert.deepEqual(calls[1],calls[0]);assert.equal(tokens,1);assert.equal(keys,1);assert.equal(state.rawShareToken,"token-1");assert.equal(state.shareGrantId,successor);assert.equal(state.pendingShare,null);
});

test("PR111 #13: retained share recovery stays reachable on its original Tour",async()=>{
  const {h,state,replies}=tourHarness();state.pendingShare={tourId:"A",projectionId:"projection-A"};replies.set("B",Promise.resolve({id:"B"}));
  await h.loadTour("B");assert.equal(state.tour.id,"A");assert.equal(state.pendingShare.tourId,"A");
});

for (const rotate of [false, true]) test(`PR111 #13: ${rotate ? "rotation" : "issue"} recovery survives same-Tour projection refresh`, async () => {
  const {h,state,$,calls}=shareHarness(n=>{if(n===1)throw new Error("committed; reply lost");return {share_grant_id:grantId};},rotate);
  await assert.rejects(h.issueShare(rotate));
  // Use both source read/render handlers: a refreshed Tour replaces the current
  // projection and grant, while the uncertain operation belongs to the old one.
  $("#route-stops").replaceChildren=noop;
  const currentGrant="00000000-0000-4000-8000-000000000004";
  const reload=handlers("tours/app.js","  function renderTour()","  function moveStop(",{
    state,$,restoredTourId:"",navigationBusy:false,composer:null,createPending:null,tourLoadSeq:0,
    request:async()=>({id:"A",projection_id:"projection-B",share_grant_id:currentGrant}),
    status:noop,text:(value,fallback="")=>typeof value==="string"&&value?value:fallback,
    id:()=>false,tourMetaLine:()=>"",renderFeedback:noop,renderShareGrants:noop,
    cheatSheetText:()=>"",stops:()=>[],mountPropertyPanel:noop,renderComposer:noop,renderAcceptedItinerary:noop,
    renderCreate:noop,validateDetail:noop,routeSnapshot:()=>"",initComposer:noop,
    renderSelection:noop,loadSelectionCart:async()=>{},loadProjectionPreview:async()=>{},loadFeedback:async()=>{},
  },["loadTour"]);
  await reload.loadTour("A");assert.equal(state.projectionId,"projection-B");
  assert.match($("#rotate-share").textContent,/Check link outcome/);
  const reloadedStatus=$("#share-state").textContent;
  await h.issueShare(!rotate);
  assert.match(reloadedStatus,/unknown/i);
  assert.deepEqual(calls[1],calls[0]);assert.equal(calls.length,2);
  assert.equal(state.pendingShare,null);assert.equal(state.shareGrantId,currentGrant);
  assert.equal($("#share-link").hidden,false);
  assert.match($("#share-state").textContent,/earlier projection/i);
});

for (const rotate of [false,true]) test(`PR111 R2: corrected ${rotate ? "rotation" : "issue"} follows a typed validation refusal`, async () => {
  const {h,state,$}=shareHarness(null,rotate);const requests=[];let tokens=0,keys=0;
  h.newShareToken=()=>`token-${++tokens}`;h.uuid=()=>`key-${++keys}`;
  $("#receipt-digest").value="sha256:"+"A".repeat(64);
  const transport=handlers("tours/app.js","  async function request(","  function validateDetail(",{
    state,sessionBinding:"binding",AbortController,
    fetch:async(path,init)=>{
      const payload=JSON.parse(init.body);requests.push({path,payload});
      return /^[a-f0-9]{64}$/.test(payload.receipt_digest.slice(7))
        ? new Response(JSON.stringify({data:{share_grant_id:grantId}}))
        : new Response(JSON.stringify({error:"invalid_payload"}),{status:400});
    },
  },["post"]);
  h.post=transport.post;
  await assert.rejects(h.issueShare(rotate));
  $("#receipt-digest").value="sha256:"+"a".repeat(64);
  await h.issueShare(rotate);
  assert.equal(requests.length,2);assert.notEqual(requests[0].payload.idempotency_key,requests[1].payload.idempotency_key);
  assert.equal(requests[1].payload.receipt_digest,"sha256:"+"a".repeat(64));
  assert.equal(tokens,2);assert.equal(keys,2);assert.equal(state.pendingShare,null);assert.equal($("#share-link").hidden,false);
});

for (const response of [new Response("",{status:400}),new Response(JSON.stringify({error:"timeout"}),{status:408})]) test(`PR111 R2: ambiguous HTTP ${response.status} keeps the exact share request`, async () => {
  const {h,state,$}=shareHarness(null);const requests=[];
  const transport=handlers("tours/app.js","  async function request(","  function validateDetail(",{
    state,sessionBinding:"binding",AbortController,
    fetch:async(path,init)=>{requests.push({path,payload:JSON.parse(init.body)});return requests.length===1 ? response : new Response(JSON.stringify({data:{share_grant_id:grantId}}));},
  },["post"]);
  h.post=transport.post;await assert.rejects(h.issueShare());assert.ok(state.pendingShare);
  $("#receipt-digest").value="sha256:"+"b".repeat(64);await h.issueShare();
  assert.deepEqual(requests[1],requests[0]);assert.equal(state.pendingShare,null);
});

for(const badAt of [0,1,2]) test(`PR111 #14: malformed activity page ${badAt+1} stays unknown`,async()=>{
  const view={sequence:1};let n=0;
  const h=handlers("js/notifications.js","async function takeActivity(","async function load(",{view,render:noop,client:{getChanges:async()=>{const i=n++;return i===badAt ? {} : {cursor:`cursor-${i}`,events:[{seq:i+1}]};}}},["takeActivity"]);
  await h.takeActivity();assert.equal(view.activity.state,"unknown");assert.equal(view.activity.observed_at,undefined);
});
for(const badAt of [0,1,2]) test(`PR111 #14: malformed room page ${badAt+1} never announces recovery`,async()=>{
  const {h,state}=roomHarness();state.backoffMs=8000;let n=0;const banners=[];h.banner=message=>banners.push(message);
  h.fetchTurns=async from=>{const i=n++;return i===badAt ? {} : {turns:[{seq:from+1,msg_id:`t-${i}`}],latest_seq:from+1,more:true};};
  await h.poll();assert.ok(state.backoffMs>=8000);assert.equal(state.cursor,0);assert.equal(state.turns.length,0);assert.ok(!banners.some(message=>message.includes("Wire back")));
});


test("Dot 23 follow-through: a cleared canonical action stays cleared", async () => {
  const client=createLiveClient({fetchImpl:async()=>rpc({deal_id:"demo",next_step:null,next_action:null,thread:[{kind:"next_step",text:"Historical action"}],events:[]})});
  const page=await client.getDeal("demo");assert.equal(page.deal.next_step,"");assert.equal(page.thread[0]?.text,"Historical action");
});
