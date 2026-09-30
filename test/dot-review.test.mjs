import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
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
  const context = vm.createContext({ console, Date, Map, Set, Promise, URL, URLSearchParams, setTimeout, clearTimeout, ...globals });
  vm.runInContext(text.slice(offset, finish).replace(/export /g, "") + "\nObject.assign(globalThis, {" + expose.join(",") + "});", context);
  return context;
}
const rpc = payload => new Response(JSON.stringify({result:{content:[{text:JSON.stringify(payload)}]}}));
const elements = () => { const rows = new Map(); return key => { if(!rows.has(key)) rows.set(key, {value:"",textContent:"",hidden:false,disabled:false,listeners:{},addEventListener(type,listener){this.listeners[type]=listener;},setAttribute:noop}); return rows.get(key); }; };

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

test("Dot 18: a late answer cannot clear another Work Requests draft", async () => {
  const {answerWorkRequestRequest,answerDraftAfterAttempt,workRequestCardRequest}=await import("../js/model-room-model.js");const pending=deferred();const announcements=[];
  const view={historyWorkItemId:"WR-1",answer:{answerText:"First answer",evidenceRef:"safe:test",scopeConfirmed:true},answerSend:{state:"idle"}};
  const h=handlers("js/model-room.js","async function submitAnswer(","function render()",{view,currentAnswerBaseVersion:()=>2,answerWorkRequestRequest,answerDraftAfterAttempt,workRequestCardRequest,client:{answerWorkRequestForJoe:()=>pending.promise,workRequestCard:async()=>({}),currentWorkRequests:async()=>({})},uuidv4:()=>"key",renderAnswer:noop,announce:message=>announcements.push(message),take:async()=>{},refuseWorkRequestCard:noop,validCurrentWorkRequestsPayload:()=>true},["submitAnswer"]);
  const sending=h.submitAnswer();view.historyWorkItemId="WR-2";view.answer={answerText:"Second draft",evidenceRef:"",scopeConfirmed:false};view.answerSend={state:"idle"};pending.resolve({state:"triaged"});await sending;
  assert.equal(view.answer.answerText,"Second draft");assert.ok(!announcements.some(text=>text.includes("WR-2")));
});

