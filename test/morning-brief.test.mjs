import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { morningBriefView, validBrief, briefPreferences, localDay } from '../js/morning-brief-model.js';
import { mountMorningBrief } from '../js/morning-brief.js';
import { createLiveClient } from '../js/live-client.js';
import { createFixtureClient } from '../js/fixture-client.js';
import { readFile } from 'node:fs/promises';
const now = new Date(2026,9,3,8), day = localDay(now), since = new Date(2026,9,2,17).toISOString();
const section = items => ({state:items.length ? 'ready':'empty',items});
const due = (id='a',owner='joe',date=day) => ({id:`action-${id}`,subject_type:'deal',subject_id:id,what:'Review demo lease comments',owner,due_on:date});
const deal = (id='a',owner='joe') => ({id,name:`Demo ${id}`,owner,operating_state:'active',phase:'legal'});
function payload() { return {sponsor:'joe',sections:{today:section([due(),due('b')]),deals:section([deal(),deal('b'),deal('c'),deal('d','dell')]),loops:section([])}}; }
const event = (id='c',stamp=now.toISOString()) => ({id:`event-${id}`,subject_type:'deal',subject_id:id,recorded_at:stamp,field:'next_step',new_value:'Review demo terms',old_value:'Wait'});
const options = {now,since,events:[event()],caughtUp:true};

