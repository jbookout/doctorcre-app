import test from 'node:test';
import assert from 'node:assert/strict';
import { featureEnabled, mountFeatureGate } from '../js/feature-switches.js';

test('UI uses only a fresh server evaluation, and missing flags stay hidden', () => {
  const payload = { schema:'feature-switches.v1', switches:[{ name:'doc-suggestion-actions', available:true }] };
  assert.equal(featureEnabled(payload, 'doc-suggestion-actions'), true);
  assert.equal(featureEnabled(payload, 'missing'), false);
  assert.equal(featureEnabled(null, 'doc-suggestion-actions'), false);
  assert.equal(featureEnabled({ ...payload, switches:[{ name:'doc-suggestion-actions', available:false }] }, 'doc-suggestion-actions'), false);
});


import { JSDOM } from 'jsdom';

const settle = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function gatePage(t) {
 t.mock.timers.enable({apis:['Date'],now:0});
 const dom=new JSDOM('<button id="action">Act</button>',{url:'https://app.doctorcre.com'});
 Object.defineProperty(dom.window.navigator,'locks',{value:{request:(_name,_options,callback)=>callback({})}});
 const timers=new Map();let serial=0;
 dom.window.setTimeout=(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:Date.now()+ms});return id;};
 dom.window.clearTimeout=id=>timers.delete(id);
 const advance=async ms=>{
  await settle();const end=Date.now()+ms;
  while(true){
   const next=[...timers].filter(([,job])=>job.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
   if(!next)break;
   t.mock.timers.tick(Math.max(0,next[1].at-Date.now()));timers.delete(next[0]);next[1].fn();await settle();
  }
  t.mock.timers.tick(Math.max(0,end-Date.now()));await settle();
 };
 return {dom,advance};
}

test('mounted UI hides on load and on a failed read, and follows flips without reload', async t => {
  const {dom,advance}=gatePage(t);
  const button=dom.window.document.getElementById('action');
  let available=true, failed=false;
  const gate=mountFeatureGate({document:dom.window.document,window:dom.window,name:'doc-suggestion-actions',
    read:async()=>{if(failed)throw Error('offline');return {schema:'feature-switches.v1',switches:[{name:'doc-suggestion-actions',available}]};},
    onChange:value=>button.hidden=!value});
  t.after(()=>{gate.dispose();dom.window.close();});
  assert.equal(button.hidden,true);
  await gate.refresh(); assert.equal(button.hidden,false);
  await advance(5_000); available=false; await gate.refresh(); assert.equal(button.hidden,true);
  await advance(5_000); available=true; await gate.refresh(); assert.equal(button.hidden,false);
  await advance(5_000); failed=true; await gate.refresh(); assert.equal(button.hidden,true);
});

test('an open page observes an off flip at the next 30-second poll',async t=>{
 const {dom,advance}=gatePage(t);
 let available=true,visible=false;
 const gate=mountFeatureGate({document:dom.window.document,window:dom.window,name:'doc-suggestion-actions',
  read:async()=>({schema:'feature-switches.v1',switches:[{name:'doc-suggestion-actions',available}]}),onChange:value=>visible=value});
 t.after(()=>{gate.dispose();dom.window.close();});
 await gate.refresh();assert.equal(visible,true);
 available=false;
 await advance(29_999);assert.equal(visible,true,'the existing answer remains until the next poll');
 await advance(1);assert.equal(visible,false);
});

import { readFileSync } from 'node:fs';
import { createLiveClient } from '../js/live-client.js';

