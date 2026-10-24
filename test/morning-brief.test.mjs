import { briefPreferences } from '../js/brief-preferences.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { morningBriefView, validBrief, localDay } from '../js/morning-brief-model.js';
import { mountMorningBrief } from '../js/morning-brief.js';
import { createLiveClient } from '../js/live-client.js';
import { createFixtureClient } from '../js/fixture-client.js';
import { readFile } from 'node:fs/promises';
const now = new Date(2026,9,3,8), day = localDay(now), since = new Date(2026,9,2,17).toISOString();
const section = items => ({state:items.length ? 'ready':'empty',items});
const due = (id='a',owner='joe',date=day) => ({id:`action-${id}`,subject_type:'deal',subject_id:id,what:'Review demo lease comments',owner,due_on:date});
const deal = (id='a',owner='joe') => ({id,name:`Demo ${id}`,owner,operating_state:'active',phase:'legal'});
function payload() { return {sponsor:'joe',sections:{today:section([due(),due('b')]),deals:section([deal(),deal('b'),deal('c')]),loops:section([])}}; }
const event = (id='c',stamp=now.toISOString()) => ({id:`event-${id}`,subject_type:'deal',subject_id:id,recorded_at:stamp,field:'next_step',new_value:'Review demo terms',old_value:'Wait'});
const options = {now,since,events:[event()],caughtUp:true};

test('a short evidence-linked first action, overnight change and today item; duplicates and unadmitted deals excluded',()=>{
 const data=payload();data.sections.today.items.push(due('a'));
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
function setup(t,{storage,read}={}) {
 const dom=new JSDOM('<button id="docOpen">Doc</button><button id="docMorning">Morning brief</button>',{url:'http://localhost'});t.after(()=>dom.window.close());
 const {window:win}=dom,root=win.document;
 win.HTMLDialogElement.prototype.showModal=function(){this.open=true;};win.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new win.Event('close'));};
 if(storage)for(const [key,value]of storage)win.localStorage.setItem(key,value);
 let data=payload(),count=0,current=now,fail=false;
 const client={morningBrief:async()=>{count++;if(fail)throw Error('Offline');return read ? read():data;},getChanges:async()=>({events:[],cursor:'end'}),getDeal:async id=>({deal:deal(id),thread:[{id:'demo-note',text:'Demo short note. Original demo note continues.'}]}),readLoop:async args=>({loop:{number:args.number,kind:args.kind,title:'Demo task',status:'open',body:'Demo task entry.'}})};
 const ui=mountMorningBrief({document:root,window:win,getClient:async()=>client,intervalMs:100000,now:()=>current});t.after(()=>ui.dispose());
 return {ui,root,win,client,get count(){return count;},set data(value){data=value;},set current(value){current=value;},set fail(value){fail=value;}};
}
test('the brief never opens itself; an unseen cue shows once per day until opened, then returns the next day',async t=>{
 const state=setup(t);const dialog=()=>state.root.querySelector('dialog'),cue=()=>state.root.getElementById('docOpen').hasAttribute('data-brief-unseen');
 await state.ui.refresh();assert.equal(dialog().open,false);assert.equal(cue(),true);assert.match(state.root.getElementById('docMorning').textContent,/new today/);
 state.root.getElementById('docMorning').click();await state.ui.refresh();assert.equal(dialog().open,true);assert.equal(cue(),false);assert.equal(state.root.getElementById('docMorning').textContent,'Morning brief');
 state.root.getElementById('morningClose').click();await state.ui.refresh();assert.equal(dialog().open,false);assert.equal(cue(),false);
 state.current=new Date(2026,9,3,8,1);await state.ui.open();
 assert.equal(JSON.parse(state.win.localStorage.getItem('doctorcre:morning:joe')).lastShownAt,new Date(2026,9,3,8,1).toISOString());
 state.root.getElementById('morningClose').click();
 state.current=new Date(2026,9,4,8);await state.ui.refresh();assert.equal(dialog().open,false);assert.equal(cue(),true);
 const other=payload();other.sponsor='dell';other.sections.today=section([due('d','dell')]);state.data=other;await state.ui.refresh();await state.ui.open();assert.match(state.root.getElementById('morningTitle').textContent,/Dell/);
 assert.doesNotMatch(state.win.localStorage.getItem('doctorcre:morning:joe'),/Demo|lease/);
});
test('failed and malformed reads do not consume daily opening, supported refresh recovers automatically',async t=>{
 const state=setup(t,{read:()=>({ok:true})});await state.ui.refresh();assert.equal(state.root.getElementById('docOpen').hasAttribute('data-brief-unseen'),false);assert.equal(state.win.localStorage.length,0);
 state.client.morningBrief=async()=>payload();await state.ui.refresh();assert.equal(state.root.getElementById('docOpen').hasAttribute('data-brief-unseen'),true);
 state.client.morningBrief=async()=>{throw Error();};await state.ui.refresh();assert.equal(state.root.querySelectorAll('[data-brief-record]').length,0);assert.equal(state.root.getElementById('morningListen').disabled,true);
 state.client.morningBrief=async()=>payload();await state.ui.refresh();assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);
});
test('exact record popup with original entry details and late-result guard',async t=>{
 const state=setup(t);await state.ui.refresh();await state.ui.open();
 state.root.querySelector('[data-brief-record]').click();await new Promise(resolve=>setTimeout(resolve,10));
 assert.match(state.root.getElementById('morningTitle').textContent,/Demo a/);assert.match(state.root.querySelector('details').textContent,/Original demo note/);
 state.root.getElementById('morningBack').click();assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);
 let release;state.client.getDeal=()=>new Promise(resolve=>release=resolve);state.root.querySelector('[data-brief-record]').click();state.root.getElementById('morningBack').click();release({deal:deal(),thread:[]});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);
});
test('speech is opt-in, user-triggered, same transcript, stops on dismiss/off/hidden, error permits replay',async t=>{
 const state=setup(t);const calls=[];state.win.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};state.win.speechSynthesis={speak:value=>calls.push(value),cancel:()=>calls.push('cancel')};
 // Capabilities are inspected when mounted, so mount this test after installing the adapter.
 state.ui.dispose();const ui=mountMorningBrief({document:state.root,window:state.win,getClient:async()=>state.client,now:()=>now});t.after(()=>ui.dispose());await ui.refresh();await ui.open();
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
 let release,started;const reading=new Promise(resolve=>started=resolve);const state=setup(t,{read:()=>new Promise(resolve=>{release=resolve;started();})});const opening=state.ui.open();await reading;
 assert.equal(state.win.localStorage.length,0);release(payload());await opening;state.root.getElementById('morningClose').click();
 state.client.morningBrief=async()=>payload();await state.ui.refresh();assert.equal(state.root.querySelector('dialog').open,false);
 assert.equal(JSON.parse(state.win.localStorage.getItem('doctorcre:morning:joe')).day,day);
});