test('a short evidence-linked first action, overnight change and today item; duplicates and other partner excluded',()=>{
 const data=payload();data.sections.today.items.push(due('d','dell'),due('a'));
 const view=morningBriefView(data,options);
 assert.deepEqual(view.groups.map(group=>[group.key,group.row.id]),[['first','a'],['overnight','c'],['today','b']]);
 assert.ok(view.spoken.split(/\s+/).length<=65);
 assert.equal(view.unavailable.length,0);
 assert.deepEqual(morningBriefView(data,{...options,events:[event('d')]}).groups.map(group=>group.key),['first','today']);
});
test('empty sections omitted; unknown coverage never becomes all-clear or filler',()=>{
 const data=payload();for(const key of Object.keys(data.sections))data.sections[key]=section([]);
 assert.deepEqual(morningBriefView(data,{...options,events:[]}).groups,[]);
 assert.equal(morningBriefView(data,{...options,events:[]}).spoken,'');
 data.sections.today={state:'unavailable',items:[]};
 const view=morningBriefView(data,{...options,caughtUp:false});
 assert.equal(view.groups.length,0);assert.deepEqual(view.unavailable,['Today’s priorities unavailable','Overnight updates unavailable']);
 assert.match(view.spoken,/unavailable/);
});
test('date window, priority ordering, upcoming, closed and paused exclusions, dedupe',()=>{
 const data=payload();data.sections.today.items=[due('b','joe','2026-10-01'),due(),due('c','joe','2026-10-04')];
 assert.equal(morningBriefView(data,options).groups[0].row.id,'b');
 data.sections.deals.items[1].operating_state='parked';
 assert.equal(morningBriefView(data,{...options,events:[event('c','2026-10-01T12:00:00Z')]}).groups[0].row.id,'a');
 data.sections.deals.items[0].phase='closed';
 assert.equal(morningBriefView(data,{...options,events:[event('c',new Date(now.valueOf()+60000).toISOString())]}).groups.length,0);
});
test('due partner tasks carry exact kind/number identity; undated backlog never fills brief',()=>{
 const data=payload();data.sections.today=section([]);data.sections.loops=section([
 {number:'1',kind:'open_loop',owner:'joe',title:'Demo task',status:'open',due_on:day,blocker_detail:'Review demo entry'},
 {number:'2',kind:'open_loop',owner:'dell',title:'Demo other task',status:'open',due_on:day},
 {number:'3',kind:'open_loop',owner:'joe',title:'Demo backlog',status:'open',due_on:null}]);
 assert.deepEqual(morningBriefView(data,{...options,events:[]}).groups.map(group=>group.row.key),['loop:open_loop:1']);
});
test('preferences isolated per partner, storage failures tolerated, no brief content persisted',()=>{
 const data=new Map();const storage={getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value)};
 const joe=briefPreferences(storage,'joe');joe.save({day,speech:true,since});
 assert.equal(briefPreferences(storage,'dell').value.speech,undefined);assert.equal(briefPreferences(storage,'joe').value.day,day);
 assert.doesNotThrow(()=>briefPreferences({getItem(){throw Error();},setItem(){throw Error();}},'joe').save({day}));
 assert.doesNotMatch([...data.values()].join(''),/Demo|lease/);
});
test('live read sends no audience parameters and both adapters implement the read',async()=>{
 const calls=[];const live=createLiveClient({fetchImpl:async(path,init)=>{calls.push({path,init});return new Response(JSON.stringify({result:{content:[{text:JSON.stringify(payload())}]}}));}});
 assert.equal(validBrief(await live.morningBrief({actor:'dell'})),true);
 assert.equal(calls[0].path,'/mcp');assert.equal(calls[0].init.credentials,'same-origin');assert.deepEqual(JSON.parse(calls[0].init.body).params,{name:'morning-brief',arguments:{}});
 const seed=await readFile(new URL('../data/board-seed.json',import.meta.url));
 const fixture=await createFixtureClient({seedUrl:`data:application/json;base64,${seed.toString('base64')}`});
 assert.equal(validBrief(await fixture.morningBrief()),true);
 const all=await fixture.getChanges(null);assert.ok(all.events.length>0);
 assert.deepEqual((await fixture.getChanges(null,{since:'2050-01-01T00:00:00.000Z'})).events,[]);
 assert.deepEqual((await fixture.getChanges(all.cursor,{since:'2050-01-01T00:00:00.000Z'})).events,[]);
});
function setup(t,{automatic=true,storage,read}={}) {
 const dom=new JSDOM('<button id="docOpen">Doc</button><button id="docMorning">Morning brief</button>',{url:'http://localhost'});t.after(()=>dom.window.close());
 const {window:win}=dom,root=win.document;
 win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};win.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new win.Event('close'));};
 if(storage)for(const [key,value]of storage)win.localStorage.setItem(key,value);
 let data=payload(),count=0,current=now,fail=false;
 const client={morningBrief:async()=>{count++;if(fail)throw Error('Offline');return read ? read():data;},getChanges:async()=>({events:[],cursor:'end'}),getDeal:async id=>({deal:deal(id),thread:[{text:'Demo short note. Original demo note continues.'}]}),readLoop:async args=>({loop:{number:args.number,kind:args.kind,title:'Demo task',status:'open',prose_md:'Demo task entry.'}})};
 const ui=mountMorningBrief({document:root,window:win,getClient:async()=>client,automatic,intervalMs:100000,now:()=>current});t.after(()=>ui.dispose());
 return {ui,root,win,client,get count(){return count;},set data(value){data=value;},set current(value){current=value;},set fail(value){fail=value;}};
}
test('first live opening once per day; dismissal, reopen, next day and partner switch',async t=>{
 const state=setup(t);await state.ui.refresh();assert.equal(state.root.querySelector('dialog').open,true);
 state.root.getElementById('morningClose').click();await state.ui.refresh();assert.equal(state.root.querySelector('dialog').open,false);
 state.ui.open();assert.equal(state.root.querySelector('dialog').open,true);state.root.getElementById('morningClose').click();
 state.current=new Date(2026,9,4,8);await state.ui.refresh();assert.equal(state.root.querySelector('dialog').open,true);state.root.getElementById('morningClose').click();
 const other=payload();other.sponsor='dell';other.sections.today=section([due('d','dell')]);state.data=other;await state.ui.refresh();assert.match(state.root.getElementById('morningTitle').textContent,/Dell/);
 assert.doesNotMatch(state.win.localStorage.getItem('doctorcre:morning:joe'),/Demo|lease/);
});
test('failed and malformed reads do not consume daily opening, supported refresh recovers automatically',async t=>{
 const state=setup(t,{read:()=>({ok:true})});await state.ui.refresh();assert.equal(state.root.querySelector('dialog').open,false);assert.equal(state.win.localStorage.length,0);
 state.client.morningBrief=async()=>payload();await state.ui.refresh();assert.equal(state.root.querySelector('dialog').open,true);
 state.client.morningBrief=async()=>{throw Error();};await state.ui.refresh();assert.equal(state.root.querySelectorAll('[data-brief-record]').length,0);assert.equal(state.root.getElementById('morningListen').disabled,true);
 state.client.morningBrief=async()=>payload();await state.ui.refresh();assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);
});
test('manual fixture preview does not auto-open; exact record popup with original entry details and late-result guard',async t=>{
 const state=setup(t,{automatic:false});await state.ui.refresh();assert.equal(state.root.querySelector('dialog').open,false);state.ui.open();
 state.root.querySelector('[data-brief-record]').click();await new Promise(resolve=>setTimeout(resolve,10));
 assert.match(state.root.getElementById('morningTitle').textContent,/Demo a/);assert.match(state.root.querySelector('details').textContent,/Original demo note/);
 state.root.getElementById('morningBack').click();assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);
 let release;state.client.getDeal=()=>new Promise(resolve=>release=resolve);state.root.querySelector('[data-brief-record]').click();state.root.getElementById('morningBack').click();release({deal:deal(),thread:[]});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);
});
test('speech is opt-in, user-triggered, same transcript, stops on dismiss/off/hidden, error permits replay',async t=>{
 const state=setup(t);const calls=[];state.win.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};state.win.speechSynthesis={speak:value=>calls.push(value),cancel:()=>calls.push('cancel')};
 // Capabilities are inspected when mounted, so mount this test after installing the adapter.
 state.ui.dispose();const ui=mountMorningBrief({document:state.root,window:state.win,getClient:async()=>state.client,automatic:true,now:()=>now});t.after(()=>ui.dispose());await ui.refresh();
 assert.deepEqual(calls,[]);state.root.getElementById('morningSpeech').click();state.root.getElementById('morningListen').click();assert.equal(calls.length,1);assert.equal(calls[0].text,morningBriefView(payload(),{...options,events:[]}).spoken);
 state.root.getElementById('morningSpeech').click();assert.equal(calls.at(-1),'cancel');assert.equal(state.root.getElementById('morningListen').disabled,true);
 state.root.getElementById('morningSpeech').click();state.root.getElementById('morningListen').click();calls.at(-1).onerror();assert.equal(state.root.getElementById('morningListen').textContent,'▶');
 const old=calls[0];state.root.getElementById('morningListen').click();old.onend();assert.equal(state.root.getElementById('morningListen').textContent,'■');
 state.root.getElementById('morningClose').click();assert.equal(calls.at(-1),'cancel');
});

