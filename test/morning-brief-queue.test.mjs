import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountMorningBrief } from '../js/morning-brief.js';
import { createLiveClient } from '../js/live-client.js';

const brief = () => ({ sponsor:'joe', sections:{today:{state:'empty',items:[]},deals:{state:'empty',items:[]},loops:{state:'empty',items:[]},needs_joe:{state:'empty',items:[]},assurance_cadence:{state:'empty',items:[]}} });
const row = number => ({number:String(number),kind:'open_loop',title:`Synthetic loop ${number}`,due_on:'2026-01-01',owner_partner:'joe'});
const page = (items,{total=51,next='next',sponsor='joe'}={}) => ({sponsor,items,total,returned:items.length,has_more:next!==null,next_cursor:next,remaining:next?1:0});
function setup(t, read) {
 const dom=new JSDOM('<button id="docOpen">Doc</button><button id="docMorning">Morning brief</button>',{url:'http://localhost'});
 t.after(()=>dom.window.close());
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event('close'));};
 let data=brief();
 const client={morningBrief:async()=>data,getChanges:async()=>({events:[]}),morningBriefQueue:read};
 const ui=mountMorningBrief({document:dom.window.document,window:dom.window,getClient:async()=>client,intervalMs:100000});
 t.after(()=>ui.dispose());
 return {ui,root:dom.window.document,win:dom.window,client,set data(value){data=value;}};
}
const tick = () => new Promise(resolve=>setTimeout(resolve,20));

test('brief exposes all four queues and reaches the 51st loop in server order with honest counts',async t=>{
 const calls=[];
 const state=setup(t,async(queue,args)=>{calls.push([queue,args.cursor]);return args.cursor?page([row(51)],{next:null}):page(Array.from({length:50},(_,i)=>row(i+1)));});
 await state.ui.refresh();state.ui.open();
 assert.deepEqual([...state.root.querySelectorAll('[data-brief-queue]')].map(node=>node.dataset.briefQueue),['today','loops','needs_joe','assurance_cadence']);
 state.root.querySelector('[data-brief-queue="loops"]').click();await tick();
 assert.match(state.root.getElementById('morningContent').textContent,/50 of 51/);
 assert.equal(state.root.querySelectorAll('[data-queue-item]').length,50);
 state.root.querySelector('[data-brief-queue-more]').click();await tick();
 assert.match(state.root.getElementById('morningContent').textContent,/51 of 51/);
 assert.equal(state.root.querySelectorAll('[data-queue-item]').length,51);
 assert.equal(state.root.querySelector('[data-brief-queue-more]'),null);
 assert.deepEqual(calls,[['loops',undefined],['loops','next']]);
});
test('failed and malformed follow-up retain rows and retry without claiming completion',async t=>{
 let fail=true;
 const state=setup(t,async(_queue,args)=>!args.cursor?page([row(1)],{total:2}):fail?{items:[]}:page([row(2)],{total:2,next:null}));
 await state.ui.refresh();state.ui.open();state.root.querySelector('[data-brief-queue="loops"]').click();await tick();
 state.root.querySelector('[data-brief-queue-more]').click();await tick();
 assert.match(state.root.getElementById('morningContent').textContent,/Queue update unavailable/);
 assert.match(state.root.getElementById('morningContent').textContent,/1 of 2/);
 assert.equal(state.root.querySelectorAll('[data-queue-item]').length,1);
 fail=false;state.root.querySelector('[data-brief-queue-more]').click();await tick();
 assert.match(state.root.getElementById('morningContent').textContent,/2 of 2/);
});
test('queue page cannot restore facts after dismissal or a viewer change',async t=>{
 let release;
 const state=setup(t,()=>new Promise(resolve=>release=resolve));
 await state.ui.refresh();state.ui.open();state.root.querySelector('[data-brief-queue="loops"]').click();await tick();
 state.root.getElementById('morningClose').click();release(page([row(1)],{total:1,next:null}));await tick();
 assert.equal(state.root.querySelectorAll('[data-queue-item]').length,0);
 state.ui.open();state.root.querySelector('[data-brief-queue="loops"]').click();await tick();
 const other=brief();other.sponsor='dell';state.data=other;await state.ui.refresh();
 release(page([row(1)],{total:1,next:null}));await tick();
 assert.equal(state.root.querySelectorAll('[data-queue-item]').length,0);
 assert.equal(state.root.querySelector('[data-brief-queue="needs_joe"]'),null);
});
test('live queue method selects only approved read verbs and carries opaque cursor without audience',async()=>{
 const calls=[];
 const client=createLiveClient({fetchImpl:async(path,init)=>{calls.push(JSON.parse(init.body).params);return new Response(JSON.stringify({result:{content:[{text:JSON.stringify(page([],{total:0,next:null}))}]}}));}});
 await client.morningBriefQueue('today',{cursor:'opaque',sponsor:'dell'});
 await client.morningBriefQueue('assurance_cadence');
 assert.deepEqual(calls,[{name:'morning-brief-queue',arguments:{queue:'today',cursor:'opaque'}},{name:'morning-assurance-queue',arguments:{}}]);
 await assert.rejects(client.morningBriefQueue('arbitrary-write'));
});