test('late refused detail cannot clear a newer brief after returning to its cards',async t=>{
 const state=setup(t);await state.ui.refresh();let reject;state.client.getDeal=()=>new Promise((_,fail)=>reject=fail);
 state.root.querySelector('[data-brief-record]').click();state.root.getElementById('morningBack').click();
 reject(Object.assign(Error('Refused'),{status:403}));await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);assert.match(state.root.getElementById('morningTitle').textContent,/Joe/);
});

test('task card opens the exact live record directly without a retired route',async t=>{
 const state=setup(t);const data=payload();data.sections.today=section([]);data.sections.loops=section([{number:'7',kind:'open_loop',owner:'joe',title:'Demo due task',status:'open',due_on:day}]);state.data=data;
 const reads=[];state.client.readLoop=async args=>{reads.push(args);return {loop:{...args,title:'Demo due task',status:'open',body:'Demo original task entry. <script>demo</script>',blocker_detail:'Demo distinct blocker.'}};};
 await state.ui.refresh();const card=state.root.querySelector('[data-brief-record]');assert.equal(card.tagName,'BUTTON');assert.equal(card.getAttribute('href'),null);card.click();
 await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(reads,[{number:'7',kind:'open_loop'}]);assert.match(state.root.getElementById('morningContent').textContent,/Demo original task entry/);
 assert.equal(state.root.querySelector('.entry-original').textContent,'Demo original task entry. <script>demo</script>');assert.equal(state.root.querySelector('#morningContent script'),null);
});

