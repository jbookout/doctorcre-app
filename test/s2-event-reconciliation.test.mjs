import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openDom } from './jsdom-harness.mjs';
import * as model from '../js/ideas-model.js';
import { formatCalendarDate } from '../js/visual-system.js';
import { approach, localToday } from '../js/calendar-model.js';
import { partnerName } from '../js/task-records-model.js';
const html = await readFile(new URL('../ideas.html', import.meta.url), 'utf8');
const source = (await readFile(new URL('../js/ideas.js', import.meta.url), 'utf8'))
 .replace(/^import[\s\S]*?from ["'][^"']+["'];/gm, '')
 .replace(/^boot\(\);$/m, '').replace(/^export \{ view \};$/m, '');
const row = () => ({id:'synthetic-event',version:4,title:'Synthetic event',organizer:'Synthetic organizer',kind:'networking',starts_at:'2026-11-01T10:00:00Z',ends_at:'2026-11-01T11:00:00Z',location:null,is_virtual:false,url:null,relevance_note:null,attendance_intent:'considering',owner_partner:'joe',status:'planned',source:'Synthetic invitation'});
async function setup() {
 const dom=openDom(html,{url:'https://example.test/ideas?tab=events',runScripts:'outside-only'}),w=dom.window;
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
 Object.assign(w,model,{formatCalendarDate,approach,localToday,partnerName,pageDocContext:null,selectDocRecord(){},publishDocRead(){},setDocFilters(){},updatedLabel:()=>'',deploymentIdentity:()=>''});
 w.eval(source+'\nglobalThis.eventApi={openEvent,saveEvent,closeEvent,view,setClient:value=>client=value};');
 let current=row(),reads=0,writes=[],fail=false;
 const client={selfActor:'joe',listIndustryEvents:async()=>{reads++;return{ok:true,events:[structuredClone(current)],count:1}},updateIndustryEvent:async args=>{writes.push(structuredClone(args));if(fail)throw new Error('lost reply');return{ok:true,event:current}},addIndustryEvent:async args=>{writes.push(structuredClone(args));if(fail)throw new Error('lost reply');return{ok:true,event:current}}};
 w.eventApi.setClient(client);w.eventApi.view.events.rows=[structuredClone(current)];w.eventApi.view.events.status='ready';
 return{dom,w,doc:w.document,api:w.eventApi,writes,get reads(){return reads},current,setFail:v=>{fail=v},submit:()=>w.eventApi.saveEvent({preventDefault(){}})};
}
test('S2 event checks a fresh version before sending and requires deliberate review of a changed record',async()=>{
 const s=await setup();s.api.openEvent(s.current.id);s.doc.getElementById('eventTitle').value='My draft';s.current.version++;s.current.title='Partner event';
 await s.submit();assert.equal(s.writes.length,0);assert.equal(s.reads,1);assert.equal(s.doc.getElementById('eventTitle').value,'My draft');assert.match(s.doc.getElementById('eventFormMessage').textContent,/changed/i);assert.equal(s.doc.getElementById('eventSave').disabled,true);
});
test('S2 uncertain event save survives closing and reopening with its exact original request',async()=>{
 const s=await setup();s.api.openEvent(s.current.id);s.doc.getElementById('eventTitle').value='My draft';s.setFail(true);await s.submit();
 assert.equal(s.writes.length,1);assert.ok(s.writes[0].idempotency_key);
 s.api.closeEvent({discard:true});s.current.version++;s.api.view.events.rows=[structuredClone(s.current)];s.api.openEvent(s.current.id);
 assert.equal(s.doc.getElementById('eventTitle').value,'My draft');assert.equal(s.doc.getElementById('eventTitle').disabled,true);assert.equal(s.doc.getElementById('eventSave').disabled,false);
 const reads=s.reads;s.setFail(false);await s.submit();assert.deepEqual(s.writes[1],s.writes[0]);assert.equal(s.reads,reads+1,'only post-success refresh, no pre-replay rebase');
});

test('S2 an authorization failure after an unknown event write keeps its original request locked for reconciliation',async()=>{
 const s=await setup();s.api.openEvent(s.current.id);s.doc.getElementById('eventTitle').value='My draft';s.setFail(true);await s.submit();
 const original=structuredClone(s.writes[0]);
 s.api.setClient({selfActor:'joe',updateIndustryEvent:async()=>{throw Object.assign(new Error('Denied retry'),{status:403,pendingRequest:original})}});
 await s.submit();assert.deepEqual({...s.api.view.events.pending.get(s.current.id)?.args},original);
 assert.equal(s.doc.getElementById('eventTitle').disabled,true);assert.equal(s.doc.getElementById('eventSave').disabled,false);assert.match(s.doc.getElementById('eventFormMessage').textContent,/unknown/i);
 s.api.closeEvent({discard:true});s.api.openEvent(s.current.id);assert.equal(s.doc.getElementById('eventTitle').value,'My draft');assert.equal(s.doc.getElementById('eventSave').textContent,'Check outcome');
});

test('S2 failed session bootstrap on an unknown event replay cannot discard the original request',async()=>{
 const s=await setup();s.api.openEvent(s.current.id);s.doc.getElementById('eventTitle').value='My draft';s.setFail(true);await s.submit();const original=structuredClone(s.writes[0]);
 s.api.setClient({selfActor:'joe',updateIndustryEvent:async()=>{throw Object.assign(new Error('Session lookup denied'),{status:403})}});
 await s.submit();assert.deepEqual({...s.api.view.events.pending.get(s.current.id)?.args},original);assert.equal(s.doc.getElementById('eventTitle').disabled,true);assert.equal(s.doc.getElementById('eventSave').disabled,false);
});

for(const kind of ['network','malformed'])test(`S2 ${kind} pre-submit event read sends nothing and leaves the draft available for another save`,async()=>{
 const s=await setup();s.api.openEvent(s.current.id);s.doc.getElementById('eventTitle').value='My draft';
 s.api.setClient({selfActor:'joe',listIndustryEvents:async()=>{if(kind==='network')throw new Error('Read interrupted');return{}},updateIndustryEvent:async()=>assert.fail('write must not be attempted')});
 await s.submit();assert.equal(s.api.view.events.pending.size,0);assert.equal(s.doc.getElementById('eventSave').disabled,false);assert.equal(s.doc.getElementById('eventTitle').disabled,false);assert.equal(s.doc.getElementById('eventTitle').value,'My draft');assert.match(s.doc.getElementById('eventFormMessage').textContent,/not sent/i);
});
