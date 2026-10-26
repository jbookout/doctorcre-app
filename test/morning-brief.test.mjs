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
 assert.ok(view.groups.every(group => group.row.summary.split(/\s+/).length <= 10));
 assert.match(view.coverage.find(row=>row.key==='needs_joe').description,/Needs Joe.*unavailable/);
 assert.equal(view.unavailable.length,0);
 assert.deepEqual(morningBriefView(data,{...options,events:[event('d')]}).groups.map(group=>group.key),['first','today']);
});
test('priority titles preserve the complete business instruction for deals, tasks and actions',()=>{
 const title='Review the synthetic lease renewal terms with the practice owner before signing';
 const data=payload();
 data.sections.deals.items.forEach(row=>{row.name=title;});
 data.sections.today.items[0].what='Review the synthetic lease renewal comments and send the proposed revisions to the practice owner';
 let view=morningBriefView(data,options);
 assert.deepEqual(view.groups.map(group=>group.row.title),[title,title,title]);
 assert.equal(view.groups[0].row.summary,'Review the synthetic lease renewal comments and send the proposed…');
 data.sections.today=section([]);
 data.sections.loops=section([{number:'1',kind:'open_loop',title,status:'open',due_on:day}]);
 assert.equal(morningBriefView(data,{...options,events:[]}).groups[0].row.title,title);
 data.sections.loops=section([]);
 data.sections.today=section([{id:'demo-action',item_kind:'post_call_action',what:title,due_on:day}]);
 assert.equal(morningBriefView(data,{...options,events:[]}).groups[0].row.title,title);
});
test('priority summaries omit repeated titles before shortening and retain distinct instructions',()=>{
 const title='Review the synthetic lease renewal terms with the practice owner before signing';
 for(const [name,summary,expected] of [
  ['Confirm access','Confirm access',''],
  [title,title,''],
  ['  Confirm   access  ','Confirm\naccess',''],
  [title,'Review the synthetic lease renewal terms with the practice owner after signing','Review the synthetic lease renewal terms with the practice owner…'],
  ['Confirm access',undefined,''],
 ]){
  const data=payload();data.sections.today=section([]);data.sections.loops=section([{number:'1',kind:'open_loop',title:name,status:'open',due_on:day,blocker_detail:summary}]);
  const original=structuredClone(data);
  const row=morningBriefView(data,{...options,events:[]}).groups[0].row;
  assert.equal(row.summary,expected);assert.deepEqual(data,original);
 }
 const data=payload();data.sections.today=section([{id:'demo-action',item_kind:'post_call_action',what:title,due_on:day}]);
 assert.equal(morningBriefView(data,{...options,events:[]}).groups[0].row.summary,'');
 data.sections.deals.items[0].name='Review demo lease comments';data.sections.today=section([due()]);
 assert.equal(morningBriefView(data,{...options,events:[]}).groups[0].row.summary,'');
});
test('empty sections omitted; unknown coverage never becomes all-clear or filler',()=>{
 const data=payload();for(const key of Object.keys(data.sections))data.sections[key]=section([]);
 assert.deepEqual(morningBriefView(data,{...options,events:[]}).groups,[]);
 assert.match(morningBriefView(data,{...options,events:[]}).coverage.find(row=>row.key==='needs_joe').description,/Needs Joe.*unavailable/);
 data.sections.today={state:'unavailable',items:[]};
 const view=morningBriefView(data,{...options,caughtUp:false});
 assert.equal(view.groups.length,0);assert.deepEqual(view.unavailable,['Today’s priorities unavailable','Overnight updates unavailable']);
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
 const joe=briefPreferences(storage,'joe');joe.save({day,since});
 assert.equal(briefPreferences(storage,'dell').value.day,undefined);assert.equal(briefPreferences(storage,'joe').value.day,day);
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
 state.client.morningBrief=async()=>{throw Error();};await state.ui.refresh();assert.equal(state.root.querySelectorAll('[data-brief-record]').length,0);
 state.client.morningBrief=async()=>payload();await state.ui.refresh();assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);
});
test('exact record popup with original entry details and late-result guard',async t=>{
 const state=setup(t);await state.ui.refresh();await state.ui.open();
 state.root.querySelector('[data-brief-record]').click();await new Promise(resolve=>setTimeout(resolve,10));
 assert.match(state.root.getElementById('morningTitle').textContent,/Demo a/);assert.match(state.root.querySelector('details').textContent,/Original demo note/);
 state.root.getElementById('morningBack').click();assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);
 let release;state.client.getDeal=()=>new Promise(resolve=>release=resolve);state.root.querySelector('[data-brief-record]').click();state.root.getElementById('morningBack').click();release({deal:deal(),thread:[]});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);
});
test('brief header has no inert Doc emblem and keeps its heading and dismiss control',async t=>{
 const state=setup(t);await state.ui.refresh();state.root.getElementById('docMorning').focus();await state.ui.open();
 const dialog=state.root.querySelector('dialog');
 assert.doesNotMatch(dialog.querySelector('header').textContent,/◍/);
 assert.equal(state.root.getElementById('morningTitle').textContent,'Morning brief · Joe');
 state.root.getElementById('morningClose').click();assert.equal(dialog.open,false);
 assert.equal(state.root.activeElement,state.root.getElementById('docMorning'));
 state.root.getElementById('docMorning').click();await state.ui.refresh();assert.equal(dialog.open,true);
});
test('brief stays readable without narration controls or speech calls, including a saved speech preference',async t=>{
 const state=setup(t,{storage:[['doctorcre:morning:joe',JSON.stringify({speech:true})]]});state.ui.dispose();const calls=[];
 state.win.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};state.win.speechSynthesis={speak:value=>calls.push(value),cancel:()=>calls.push('cancel')};
 const ui=mountMorningBrief({document:state.root,window:state.win,getClient:async()=>state.client,now:()=>now});t.after(()=>ui.dispose());
 await ui.refresh();await ui.open();
 assert.equal(state.root.querySelector('[aria-label="Brief speech"], [aria-label="Listen to morning brief"]'),null);
 assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);
 state.root.querySelector('[data-brief-record]').click();await new Promise(resolve=>setTimeout(resolve,10));assert.ok(state.root.querySelector('.morning-record'));
 state.root.getElementById('morningBack').click();await ui.refresh();assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);
 state.root.getElementById('morningClose').click();assert.equal(state.root.querySelector('dialog').open,false);assert.deepEqual(calls,[]);
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