test('producer label identifies due tasks with a null title',()=>{
 const data=payload();data.sections.today=section([]);data.sections.loops=section([{number:'7',kind:'open_loop',status:'open',owner:'joe',title:null,label:'Demo labelled task',due_on:day}]);
 assert.equal(morningBriefView(data,{...options,events:[]}).groups[0]?.row.title,'Demo labelled task');
});
test('producer-admitted uppercase owners stay visible and selected across refresh',async t=>{
 const state=setup(t);const data=payload();data.sections.today=section([due('a','JOE')]);data.sections.deals=section([deal('a','JOE')]);data.sections.loops=section([{number:'7',kind:'open_loop',status:'open',owner:'JOE',title:'Demo admitted task',due_on:day}]);
 assert.deepEqual(morningBriefView(data,{...options,events:[]}).groups.map(group=>group.row.id),['a','7']);state.data=data;
 state.client.getDeal=async()=>({deal:deal('a','JOE'),thread:[]});await state.ui.refresh();state.root.querySelector('[data-brief-record]').click();await new Promise(resolve=>setTimeout(resolve,10));await state.ui.refresh();assert.ok(state.root.querySelector('.morning-record'));
 state.root.getElementById('morningBack').click();state.root.querySelectorAll('[data-brief-record]')[1].click();await new Promise(resolve=>setTimeout(resolve,10));await state.ui.refresh();assert.ok(state.root.querySelector('.morning-record'));
 data.sections.loops=section([]);await state.ui.refresh();assert.equal(state.root.querySelector('.morning-record'),null);
});
test('a caught-up poll does not truncate later full pages; each refresh must reach the end',async t=>{
 const state=setup(t);await state.ui.refresh();let reads=0;
 const older=event('c',new Date(now.valueOf()-10000).toISOString()),newer={...event('c'),id:'newer',new_value:'Newest demo change'};
 state.client.getChanges=async()=>({events:[[older],[newer],[]][reads++],cursor:`page-${reads}`});await state.ui.refresh();
 assert.equal(reads,3);assert.match(state.root.getElementById('morningContent').textContent,/Newest demo change/);assert.equal(state.root.getElementById('morningCoverage').textContent,'');
 state.client.getChanges=async()=>({events:[{...newer,id:`budget-${reads++}`}],cursor:`page-${reads}`});await state.ui.refresh();
 assert.equal(reads,7);assert.match(state.root.getElementById('morningCoverage').textContent,/Overnight updates unavailable/);assert.doesNotMatch(state.root.getElementById('morningContent').textContent,/Newest demo change/);
});
test('earlier non-deal commitments rank first and retain exact action identity',()=>{
 const data=payload(),action={...due('person-a','JOE','2026-10-01'),item_kind:'next_action',subject_type:'person',subject_name:'Demo Contact',subject_ref:'P-DEMO'};data.sections.today.items.push(action);
 const first=morningBriefView(data,{...options,events:[]}).groups[0]?.row;assert.equal(first?.kind,'action');assert.equal(first.id,action.id);assert.equal(first.title,'Demo Contact');
 data.sections.today=section([action]);data.sections.deals=section([]);assert.equal(morningBriefView(data,{...options,events:[]}).groups.length,1);
});
test('non-deal action card opens and refreshes its exact admitted record, then exits when removed',async t=>{
 const state=setup(t),data=payload(),action={...due('person-a','joe','2026-10-01'),item_kind:'next_action',subject_type:'person',subject_name:'Demo Contact',subject_ref:'P-DEMO'};data.sections.today=section([action]);state.data=data;
 let wrongReads=0;state.client.getDeal=state.client.readLoop=async()=>{wrongReads++;throw Error('Wrong record');};await state.ui.refresh();state.root.querySelector('[data-brief-record]')?.click();await new Promise(resolve=>setTimeout(resolve,10));
 assert.ok(state.root.querySelector('.morning-record'));assert.match(state.root.querySelector('.entry-original').textContent,/Review demo lease comments/);assert.match(state.root.getElementById('morningContent').textContent,/P-DEMO/);assert.equal(wrongReads,0);
 action.what='Updated demo personal commitment';await state.ui.refresh();assert.match(state.root.querySelector('.entry-original').textContent,/Updated demo personal commitment/);
 data.sections.today=section([]);await state.ui.refresh();assert.equal(state.root.querySelector('.morning-record'),null);
});
for(const status of [401,403]) {
 test(`live changes preserves HTTP ${status} without reading a diagnostic body`,async()=>{
  let bodyRead=false;const response=new Response('Demo diagnostic',{status});const arrayBuffer=response.arrayBuffer.bind(response);response.arrayBuffer=()=>{bodyRead=true;return arrayBuffer();};response.json=()=>{bodyRead=true;return new Promise(()=>{});};const client=createLiveClient({fetchImpl:async()=>response});
  await assert.rejects(client.getChanges(null),error=>error.status===status);assert.equal(bodyRead,false);
 });
 test(`changes HTTP ${status} clears facts and speech and does not consume a daily opening`,async t=>{
  const state=setup(t,{storage:[['doctorcre:morning:joe',JSON.stringify({speech:true})]]});state.ui.dispose();const calls=[];state.win.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};state.win.speechSynthesis={speak:value=>calls.push(value),cancel:()=>calls.push('cancel')};
  state.client.getChanges=async()=>{throw Object.assign(Error('Denied'),{status});};const ui=mountMorningBrief({document:state.root,window:state.win,getClient:async()=>state.client,now:()=>now});t.after(()=>ui.dispose());await ui.refresh();
  assert.equal(state.root.querySelectorAll('[data-brief-record]').length,0);assert.equal(state.root.getElementById('morningListen').disabled,true);assert.equal(JSON.parse(state.win.localStorage.getItem('doctorcre:morning:joe')).day,undefined);
  state.client.getChanges=async()=>({events:[],cursor:'end'});await ui.refresh();state.root.getElementById('morningListen').click();assert.equal(calls.length,1);
  state.client.getChanges=async()=>{throw Object.assign(Error('Denied'),{status});};await ui.refresh();assert.equal(calls.at(-1),'cancel');assert.equal(state.root.querySelectorAll('[data-brief-record]').length,0);assert.equal(state.root.getElementById('morningListen').disabled,true);assert.doesNotMatch(state.root.querySelector('dialog').textContent,/Demo/);
 });
}
test('ordinary changes network failure retains supported priorities with unavailable overnight coverage',async t=>{
 const state=setup(t);state.client.getChanges=async()=>{throw Error('Offline');};await state.ui.refresh();assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);assert.match(state.root.getElementById('morningCoverage').textContent,/Overnight updates unavailable/);
});

