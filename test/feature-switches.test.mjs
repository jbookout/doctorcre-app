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

test('mounted UI hides on load and on a failed read, and follows flips without reload', async () => {
  const dom=new JSDOM('<button id="action">Act</button>',{url:'https://app.doctorcre.com'});
  const button=dom.window.document.getElementById('action');
  let available=true, failed=false;
  const gate=mountFeatureGate({document:dom.window.document,window:dom.window,name:'doc-suggestion-actions',
    read:async()=>{if(failed)throw Error('offline');return {schema:'feature-switches.v1',switches:[{name:'doc-suggestion-actions',available}]};},
    onChange:value=>button.hidden=!value});
  assert.equal(button.hidden,true);
  await gate.refresh(); assert.equal(button.hidden,false);
  available=false; await gate.refresh(); assert.equal(button.hidden,true);
  available=true; await gate.refresh(); assert.equal(button.hidden,false);
  failed=true; await gate.refresh(); assert.equal(button.hidden,true);
  gate.dispose();dom.window.close();
});

test('an open page observes an off flip at the next 30-second poll',async()=>{
 const dom=new JSDOM('<button>Act</button>');
 const timers=new Map();let serial=0,available=true,visible=false;
 dom.window.setTimeout=(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id;};
 dom.window.clearTimeout=id=>timers.delete(id);
 const gate=mountFeatureGate({document:dom.window.document,window:dom.window,name:'doc-suggestion-actions',
  read:async()=>({schema:'feature-switches.v1',switches:[{name:'doc-suggestion-actions',available}]}),onChange:value=>visible=value});
 await gate.refresh();assert.equal(visible,true);
 available=false;
 const poll=[...timers.values()].find(timer=>timer.ms===30_000);
 assert.ok(poll);await poll.fn();assert.equal(visible,false);
 gate.dispose();dom.window.close();
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