test('partner mismatch and authorization refusal clear queue facts instead of retaining stale rows',async t=>{
 let next;
 const state=setup(t,async(_queue,args)=>args.cursor?next():page([row(1)],{total:2}));
 await state.ui.refresh();state.ui.open();state.root.querySelector('[data-brief-queue="loops"]').click();await tick();
 next=async()=>page([row(2)],{total:2,next:null,sponsor:'dell'});
 state.root.querySelector('[data-brief-queue-more]').click();await tick();
 assert.equal(state.root.querySelectorAll('[data-queue-item]').length,0);
 assert.equal(state.root.querySelectorAll('[data-brief-queue]').length,0);
 await state.ui.refresh();state.ui.open();state.root.querySelector('[data-brief-queue="loops"]').click();await tick();
 next=async()=>{throw Object.assign(Error('Refused'),{status:403});};
 state.root.querySelector('[data-brief-queue-more]').click();await tick();
 assert.equal(state.root.querySelectorAll('[data-queue-item]').length,0);
});

test('Needs Joe keeps different decisions sharing an older display key and labels partial source totals',async t=>{
 const state=setup(t,async(_queue,args)=>({...page([{key:'loop:17',title:args.cursor?'Synthetic team decision':'Synthetic work decision',why:{text:'Human decision'},action:'Review',blocks:{text:'Blocks synthetic work'}}],{total:2,next:args.cursor?null:'next'}),state:'partial',total_scope:'available_sources'}));
 await state.ui.refresh();state.ui.open();state.root.querySelector('[data-brief-queue="needs_joe"]').click();await tick();
 state.root.querySelector('[data-brief-queue-more]').click();await tick();
 assert.equal(state.root.querySelectorAll('[data-queue-item]').length,2);
 assert.match(state.root.getElementById('morningContent').textContent,/2 of 2 from available sources/);
 assert.match(state.root.getElementById('morningContent').textContent,/Some sources are unavailable/);
});

test('an unlabeled eligible loop remains reachable by its stable identity',async t=>{
 const state=setup(t,async()=>page([{number:'17',kind:'open_loop',title:null,label:null}],{total:1,next:null}));
 await state.ui.refresh();state.ui.open();state.root.querySelector('[data-brief-queue="loops"]').click();await tick();
 assert.match(state.root.getElementById('morningContent').textContent,/Open loop 17/);
 assert.equal(state.root.querySelectorAll('[data-queue-item]').length,1);
});