test('overnight transport starts at cutoff and preserves server cursors without replaying historical pages',async()=>{
 const paths=[];const client=createLiveClient({fetchImpl:async(path)=>{paths.push(path);return new Response(JSON.stringify({events:[],cursor:'opaque-next'}));}});
 await client.getChanges(null,{since});await client.getChanges('opaque-next',{since});
 const cursor=new URL(paths[0],'http://localhost').searchParams.get('cursor');
 const decoded=JSON.parse(Buffer.from(cursor,'base64url').toString());
 assert.deepEqual(decoded,{recorded_at:since,id:'00000000-0000-0000-0000-000000000000'});
 assert.equal(new URL(paths[1],'http://localhost').searchParams.get('cursor'),'opaque-next');
});
test('queued online refresh during an in-flight read gets fresh facts without a manual retry',async t=>{
 const state=setup(t);await state.ui.refresh();let release;state.client.morningBrief=()=>new Promise(resolve=>release=resolve);
 const pending=state.ui.refresh();await Promise.resolve();await Promise.resolve();state.win.dispatchEvent(new state.win.Event('online'));
 state.client.morningBrief=async()=>{const value=payload();value.sections.today.items[0].what='Updated demo commitment';return value;};
 release(payload());await pending;await new Promise(resolve=>setTimeout(resolve,20));
 assert.match(state.root.getElementById('morningContent').textContent,/Updated demo commitment/);
});
test('background record refresh preserves expanded original and focused Details',async t=>{
 const state=setup(t);await state.ui.refresh();state.root.querySelector('[data-brief-record]').click();await new Promise(resolve=>setTimeout(resolve,10));
 const details=state.root.querySelector('details');details.open=true;details.querySelector('summary').focus();await state.ui.refresh();
 assert.equal(state.root.querySelector('details').open,true);assert.equal(state.root.activeElement.tagName,'SUMMARY');
});

test('opening while loading consumes the day only when live facts arrive; dismiss stays dismissed',async t=>{
 let release;const state=setup(t,{read:()=>new Promise(resolve=>release=resolve)});state.ui.open();await Promise.resolve();await Promise.resolve();
 assert.equal(state.win.localStorage.length,0);release(payload());await state.ui.refresh();state.root.getElementById('morningClose').click();
 state.client.morningBrief=async()=>payload();await state.ui.refresh();assert.equal(state.root.querySelector('dialog').open,false);
 assert.equal(JSON.parse(state.win.localStorage.getItem('doctorcre:morning:joe')).day,day);
});

test('late refused detail cannot clear a newer brief after returning to its cards',async t=>{
 const state=setup(t);await state.ui.refresh();let reject;state.client.getDeal=()=>new Promise((_,fail)=>reject=fail);
 state.root.querySelector('[data-brief-record]').click();state.root.getElementById('morningBack').click();
 reject(Object.assign(Error('Refused'),{status:403}));await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);assert.match(state.root.getElementById('morningTitle').textContent,/Joe/);
});