test('task sheets show instructions as Your task and omit only the redundant open status',async t=>{
 const state=setup(t),data=payload();data.sections.today=section([]);
 const task={number:'7',kind:'open_loop',owner:'joe',title:'Demo due task',status:'open',due_on:day,blocker_detail:'Open <demo> and review the terms.',body:'Demo original task entry.'};
 data.sections.loops=section([{...task}]);state.data=data;state.client.readLoop=async()=>({loop:{...task}});
 await state.ui.refresh();state.root.querySelector('[data-brief-record]').click();await new Promise(resolve=>setTimeout(resolve,10));
 const facts=()=>[...state.root.querySelectorAll('.morning-record dl > div')].map(node=>[node.querySelector('dt').textContent,node.querySelector('dd').textContent]);
 assert.deepEqual(facts(),[['Due',day],['Your task','Open <demo> and review the terms.']]);
 assert.equal(state.root.querySelector('.morning-record demo'),null);
 assert.match(state.root.querySelector('.morning-record').textContent,/Demo original task entry/);
 for(const status of ['closed','unknown',null]){
  task.status=status;await state.ui.refresh();
  assert.deepEqual(facts(),[['Due',day],...(status?[['Status',status]]:[]),['Your task','Open <demo> and review the terms.']]);
 }
 state.root.getElementById('morningBack').click();assert.equal(state.root.activeElement.dataset.briefKey,'loop:open_loop:7');
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
 test(`changes HTTP ${status} clears facts and does not consume a daily opening`,async t=>{
  const state=setup(t);await state.ui.refresh();
  state.client.getChanges=async()=>{throw Object.assign(Error('Denied'),{status});};await state.ui.refresh();
  assert.equal(state.root.querySelectorAll('[data-brief-record]').length,0);assert.equal(state.win.localStorage.getItem('doctorcre:morning:joe'),null);
  state.client.getChanges=async()=>({events:[],cursor:'end'});await state.ui.refresh();assert.equal(state.root.querySelectorAll('[data-brief-record]').length,2);
  state.client.getChanges=async()=>{throw Object.assign(Error('Denied'),{status});};await state.ui.refresh();assert.equal(state.root.querySelectorAll('[data-brief-record]').length,0);assert.doesNotMatch(state.root.querySelector('dialog').textContent,/Demo/);
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
 assert.match(content.textContent,/No selected priority cards for Dell/);
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

function completeBrief() {
 const data=payload();
 for(const key of ['needs_joe','claim_card','renewals','assurance_cadence','costs']) data.sections[key]=section([]);
 data.coverage={schema:'morning-brief-coverage.v1',count_scope:'returned_rows_only',required_sections:Object.entries(data.sections).map(([key,value])=>({key,path:`/sections/${key}`,state:value.state,counts:{items:value.items.length},incomplete_sources:[]}))};
 return data;
}
test('F1 full brief coverage makes Needs Joe, accounts and providers reachable without an all-clear',async t=>{
 const state=setup(t),data=completeBrief();
 data.sections.today=section([]);data.sections.deals={...section([]),accounts:[{account_name:'Demo account portfolio'}]};
 data.sections.needs_joe=section([{key:'rule:demo',title:'Demo waiting decision',why:{text:'Needs a ruling'},action:'Approve the demo rule',blocks:{text:'Demo work blocked'}}]);
 data.sections.costs={state:'ready',items:[],providers:[{provider:'demo',mtd_usd:12,projection_usd:24,budget_usd:30,daily:[{date:day,usd:2}]}]};
 data.coverage.required_sections.forEach(entry=>{const value=data.sections[entry.key];entry.state=value.state;entry.counts=Object.fromEntries(['items','accounts','providers'].filter(key=>Array.isArray(value[key])).map(key=>[key,value[key].length]));});
 state.data=data;await state.ui.refresh();await state.ui.open();
 const content=state.root.getElementById('morningContent').textContent;
 assert.match(content,/Demo waiting decision/);assert.match(content,/Demo account portfolio/);assert.match(content,/12/);assert.doesNotMatch(content,/No to-dos/);
 assert.match(state.root.querySelector('[data-brief-section="needs_joe"] summary').textContent,/Needs Joe.*returned/);
 assert.equal(state.root.querySelector('[data-brief-section="needs_joe"] summary')?.tagName,'SUMMARY');
});
test('full brief task rows keep instructions and non-open statuses without redundant open labels',async t=>{
 const state=setup(t),data=completeBrief();
 data.sections.loops=section(['open','closed','unknown',null].map((status,index)=>({number:String(index+1),kind:'open_loop',status,title:'Demo task',blocker_detail:'Review <demo> terms.',body:'Demo task details.'})));
 state.data=data;await state.ui.open();
 const rows=[...state.root.querySelectorAll('[data-brief-section="loops"] li')];
 assert.equal(rows.length,4);
 rows.forEach((row,index)=>{
  assert.match(row.textContent,/Your task: Review <demo> terms\..*Details: Demo task details\./);
  assert.doesNotMatch(row.textContent,/Blocker:|Status: open/);
  if(index===1)assert.match(row.textContent,/Status: closed/);
  if(index===2)assert.match(row.textContent,/Status: unknown/);
  if(index===0||index===3)assert.doesNotMatch(row.textContent,/Status:/);
 });
 assert.equal(state.root.querySelector('[data-brief-section="loops"] demo'),null);
});

test('F2 every triage kind survives missing partner deal metadata in explicit full sections',async t=>{
 const state=setup(t),data=completeBrief();data.sections.deals=section([]);
 data.sections.today=section(['next_action','post_call_action','critical_date','ingest'].map((item_kind,index)=>({id:`demo-${index}`,item_kind,subject_type:'deal',subject_id:'private-demo-deal',subject_name:'Shared demo subject',owner_partner:'dell',what:`Demo ${item_kind}`,due_on:item_kind==='critical_date'?'2026-10-10':day})));
 state.data=data;let privateReads=0;state.client.getDeal=async()=>{privateReads++;throw Error('Private deal');};await state.ui.refresh();await state.ui.open();
 for(const kind of ['next_action','post_call_action','critical_date','ingest']) assert.match(state.root.getElementById('morningContent').textContent,new RegExp(`Demo ${kind}`));
 const view=morningBriefView(data,{...options,events:[]});assert.equal(view.groups[0]?.row.kind,'action');
 state.root.querySelector('[data-brief-record]')?.click();await new Promise(resolve=>setTimeout(resolve,10));assert.ok(state.root.querySelector('.morning-record'));assert.equal(privateReads,0);
});
test('F6 partial and missing required sources are visible using safe category names',async t=>{
 const state=setup(t),data=completeBrief();data.sections.needs_joe={state:'partial',items:[{title:'Demo surviving decision'}],sources:{work_requests:{state:'unavailable',error:'private-driver-demo'}}};
 const coverage=data.coverage.required_sections.find(row=>row.key==='needs_joe');Object.assign(coverage,{state:'partial',counts:{items:1},incomplete_sources:[{key:'work_requests',state:'unavailable'}]});
 state.data=data;await state.ui.refresh();
 assert.match(state.root.getElementById('morningContent').textContent,/partial.*Work requests unavailable/s);
 assert.doesNotMatch(state.root.querySelector('dialog').textContent,/private-driver-demo/);
 delete data.sections.renewals;await state.ui.refresh();assert.match(state.root.getElementById('morningContent').textContent,/Renewals.*unavailable/s);
});
test('F5 business day and initial overnight cutoff use Chicago under both DST offsets and transitions',async t=>{
 for(const [instant,expectedDay,cutoff] of [
 ['2026-10-24T01:00:00Z','2026-10-23','2026-10-22T22:00:00.000Z'],
 ['2026-01-24T01:00:00Z','2026-01-23','2026-01-22T23:00:00.000Z'],
 ['2026-03-08T13:00:00Z','2026-03-08','2026-03-07T23:00:00.000Z'],
 ['2026-11-01T14:00:00Z','2026-11-01','2026-10-31T22:00:00.000Z']]) {
 const state=setup(t);state.current=new Date(instant);const cutoffs=[];state.client.getChanges=async(_cursor,args)=>{cutoffs.push(args.since);return {events:[],cursor:'end'};};await state.ui.refresh();
 assert.equal(localDay(new Date(instant)),expectedDay);assert.equal(cutoffs.at(-1),cutoff);
 }
});

test('full sections retain producer-shaped notification reasons, decision links and cost evidence',async t=>{
 const state=setup(t),data=completeBrief();
 data.sections.assurance_cadence=section([{notification_id:'demo-notice',reason:'Demo release needs review',severity:'warning',subject_ref:'WR-DEMO',deep_link:'/work/requests/WR-DEMO',created_at:'2026-10-03T10:00:00Z'}]);
 data.sections.needs_joe=section([{title:'Demo decision',link:'https://github.com/example/demo/pull/1'}]);
 data.sections.costs={state:'partial',items:[],providers:[{provider:'demo',state:'partial',plan:'Demo plan',mtd_usd:12,daily:[{day,usd:2,drivers:{demo_driver:2}}]}],months:[{month:'2026-10',usd:12,providers:{demo_provider:12}}],alerts:[{provider:'demo',driver:'demo_driver',kind:'budget',amount_usd:12,threshold_usd:10}]};
 state.data=data;await state.ui.refresh();
 const content=state.root.getElementById('morningContent');
 for(const text of ['Demo release needs review','warning','Demo plan',day,'demo_driver','demo_provider','Threshold USD: 10'])assert.ok(content.textContent.includes(text),text);
 assert.equal(content.querySelector('a[href="https://github.com/example/demo/pull/1"]')?.textContent,'Open record');
 assert.equal(content.querySelector('a[href="/work/requests/WR-DEMO"]')?.textContent,'Open record');
 data.sections.needs_joe.items[0].link='javascript:alert(1)';await state.ui.refresh();assert.equal(content.querySelector('a[href^="javascript:"]'),null);
});

test('P2 producer renewals retain candidate identity and decision details with or without a lease date',async t=>{
 const state=setup(t),data=completeBrief();
 data.sections.renewals=section([
  {display_name:'Demo Doctor',org_name:'Demo Practice',vertical:'Dental',city:'Demo City',county:'Demo County',state:'AL',est_lease_event:'2027-03-01',tier_status:'qualified',flag_status:'review',has_channel:true,decision_count:3,source_observed_at:'2026-10-02T12:00:00Z',freshness_state:'fresh'},
  {display_name:'Demo Undated Doctor',org_name:'Demo Undated Practice',vertical:'Medical',city:'Demo Other City',county:'Demo Other County',state:'FL',est_lease_event:null,tier_status:'unqualified',flag_status:'clear',has_channel:false,decision_count:0,source_observed_at:'2026-09-01T12:00:00Z',freshness_state:'stale'},
 ]);
 state.data=data;await state.ui.refresh();await state.ui.open();
 const rows=state.root.querySelectorAll('[data-brief-section="renewals"] li');assert.equal(rows.length,2);
 for(const [index,expected] of [
  ['Name: Demo Doctor','Organization: Demo Practice','Practice: Dental','City: Demo City','County: Demo County','State: AL','Lease event: 2027-03-01','Tier: qualified','Flag: review','Contact available: true','Decisions: 3','Source observed: 2026-10-02T12:00:00Z','Freshness: fresh'],
  ['Name: Demo Undated Doctor','Organization: Demo Undated Practice','Practice: Medical','City: Demo Other City','County: Demo Other County','State: FL','Tier: unqualified','Flag: clear','Contact available: false','Decisions: 0','Source observed: 2026-09-01T12:00:00Z','Freshness: stale'],
 ].entries())for(const text of expected)assert.ok(rows[index].textContent.includes(text),`row ${index}: ${text}`);
 assert.doesNotMatch(rows[1].textContent,/Lease event:|null|undefined/);
});

for (const missing of ['today','deals','loops','claim_card','renewals','assurance_cadence','costs']) test(`P2 missing ${missing} retains authenticated decisions and coverage`,async t=>{
 const state=setup(t),data=completeBrief();data.sections.needs_joe=section([{title:'Demo surviving decision'}]);delete data.sections[missing];state.data=data;
 await state.ui.refresh();await state.ui.open();
 assert.match(state.root.getElementById('morningContent').textContent,/Demo surviving decision/);
 const view=morningBriefView(data,options),coverage=view.coverage.find(row=>row.key===missing);
 assert.equal(coverage.state,'unavailable');
 assert.match(state.root.querySelector(`[data-brief-section="${missing}"]`).textContent,/unavailable/);
 assert.equal(morningBriefView({...data,sponsor:'unknown'},options),null);
});
test('P2 missing Needs Joe is named unavailable while surviving work remains',async t=>{
 const state=setup(t),data=completeBrief();delete data.sections.needs_joe;state.data=data;await state.ui.refresh();
 assert.match(state.root.getElementById('morningContent').textContent,/Review demo lease comments/);
 assert.match(state.root.querySelector('[data-brief-section="needs_joe"]').textContent,/Needs Joe.*unavailable/);
});
test('P2 full triage activates all producer kinds outside priority selection without private reads',async t=>{
 const state=setup(t),data=completeBrief();
 const rows=['next_action','post_call_action','critical_date','ingest'].map((item_kind,index)=>({id:`demo-full-${index}`,item_kind,subject_type:'deal',subject_id:'private-demo',subject_ref:'D-DEMO',subject_name:'Demo shared subject',owner_partner:'dell',what:`Demo full ${item_kind}`,due_on:item_kind==='critical_date'?'2099-01-01':day}));
 data.sections.today.items.push(...rows);state.data=data;let reads=0;state.client.getDeal=state.client.readLoop=async()=>{reads++;throw Error('Private read');};await state.ui.refresh();await state.ui.open();
 assert.ok(!morningBriefView(data,options).groups.some(group=>rows.some(row=>row.id===group.row.id)));
 for(const row of rows){
  const item=[...state.root.querySelectorAll('[data-brief-section="today"] li')].find(node=>node.textContent.includes(row.what));
  const summary=item?.querySelector('details summary');assert.ok(summary, row.item_kind);summary.click();
  assert.equal(summary.parentElement.open,true);assert.match(summary.parentElement.textContent,new RegExp(row.id));assert.match(summary.parentElement.textContent,/D-DEMO/);
 }
 assert.equal(reads,0);
});
test('P2 producer account preserves work counts and opens its exact returned account',async t=>{
 const state=setup(t),data=completeBrief();data.sections.deals.accounts=[{account_client_id:'demo-account',account_client_ref:'C-DEMO',account_name:'Demo portfolio',account_owner:'joe',open_deals:7,attention_deals:3,overdue_deals:2,stale_deals:1,parked_deals:4}];state.data=data;await state.ui.refresh();
 const item=[...state.root.querySelectorAll('[data-brief-section="deals"] li')].find(node=>node.textContent.includes('Demo portfolio'));
 for(const value of ['Open deals: 7','Attention deals: 3','Overdue deals: 2','Stale deals: 1','Parked deals: 4'])assert.ok(item.textContent.includes(value),value);
 const summary=item.querySelector('details summary');assert.ok(summary);summary.click();assert.equal(summary.parentElement.open,true);
 assert.match(summary.parentElement.textContent,/C-DEMO/);assert.match(summary.parentElement.textContent,/demo-account/);
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
 const state=setup(t);await state.ui.refresh();await state.ui.open();
 const preferences=JSON.parse(state.win.localStorage.getItem('doctorcre:morning:joe'));
 let fail;state.client.morningBrief=()=>new Promise((resolve,reject)=>fail=reject);
 state.win.dispatchEvent(new state.win.Event('online'));await Promise.resolve();await Promise.resolve();
 assert.equal(state.root.querySelectorAll('[data-brief-record]').length,0);
 fail(Object.assign(Error('Read timed out'),{code:'read_timeout'}));await state.ui.refresh();
 assert.equal(state.root.querySelectorAll('[data-brief-record]').length,0);
 assert.deepEqual(JSON.parse(state.win.localStorage.getItem('doctorcre:morning:joe')),preferences);
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