test('the pinned switch read carries no caller-selected identity or audience',async()=>{
 const contract=JSON.parse(readFileSync(new URL('../contracts/carr-interface.v1.json',import.meta.url)));
 const seam=contract.mcp_read_contracts['list-feature-switches'];
 assert.match(seam.producer.source_commit,/^[0-9a-f]{40}$/);
 assert.equal(seam.response.schema,'feature-switches.v1');
 let request;
 const live=createLiveClient({fetchImpl:async(path,init)=>{
  assert.equal(path,'/mcp');assert.equal(init.credentials,'same-origin');request=JSON.parse(init.body).params;
  return new Response(JSON.stringify({result:{content:[{text:JSON.stringify({schema:seam.response.schema,switches:[{name:'doc-suggestion-actions',available:true}]})}]}}));
 }});
 assert.equal(featureEnabled(await live.listFeatureSwitches(),'doc-suggestion-actions'),true);
 assert.deepEqual(request,{name:'list-feature-switches',arguments:{}});
});

test('a resumed page hides the feature until its fresh read settles',async t=>{
 const {dom,advance}=gatePage(t);
 let state='visible';Object.defineProperty(dom.window.document,'visibilityState',{get:()=>state});
 let visible=null,release;const reads=[];
 const gate=mountFeatureGate({document:dom.window.document,window:dom.window,name:'doc-suggestion-actions',
  read:()=>{reads.push(1);return reads.length===1?{schema:'feature-switches.v1',switches:[{name:'doc-suggestion-actions',available:true}]}
   :new Promise(resolve=>release=()=>resolve({schema:'feature-switches.v1',switches:[{name:'doc-suggestion-actions',available:true}]}));},
  onChange:value=>visible=value});
 t.after(()=>{release?.();gate.dispose();dom.window.close();});
 await gate.refresh();assert.equal(visible,true);
 state='hidden';dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
 state='visible';dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
 await settle();
 assert.equal(visible,false,'hidden while the resume read waits for its safe turn');
 await advance(5_000);assert.equal(reads.length,2);
 release();await settle();
 assert.equal(visible,true);
});

const switches=available=>({schema:'feature-switches.v1',switches:[{name:'doc-suggestion-actions',available}]});

test('consumers on one page share one gate, one poll and one answer',async t=>{
 const {dom,advance}=gatePage(t);
 let reads=0,second=0;const seen=[[],[]];
 const first=mountFeatureGate({document:dom.window.document,window:dom.window,name:'doc-suggestion-actions',
  read:async()=>{reads++;return switches(true);},onChange:value=>seen[0].push(value)});
 t.after(()=>{first.dispose();dom.window.close();});
 await first.refresh();
 const other=mountFeatureGate({document:dom.window.document,window:dom.window,name:'doc-suggestion-actions',
  read:async()=>{second++;return switches(false);},onChange:value=>seen[1].push(value)});
 assert.equal(seen[1].at(-1),true,'a later consumer starts from the page answer');
 await advance(5_000);await other.refresh();
 assert.equal(second,0,'the page keeps one read loop per switch');
 assert.deepEqual([seen[0].at(-1),seen[1].at(-1)],[true,true]);
 other.dispose();
 await advance(5_000);await first.refresh();assert.equal(seen[0].at(-1),true,'one consumer leaving keeps the gate for the rest');
 assert.equal(reads,3);
});

test('a refusal hides at once and a read already in flight cannot reveal the feature again',async t=>{
 const {dom,advance}=gatePage(t);
 let release;const answers=[switches(true)];const values=[];
 const gate=mountFeatureGate({document:dom.window.document,window:dom.window,name:'doc-suggestion-actions',
  read:()=>answers.length?answers.shift():new Promise(resolve=>release=()=>resolve(switches(true))),onChange:value=>values.push(value)});
 t.after(()=>{release?.();gate.dispose();dom.window.close();});
 await gate.refresh();assert.equal(values.at(-1),true);
 await advance(5_000);
 const stale=gate.refresh();await settle(); // reads "on", started before CARR refused
 answers.push(switches(false));             // the confirming read sees CARR's own answer
 const refused=gate.refused(),mark=values.length;
 assert.equal(values.at(-1),false,'hidden as soon as CARR refuses');
 release();await stale;await advance(5_000);await refused;
 assert.equal(values.slice(mark).includes(true),false,'the stale "on" never repaints');
 assert.equal(answers.length,0,'a confirming read starts after the refusal');
 assert.equal(values.at(-1),false);
});