test('owner toggle filters before ranking, labels both partners, and retains unowned and older-server rows', async t=>{
 const state=setup(t),data=payload();
 data.sections.today=section([
  {...due('a','joe','2026-10-02'),owner_partner:'joe'},
  {...due('d','dell','2026-10-02'),item_kind:'next_action',subject_name:'Demo Dell deal',owner_partner:'dell'},
  {...due('b'),owner_partner:null},
 ]);
 state.data=data;await state.ui.refresh();await state.ui.open();
 const labels=()=>[...state.root.querySelectorAll('.morning-owner')].map(node=>node.textContent);
 assert.deepEqual(labels(),['Joe','Dell']);
 const filter=state.root.querySelector('[aria-label="Brief owners"]');assert.ok(filter);
 assert.equal(filter.querySelector('[aria-pressed="true"]').textContent,'All');
 filter.querySelector('[data-brief-owner="dell"]').click();
 assert.deepEqual(labels(),['Dell']);
 assert.match(state.root.querySelector('#morningContent > section').textContent,/Do first.*Demo Dell deal/);
 assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);
 state.root.querySelector('[data-brief-record]').click();await new Promise(resolve=>setTimeout(resolve,10));
 assert.match(state.root.querySelector('.entry-original').textContent,/Review demo lease/);
 state.root.getElementById('morningBack').click();
 filter.querySelector('[data-brief-owner="joe"]').click();assert.deepEqual(labels(),['Joe']);
 await state.ui.refresh();assert.deepEqual(labels(),['Joe']);
 for(const row of data.sections.today.items)delete row.owner_partner;
 await state.ui.refresh();assert.deepEqual(labels(),[]);assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);
});

test('two partners retain separate to-dos on the same deal',()=>{
 const data=payload();data.sections.today=section([
  {...due('a'),id:'joe-action',owner_partner:'joe',what:'Demo Joe step'},
  {...due('a','dell'),id:'dell-action',owner_partner:'dell',what:'Demo Dell step'},
 ]);
 const view=morningBriefView(data,{...options,events:[]});
 assert.deepEqual(view.groups.map(group=>group.row.owner_partner),['dell','joe']);
 assert.equal(new Set(view.groups.map(group=>group.row.key)).size,2);
});

