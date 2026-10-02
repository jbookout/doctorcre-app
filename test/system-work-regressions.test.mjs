import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {mountSystemWorkBoard} from '../js/system-work-board.js';
import {systemPipeline} from '../js/system-work-board-model.js';
import {taskPulse,taskStage} from '../js/progress-board-model.js';
const row=(id='a')=>({id,source:'public.loop_item',kind:'loop',title:`Synthetic ${id}`,state:'open',completed:false,age:1,version:2,last_activity_at:'2026-10-01T12:00:00Z',link:'/system-work.html',available_triage_actions:[{action:'progress',verb:'update-loop',args:{loop_id:id},versioned:true,fields:[{name:'body',label:'Progress',required:true}]}]});
const envelope=(items=[row()],extra={})=>({schema:'unfinished-work.v1',items,coverage:[{kind:'loop',source_ref:'public.loop_item',state:'complete',count_total:items.length}],census_complete:true,next_cursor:null,...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
async function setup(t,{read,write}={}){
 const dom=new JSDOM(readFileSync(new URL('../control-room.html',import.meta.url),'utf8'),{url:'http://localhost/control-room/progress'});const previous={document:globalThis.document,FormData:globalThis.FormData,confirm:globalThis.confirm};
 Object.assign(globalThis,{document:dom.window.document,FormData:dom.window.FormData,confirm:()=>true});t.after(()=>{Object.assign(globalThis,previous);dom.window.close();});
 const d=dom.window.document,dialog=d.querySelector('#work-triage');let restore;
 dialog.showModal=()=>{restore=d.activeElement;dialog.open=true;};dialog.close=()=>{dialog.open=false;restore?.focus();};
 const calls=[],writes=[],pipelines=[];const client={unfinishedWork:async args=>{calls.push(args);return read?read(args):envelope(args.live_library?[]:[row(),row('b')]);},triageSystemWork:async(verb,args)=>{writes.push({verb,args:structuredClone(args)});return write?write(verb,args):{ok:true,message:'Source updated'};}};
 const board=mountSystemWorkBoard({client,onPipeline:p=>pipelines.push(p)});await settle();
 const click=selector=>d.querySelector(selector).click();
 const open=id=>click(`.work-card[data-work-id="${id}"] button`);
 const submit=value=>{d.querySelector('#work-triage textarea').value=value;d.querySelector('#work-triage-form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));};
 return {d,dom,board,calls,writes,pipelines,click,open,submit};
}
test('finding 1: structured non-confirmation displays outcomes, counts and source state',async t=>{
 for(const outcome of ['not_proven','held','stale','superseded']){
  const h=await setup(t,{write:()=>({ok:true,confirmed:0,not_confirmed:1,results:[{outcome,state:'verification'}]})});h.open('a');h.submit('Synthetic evidence');await settle();
  const text=h.d.querySelector('.triage-status').textContent;assert.match(text,new RegExp(outcome));assert.match(text,/0 confirmed/);assert.match(text,/1 not confirmed/);assert.match(text,/verification/);assert.doesNotMatch(text,/saved/);
 }
});
test('finding 2: uncertain write replays immutable key, body and version after reopen',async t=>{
 let attempt=0;const h=await setup(t,{read:args=>envelope(args.live_library?[]:[{...row(),version:args.id?3:2}]),write:()=>{if(++attempt===1)throw Object.assign(new Error('Unknown outcome'),{payload:{error:'unhandled_verb_failure'}});return {ok:true,message:'Source updated'};}});
 h.open('a');h.submit('Original progress');await settle();assert.match(h.d.querySelector('.triage-status').textContent,/unconfirmed/i);assert.doesNotMatch(h.d.querySelector('.triage-status').textContent,/refused/);
 h.click('#work-triage-close');h.open('a');h.submit('Replacement progress');await settle();assert.equal(h.writes.length,2);assert.deepEqual(h.writes[1],h.writes[0]);
});
test('finding 3: late action receipt stays with its operation and never modifies another dialog',async t=>{
 const result=deferred();const h=await setup(t,{write:()=>result.promise});h.open('a');h.submit('First progress');await settle();h.click('#work-triage-close');h.open('b');result.resolve({ok:true,message:'First receipt'});await settle();
 assert.equal(h.d.querySelector('#work-triage-form h2').textContent,'Progress · Synthetic b');assert.equal(h.d.querySelectorAll('#work-triage-form button').length,1);assert.equal(h.d.querySelector('.triage-status').textContent,'');
 h.click('#work-triage-close');h.open('a');assert.match(h.d.querySelector('.triage-status').textContent,/First receipt/);
});
test('finding 4: definite refusal and pre-write validation allow correction and fresh recovery',async t=>{
 let refused=true;const h=await setup(t,{write:()=>{if(refused)throw Object.assign(new Error('Conflict'),{payload:{error:'version_conflict'}});return {ok:true,message:'Source updated'};}});
 h.open('a');h.submit('');await settle();assert.equal(h.d.querySelector('#work-triage-form button[type="submit"]').disabled,false);assert.equal(h.writes.length,0);
 h.submit('First progress');await settle();assert.equal(h.d.querySelector('#work-triage-form button[type="submit"]').disabled,false);assert.match(h.d.querySelector('.triage-status').textContent,/Version conflict/);
 refused=false;h.submit('Corrected progress');await settle();assert.equal(h.calls.filter(c=>c.id==='a').length,3);assert.equal(h.writes.length,2);
});
test('finding 5: successful Close refreshes despite restored card focus',async t=>{
 let removed=false;const h=await setup(t,{read:args=>envelope(args.live_library||removed?[]:[row()]),write:()=>{removed=true;return {ok:true,message:'Source updated'};}});h.d.querySelector('.work-card button').focus();h.open('a');h.submit('Complete');await settle();
 [...h.d.querySelectorAll('#work-triage-form button')].find(b=>b.textContent==='Close').click();await settle();assert.equal(h.d.querySelectorAll('.work-card').length,0);
});
test('finding 6: filter transition invalidates old query cursor and blocks append',async t=>{
 const next=deferred();const h=await setup(t,{read:args=>args.text?next.promise:envelope(args.live_library?[]:[row()],{next_cursor:args.live_library?null:'old-query-cursor'})});
 h.d.querySelector('[name="text"]').value='new query';h.click('#system-work-filters button');h.click('#system-work-more');await settle();assert.equal(h.calls.some(c=>c.text==='new query'&&c.cursor),false);
 next.resolve(envelope([row('new')]));await settle();assert.equal(h.d.querySelector('.work-card').dataset.workId,'new');
});
test('finding 7: background polling preserves loaded library pages',async t=>{
 let revision=1;const h=await setup(t,{read:args=>envelope(args.live_library?[{...row(args.cursor?'older':'recent'),title:`Library revision ${revision}`}]:[row()],{next_cursor:args.live_library&&!args.cursor?'library-page-2':null})});h.click('#live-library');await settle();h.click('#system-work-more');await settle();assert.equal(h.d.querySelectorAll('.work-card').length,2);
 revision=2;h.d.querySelector('#live-library').focus();await h.board.refresh();await settle();assert.equal(h.d.querySelectorAll('.work-card').length,2);assert.ok([...h.d.querySelectorAll('.work-card h4')].every(card=>card.textContent==='Library revision 2'));assert.ok(h.calls.filter(call=>call.cursor==='library-page-2').length>=2);
});
test('finding 8: focus entering cards during background read survives response',async t=>{
 let slow=false;const next=deferred();const h=await setup(t,{read:args=>slow&&!args.live_library?next.promise:envelope(args.live_library?[]:[row()])});slow=true;h.d.querySelector('#live-library').focus();const pending=h.board.refresh();const link=h.d.querySelector('.work-card a');link.focus();next.resolve(envelope([row()]));await pending;assert.equal(h.d.activeElement,link);assert.equal(link.isConnected,true);
});
test('R1: focus-deferred background refresh retains the displayed page continuation',async t=>{
 let slow=false;const next=deferred();const h=await setup(t,{read:args=>{
  if(args.live_library)return envelope([]);
  if(args.cursor)return envelope([row('older')]);
  return slow?next.promise:envelope([row()],{next_cursor:'displayed-page-2'});
 }});
 const more=h.d.querySelector('#system-work-more');assert.equal(more.hidden,false);
 slow=true;h.d.querySelector('#live-library').focus();const pending=h.board.refresh();
 assert.equal(more.disabled,true);h.click('#system-work-more');assert.equal(h.calls.some(c=>c.cursor),false);
 const link=h.d.querySelector('.work-card a');link.focus();
 next.resolve(envelope([row('replacement')],{next_cursor:'replacement-page-2'}));await pending;
 assert.equal(h.d.activeElement,link);assert.equal(link.isConnected,true);
 assert.equal(more.hidden,false);assert.equal(more.disabled,false);
 h.click('#system-work-more');await settle();
 assert.equal(h.calls.filter(c=>c.cursor).length,1);assert.equal(h.calls.find(c=>c.cursor).cursor,'displayed-page-2');
 assert.deepEqual([...h.d.querySelectorAll('.work-card')].map(c=>c.dataset.workId),['a','older']);
});
test('finding 9: Live coverage and freshness remain independently visible',async t=>{
 const h=await setup(t,{read:args=>args.live_library?envelope([],{census_complete:false,as_of:'2026-09-01T12:00:00Z',coverage:[{kind:'pull_request',state:'unavailable',reason:'GitHub unavailable'}]}):envelope()});
 const text=h.d.querySelector('#system-work-coverage').textContent;assert.match(text,/Live.*Incomplete/i);assert.match(text,/Pull request unavailable/);assert.ok([...h.d.querySelectorAll('#system-work-coverage time')].some(time=>time.title.includes('2026-09-01')));
});
test('finding 10: source stages and terminal pulse preserve pipeline contract',()=>{
 for(const state of ['queued','running','review','blocked','failed']){const item={...row(),kind:'progress_task',state};const expected=taskStage({status:state});assert.equal(systemPipeline([item],[]).stages.find(s=>s.tasks.length).id,expected);}
 assert.equal(systemPipeline([{...row(),state:'ci'}],[]).stages.find(s=>s.tasks.length).id,'ci');assert.equal(systemPipeline([{...row(),state:'merged'}],[]).stages.find(s=>s.tasks.length).id,'merged');
 for(const state of ['approved','merged']){const task=systemPipeline([],[{...row(),state,completed:true}]).stages.find(s=>s.id==='live').tasks[0];assert.equal(taskPulse(task),'still');}
});
test('findings 2 and 3: reopening a pending action cannot replace it and receives its receipt',async t=>{
 const result=deferred();const h=await setup(t,{write:()=>result.promise});h.open('a');h.submit('Original');await settle();h.click('#work-triage-close');h.open('a');h.submit('Replacement');await settle();assert.equal(h.writes.length,1);
 result.resolve({ok:true,message:'Retained receipt'});await settle();assert.match(h.d.querySelector('.triage-status').textContent,/Retained receipt/);assert.equal(h.d.querySelectorAll('[data-receipt-close]').length,1);
});
test('finding 9: pinned producer source metadata and per-source observation age are shown',async t=>{
 const h=await setup(t,{read:args=>envelope(args.live_library?[]:[row()],{source:{observed_at:'2026-10-01T12:00:00Z',freshness:'unknown'},coverage:[{kind:'pull_request',state:'unavailable',observed_at:'2026-09-01T12:00:00Z',reason:'github_cache_missing_stale_or_incomplete'}],census_complete:false})});
 const text=h.d.querySelector('#system-work-coverage').textContent;assert.match(text,/Update time unavailable/);const clocks=[...h.d.querySelectorAll('#system-work-coverage time')];for(const date of ['2026-10-01','2026-09-01'])assert.ok(clocks.some(time=>time.title.includes(date)));assert.doesNotMatch(text,/source|census|github_cache|Read /i);
});
test('finding 2: acknowledged receipt allows a later independent progress update',async t=>{
 const h=await setup(t);h.open('a');h.submit('First progress');await settle();h.click('[data-receipt-close]');await settle();h.open('a');h.submit('Second progress');await settle();assert.equal(h.writes.length,2);assert.notEqual(h.writes[0].args.idempotency_key,h.writes[1].args.idempotency_key);assert.equal(h.writes[1].args.body,'Second progress');
});

test('W1: background work updates recover without prompting and do not overlap',async t=>{
 let fail=false,slow=false;const next=deferred();const h=await setup(t,{read:args=>{if(fail)throw new Error('Synthetic offline');return slow&&!args.live_library?next.promise:envelope(args.live_library?[]:[row()]);}});
 fail=true;await h.board.refresh();assert.equal(h.d.querySelector('#system-work-error').textContent,'System work updates unavailable.');
 fail=false;slow=true;const pending=h.board.refresh();const count=h.calls.length;await h.board.refresh();assert.equal(h.calls.length,count);
 next.resolve(envelope([{...row(),title:'Automatically updated'}]));await pending;assert.equal(h.d.querySelector('#system-work-error').hidden,true);assert.equal(h.d.querySelector('.work-card h4').textContent,'Automatically updated');assert.equal(h.writes.length,0);
 assert.equal(h.d.querySelector('#system-work-coverage button').getAttribute('aria-label'),'Refresh');assert.doesNotMatch(h.d.querySelector('#system-work-coverage').textContent,/source|census|items|read|retry/i);
});