function roomHarness(total=6000) {
  const state={cursor:0,latestSeqHint:0,turns:[],byMsgId:new Map(),oldestSeq:null,following:true,pending:new Map(),filters:{},viewer:"joe",missed:0};const reads=[];let displayed=[];
  const globals={state,PAGE_SIZE:60,DOM_TURN_CAP:300,POLL_BACKOFF_CEILING_MS:60000,POLL_VISIBLE_MS:4000,$:elements(),PARTNER_LABEL:{},seqOf:t=>Number(t.seq),fetchTurns:async(from,limit)=>{reads.push([from,limit]);const turns=Array.from({length:Math.min(limit,Math.max(0,total-from))},(_,i)=>({seq:from+i+1,msg_id:`turn-${from+i+1}`}));return {turns,latest_seq:turns.at(-1)?.seq||from,more:turns.length===limit};},deriveModel:()=>({}),renderStage:noop,renderSeatChips:noop,renderDesks:noop,renderWire:noop,renderAssignments:noop,renderSessions:noop,renderJobPassport:noop,renderHealth:noop,animateArrivals:noop,banner:noop,setState:noop,document:{hidden:false},setTimeout:()=>0,clearTimeout:noop,turnPasses:()=>true,reconcile:(_root,items)=>{displayed=items.filter(i=>i.kind==="turn").map(i=>i.turn.seq);},scrollToBottom:noop};
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

test("Dot 26: replaying a conflicted version cannot restore verified completion", async () => {
  const {deriveJobPassports}=await import("../js/job-passport.js");const digest=letter=>`sha256:${letter.repeat(64)}`;
  const projection={schema_version:"observatory-attempt-projection.v1",projection_digest:digest("a"),work_request_id:"WR-1",generated_at:"2026-09-30T12:00:00Z",source_state:{state_version:1,canonical_record_digest:digest("a"),plan_revision_digest:digest("c")},attempt_lane:{attempt_id:"attempt-one",persistent_profile:{profile_id:"profile-one",display_label:"Demo"},actual_staffing:{surface:"codex_desktop",adapter_id:"adapter-one",harness_id:"harness-one",model_id:"model-one"}},state:{progress:"verified_complete",lifecycle:"succeeded",verification:"verified_success"},component_map:[],observed_movement:{},timeline:[],evidence_refs:[]};
  const turn=(seq,payload)=>({seq,kind:"receipt",body:JSON.stringify({job_passport:{schema_version:"job-passport-wire.v1",kind:"observatory_projection",payload}})});
  const conflict={...projection,source_state:{...projection.source_state,canonical_record_digest:digest("b")}};
  const result=deriveJobPassports([turn(1,projection),turn(2,conflict),turn(3,projection)]);
  assert.equal(result.passports.length,1);assert.equal(result.passports[0].conflict,true);assert.equal(result.passports[0].status,"unknown_partial");
});

test("Dot 27: automatic board refresh preserves an unchanged questions answer draft", async () => {
  const {boardView,answerRequest,taskPulse}=await import("../js/progress-board-model.js");
  const dom=new JSDOM(source("progress-board.html"));
  const payload={snapshot:{board_id:"demo-board",version:1,snapshot_json:{title:"Demo board",tasks:{}}},questions:[{question_id:"demo-question",revision:1,prompt:"Demo question",choices:[],allow_free_text:true,status:null}]};
  const h=handlers("js/progress-board.js","const boardId",null,{document:dom.window.document,location:{search:"?board=demo-board"},matchMedia:()=>({matches:false,addEventListener:noop}),setInterval:()=>0,createLiveClient:()=>({readProgressBoard:async()=>payload}),boardView,answerRequest,taskPulse,uuidv4:()=>"key"},["refresh"]);
  await tick();const input=dom.window.document.querySelector("textarea");input.value="Unsaved answer";input.dispatchEvent(new dom.window.Event("input"));await h.refresh();
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
  const request={deal:"demo",value:"Legal"};
  const h=handlers("js/pipeline.js","async function runMove(","async function runUndo(",{state,operations,completionPlan,cellKey,pendingFieldWrite,moveSummary:()=>"Demo to Legal",dock:{record:noop},renderBoard:noop,fieldWriteMessage:()=>"",fieldLabel:()=>"Phase",columnLabel:()=>"Legal",showConflict:noop,showToast:noop,say:noop,announce:noop,confirmLocalWrite:noop,uuidv4:()=>"key",runOutcomeWrite:async(_key,step)=>followUps.push(step),runFollowUp:async(_key,step)=>followUps.push(step),sendPhaseWrite:async()=>{phaseCalls++;if(phaseCalls===1){state.fieldWrites[cellKey("demo","phase")]={request,status:"unknown"};return {status:"unknown",request};}return {status:"ok",request};}},["runMove","retryFieldWrite"]);
  const intent=moveIntent({id:"demo",name:"Demo",phase:"On Deck"},"legal");
  await h.runMove(intent,{evidence:"Demo note",nextStep:"Demo follow-up",nextWhen:"2026-10-01",effectiveDate:"2026-09-30",recordCriticalDate:true,dateSource:"Demo source"});
  assert.equal(followUps.length,0);await h.retryFieldWrite(cellKey("demo","phase"));
  assert.equal(followUps.length,3);assert.equal(followUps[0].verb,"add-deal-note");assert.equal(followUps[1].args.text,"Demo follow-up");assert.equal(followUps[2].args.due_on,"2026-09-30");
});

test("Closing outcome recovery after Dot 21 replays update-deal through the dock sender", async () => {
  const writes=[];const state={client:{updateDeal:async args=>{writes.push(args);if(writes.length===1)throw new Error("lost response");return {ok:true};}}};
  const h=handlers("js/pipeline.js","const FOLLOW_UP_SENDERS", "/**\n * The whole Move",{state,operations:new Map(),dock:{record:noop},commandState:createCommandState(),performCommand,uuidv4:()=>"00000000-0000-4000-8000-000000000001"},["runFollowUp"]);
  const step={verb:"update-deal",summary:"Outcome",args:{deal:"demo",base_version:7,outcome:"won"}};
  await h.runFollowUp("outcome",step);await h.runFollowUp("outcome",step);
  assert.equal(writes.length,2);assert.equal(writes[0].idempotency_key,writes[1].idempotency_key);
});


test("Dot 2 follow-through: a late confidential link cannot reappear under another Tour", async () => {
  const $=elements();$("#share-expiry").value="2026-10-02";$("#receipt-digest").value="sha256:"+"a".repeat(64);
  const state={tour:{id:"A"},projectionId:"projection-A",shareGrantId:"",rawShareToken:""};const pending=deferred();
  const h=handlers("tours/app.js","  async function issueShare(","  async function revokeShare(",{state,$,document:{querySelectorAll:()=>[{value:"view_packet"}]},newShareToken:()=>"synthetic-token",sha256:async()=>"digest",digest:()=>true,uuid:()=>"key",post:()=>pending.promise,text:(value,fallback)=>value||fallback,status:noop},["issueShare"]);
  const issuing=h.issueShare();await tick();state.tour={id:"B"};state.projectionId="projection-B";$("#share-link").hidden=true;
  pending.resolve({share_grant_id:"grant-A"});await issuing;
  assert.equal($("#share-link").hidden,true);assert.equal($("#share-url").value,"");assert.equal(state.rawShareToken,"");
});


test("Dot 23 follow-through: a cleared canonical action stays cleared", async () => {
  const client=createLiveClient({fetchImpl:async()=>rpc({deal_id:"demo",next_step:null,next_action:null,thread:[{kind:"next_step",text:"Historical action"}],events:[]})});
  const page=await client.getDeal("demo");assert.equal(page.deal.next_step,"");assert.equal(page.thread[0]?.text,"Historical action");
});