test('owner selection survives reload and switches independently with the viewer', async t => {
 const state=setup(t);await state.ui.refresh();
 state.root.querySelector('#morningOwners [data-brief-owner="dell"]').click();await state.ui.open();
 const saved=Array.from({length:state.win.localStorage.length},(_,i)=>{const key=state.win.localStorage.key(i);return [key,state.win.localStorage.getItem(key)];});
 const reloaded=setup(t,{storage:saved});await reloaded.ui.refresh();
 const selected=()=>reloaded.root.querySelector('#morningOwners [aria-pressed="true"]').textContent;
 assert.equal(selected(),'Dell');
 const other=payload();other.sponsor='dell';reloaded.data=other;await reloaded.ui.refresh();
 assert.equal(selected(),'All');
 reloaded.root.querySelector('#morningOwners [data-brief-owner="joe"]').click();
 reloaded.data=payload();await reloaded.ui.refresh();assert.equal(selected(),'Dell');
 reloaded.data=other;await reloaded.ui.refresh();assert.equal(selected(),'Joe');
 assert.deepEqual(saved.map(([key])=>key),['doctorcre:morning:joe']);
 assert.doesNotMatch(saved[0][1],/Demo|lease/);
});

test('shared deal detail follows the selected action through refresh and removal', async t => {
 const state=setup(t),data=payload();
 data.sections.today=section(['joe','dell'].map(owner=>({...due('a'),id:`action-${owner}`,item_kind:'next_action',owner_partner:owner,what:`${owner} confirms access`})));
 state.data=data;await state.ui.refresh();await state.ui.open();
 state.root.querySelector('#morningOwners [data-brief-owner="dell"]').click();
 const view=morningBriefView(data,{...options,owner:'dell',events:[]});
 assert.equal(view.groups[0].row.action.id,'action-dell');
 state.root.querySelector('[data-brief-record]').click();await new Promise(resolve=>setTimeout(resolve,10));
 assert.match(state.root.getElementById('morningContent').textContent,/dell confirms access/);
 assert.doesNotMatch(state.root.getElementById('morningContent').textContent,/joe confirms access/);
 data.sections.today.items[1].what='Dell sends access confirmation';await state.ui.refresh();
 assert.match(state.root.getElementById('morningContent').textContent,/Dell sends access confirmation/);
 data.sections.today.items.pop();await state.ui.refresh();
 assert.equal(state.root.getElementById('morningBack').hidden,true);
});

test('empty partner filter explains the result and Show all restores to-dos', async t => {
 const state=setup(t),data=payload();
 for(const row of data.sections.today.items)row.owner_partner='joe';
 state.data=data;await state.ui.refresh();await state.ui.open();
 state.root.querySelector('#morningOwners [data-brief-owner="dell"]').click();
 const content=state.root.getElementById('morningContent');
 assert.match(content.textContent,/No to-dos for Dell/);
 const showAll=[...content.querySelectorAll('button')].find(node=>node.textContent==='Show all');assert.ok(showAll);
 showAll.focus();showAll.click();
 assert.equal(state.root.querySelector('#morningOwners [aria-pressed="true"]').textContent,'All');
 assert.equal(content.querySelectorAll('[data-brief-record]').length,2);
 assert.equal(state.root.activeElement.dataset.briefOwner,'all');
});

test('older brief rows without action ids retain separate deal cards and all three groups', () => {
 const data=payload();for(const row of data.sections.today.items)delete row.id;
 assert.deepEqual(morningBriefView(data,options).groups.map(group=>[group.label,group.row.id]),[['Do first','a'],['Overnight','c'],['Today','b']]);
});

for (const selfActor of ['joe','dell']) test(`fixture All keeps four Joe and four Dell next actions for ${selfActor}`, async () => {
 const seed=await readFile(new URL('../data/board-seed.json',import.meta.url));
 const client=await createFixtureClient({selfActor,seedUrl:`data:application/json;base64,${seed.toString('base64')}`});
 const brief=await client.morningBrief();
 const rows=brief.sections.today.items.filter(row=>row.item_kind==='next_action');
 assert.deepEqual(['joe','dell'].map(owner=>rows.filter(row=>row.owner===owner).length),[4,4]);
 assert.equal(brief.sponsor,selfActor);
 const admitted=new Set(brief.sections.deals.items.map(row=>row.id));
 assert.ok(rows.every(row=>admitted.has(row.subject_id)));
});