test('a premature terminal page retains the last verified page and offers retry',async t=>{
 const state=setup(t,async(_queue,args)=>args.cursor?page([row(2)],{total:3,next:null}):page([row(1)],{total:3}));
 await state.ui.refresh();state.ui.open();state.root.querySelector('[data-brief-queue="loops"]').click();await tick();
 state.root.querySelector('[data-brief-queue-more]').click();await tick();
 assert.equal(state.root.querySelectorAll('[data-queue-item]').length,1);
 assert.match(state.root.getElementById('morningContent').textContent,/Queue update unavailable/);
 assert.ok(state.root.querySelector('[data-brief-queue-more]'));
});
test('duplicate identities within one page cannot manufacture complete coverage',async t=>{
 const state=setup(t,async()=>page([row(1),row(1)],{total:2,next:null}));
 await state.ui.refresh();state.ui.open();state.root.querySelector('[data-brief-queue="loops"]').click();await tick();
 assert.equal(state.root.querySelectorAll('[data-queue-item]').length,0);
 assert.match(state.root.getElementById('morningContent').textContent,/Queue update unavailable/);
 assert.ok(state.root.querySelector('[data-brief-queue-more]'));
});

test('an unchanged automatic brief refresh preserves queue control focus',async t=>{
 const state=setup(t,async()=>page([],{total:0,next:null}));
 await state.ui.refresh();state.ui.open();
 const control=state.root.querySelector('[data-brief-queue="loops"]');control.focus();
 await state.ui.refresh();
 assert.equal(state.root.activeElement,control);
});

for (const status of ['partial','unavailable']) test(`queue summary discloses ${status} coverage before opening the list`,async t=>{
 const state=setup(t,async()=>page([],{total:0,next:null}));
 const data=brief();
 data.sections.needs_joe={state:status,items:status==='partial'?[{key:'loop:17',title:'Synthetic decision'}]:[],total:status==='partial'?1:0,total_scope:'available_sources'};
 state.data=data;
 await state.ui.refresh();state.ui.open();
 const summary=state.root.querySelector('[data-brief-queue="needs_joe"]').textContent;
 assert.match(summary,/from available sources/);
 assert.match(summary,status==='partial'?/Some sources are unavailable/:/Unavailable/);
 assert.equal(state.root.querySelectorAll('[data-queue-item]').length,0);
});

test('explicit Refresh restarts a terminal queue and dates only the completed queue read',async t=>{
 let calls=0,release;
 const state=setup(t,async(_queue,args)=>{
   assert.equal(args.cursor,undefined);
   if (++calls===1) return page([row(1)],{total:1,next:null});
   return new Promise(resolve=>release=resolve);
 });
 await state.ui.refresh();state.ui.open();state.root.querySelector('[data-brief-queue="loops"]').click();await tick();
 const updated=state.root.getElementById('morningUpdated');
 assert.ok(updated.dateTime);
 state.root.getElementById('morningRefresh').click();await tick();
 assert.equal(calls,2);
 assert.equal(updated.hasAttribute('datetime'),false);
 assert.equal(state.root.querySelectorAll('[data-queue-item]').length,0);
 await state.ui.refresh();
 assert.equal(updated.hasAttribute('datetime'),false,'composite brief must not date a pending queue');
 release(page([row(2),row(3)],{total:2,next:null}));await tick();
 assert.match(state.root.getElementById('morningContent').textContent,/2 of 2/);
 assert.doesNotMatch(state.root.getElementById('morningContent').textContent,/Synthetic loop 1/);
 assert.ok(updated.dateTime);
});

test('explicit Refresh invalidates an in-flight traversal and failed refresh has no fresh timestamp',async t=>{
 let calls=0,release;
 const state=setup(t,async()=>{
   if (++calls===1) return page([row(1)],{total:2});
   if (calls===2) return new Promise(resolve=>release=resolve);
   throw Error('Synthetic queue unavailable');
 });
 await state.ui.refresh();state.ui.open();state.root.querySelector('[data-brief-queue="loops"]').click();await tick();
 state.root.querySelector('[data-brief-queue-more]').click();await tick();
 state.root.getElementById('morningRefresh').click();await tick();
 assert.equal(calls,3);
 release(page([row(2)],{total:2,next:null}));await tick();
 assert.equal(state.root.querySelectorAll('[data-queue-item]').length,0);
 assert.match(state.root.getElementById('morningUpdated').textContent,/Queue update unavailable/);
 assert.equal(state.root.getElementById('morningUpdated').hasAttribute('datetime'),false);
 assert.ok(state.root.querySelector('[data-brief-queue-more]'));
});