test('Overnight stays identical for All, Joe and Dell when their first priorities differ', () => {
 const data=payload();
 data.sections.today=section([
  {...due('a','joe','2026-10-01'),owner_partner:'joe'},
  {...due('b','dell','2026-10-02'),owner_partner:'dell'},
 ]);
 const settings={...options,events:[event('a'),event('b',new Date(now.valueOf()-1000).toISOString()),event('c',new Date(now.valueOf()-2000).toISOString())]};
 const views=['all','joe','dell'].map(owner=>morningBriefView(data,{...settings,owner}));
 assert.deepEqual(views.map(view=>view.groups.find(group=>group.key==='first').row.id),['a','a','b']);
 const overnight=views.map(view=>view.groups.find(group=>group.key==='overnight'));
 assert.equal(overnight[0].row.id,'b');
 assert.deepEqual(overnight[1],overnight[0]);
 assert.deepEqual(overnight[2],overnight[0]);
});

for (const nextSponsor of ['joe','dell']) test(`F4 suspended brief clears detail and fences late reads before ${nextSponsor} recovery`, async t => {
 const state=setup(t);await state.ui.refresh();await state.ui.open();
 let detailDone;state.client.getDeal=()=>new Promise(resolve=>detailDone=resolve);
 state.root.querySelector('[data-brief-record]').click();await Promise.resolve();
 let oldDone;state.client.morningBrief=()=>new Promise(resolve=>oldDone=resolve);
 const oldRead=state.ui.refresh();await Promise.resolve();await Promise.resolve();
 Object.defineProperty(state.root,'visibilityState',{configurable:true,value:'hidden'});
 state.root.dispatchEvent(new state.win.Event('visibilitychange'));
 assert.equal(state.root.getElementById('morningContent').textContent,'');
 assert.equal(state.root.getElementById('morningListen').disabled,true);
 assert.equal(state.root.getElementById('morningBack').hidden,true);
 detailDone({deal:deal(),thread:[{text:'Demo obsolete detail'}]});oldDone(payload());await oldRead;
 assert.doesNotMatch(state.root.getElementById('morningContent').textContent,/Demo/);
 assert.equal(state.root.getElementById('morningTitle').textContent,'Morning brief');
 let resumed;state.client.morningBrief=()=>new Promise(resolve=>resumed=resolve);
 Object.defineProperty(state.root,'visibilityState',{configurable:true,value:'visible'});
 state.root.dispatchEvent(new state.win.Event('visibilitychange'));
 await Promise.resolve();await Promise.resolve();
 state.root.getElementById('morningClose').click();const reopened=state.ui.open();
 assert.equal(state.root.querySelectorAll('[data-brief-record]').length,0);
 const next=payload();next.sponsor=nextSponsor;state.client.morningBrief=async()=>next;resumed(next);await reopened;
 assert.match(state.root.getElementById('morningTitle').textContent,new RegExp(nextSponsor==='joe'?'Joe':'Dell'));
 assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);
});

test('F4 resume timeout leaves facts unavailable and keeps only sponsor preferences for recovery',async t=>{
 const state=setup(t,{storage:[['doctorcre:morning:joe',JSON.stringify({speech:true})]]});await state.ui.refresh();await state.ui.open();
 let fail;state.client.morningBrief=()=>new Promise((resolve,reject)=>fail=reject);
 state.win.dispatchEvent(new state.win.Event('online'));await Promise.resolve();await Promise.resolve();
 assert.equal(state.root.querySelectorAll('[data-brief-record]').length,0);
 fail(Object.assign(Error('Read timed out'),{code:'read_timeout'}));await state.ui.refresh();
 assert.equal(state.root.querySelectorAll('[data-brief-record]').length,0);assert.equal(state.root.getElementById('morningListen').disabled,true);
 assert.equal(JSON.parse(state.win.localStorage.getItem('doctorcre:morning:joe')).speech,true);
 state.client.morningBrief=async()=>payload();await state.ui.refresh();assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);
});

test('F4 reopening during a queued resume read replaces that read with current facts', async t => {
 const state=setup(t);await state.ui.refresh();
 const releases=[],starts=[];
 const started=Array.from({length:2},(_,index)=>new Promise(resolve=>starts[index]=resolve));
 state.client.morningBrief=()=>new Promise(resolve=>{const index=releases.length;releases.push(resolve);starts[index]?.();});
 const old=state.ui.refresh();await started[0];
 state.win.dispatchEvent(new state.win.Event('online'));await started[1];
 const fresh=payload();fresh.sections.today.items[0].what='Current demo commitment';
 state.client.morningBrief=async()=>fresh;
 const opening=state.ui.open();
 assert.equal(state.root.getElementById('morningContent').textContent,'');
 releases.forEach(release=>release(payload()));await old;await opening;
 assert.match(state.root.getElementById('morningContent').textContent,/Current demo commitment/);
});
