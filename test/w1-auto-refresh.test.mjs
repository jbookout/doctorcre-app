import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAutoRefresh, updatedLabel } from '../js/auto-refresh.mjs';
import { readFile } from 'node:fs/promises';
import { createLiveClient } from '../js/live-client.js';
import { createSystemWorkClient } from '../js/system-work-client.js';

function clock() {
  const document = new EventTarget(); document.visibilityState = 'visible';
  const window = new EventTarget(); const pending = new Map(); let next = 0, time = 0;
  window.setTimeout = (fn, ms) => { pending.set(++next, { fn, at: time + ms }); return next; };
  window.clearTimeout = id => pending.delete(id);
  return { document, window, now: () => time,
    advance(ms) { time += ms; },
    async tick() {
      const first = [...pending].sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) return;
      time = Math.max(time, first[1].at); pending.delete(first[0]); first[1].fn(); await settle();
    },
    get count() { return pending.size; },
    get delays() { return [...pending.values()].map(job => job.at - time); },
    hide() { document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); },
    show() { document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange')); },
  };
}
const settle = async () => { for (let i = 0; i < 80; ++i) await Promise.resolve(); };

test('polling preserves detail; resume and reconnect invalidate before reading', async () => {
  const c=clock();let polls=0,resumes=0;
  const handle=mountAutoRefresh({...c,onResume:()=>{resumes++;},refresh:()=>{polls++;}});
  await c.tick();await settle();assert.equal(polls,1);assert.equal(resumes,0);
  c.hide();c.advance(5_000);c.show();await settle();assert.equal(polls,2);assert.equal(resumes,1);
  c.advance(5_000);c.window.dispatchEvent(new Event('online'));await settle();assert.equal(polls,3);assert.equal(resumes,2);
  handle.dispose();c.window.dispatchEvent(new Event('online'));await settle();assert.equal(resumes,2);
});
test('resume invalidation cancels a hanging read and starts a fresh authorized read', async () => {
  const c=clock();let firstSignal,resumes=0,reads=0;
  const handle=mountAutoRefresh({...c,onResume:()=>{resumes++;},refresh:({signal})=>{reads++;if(reads===1){firstSignal=signal;return new Promise(()=>{});}}});
  await c.tick();await settle();c.hide();c.advance(5_000);c.show();await settle();await settle();
  assert.equal(firstSignal.aborted,true);assert.equal(resumes,1);assert.equal(reads,2);handle.dispose();
});

test('background refresh recovers after failure, does not overlap, sleeps hidden and disposes', async () => {
  const c = clock(); let reads = 0, release;
  const refresh = mountAutoRefresh({ ...c, refresh: () => { reads++; if (reads === 1) throw Error('synthetic outage'); return new Promise(resolve => { release = resolve; }); } });
  assert.equal(reads, 0); assert.equal(c.count, 1);
  await c.tick(); await settle(); assert.equal(reads, 1); assert.equal(c.count, 1);
  await c.tick(); await settle(); assert.equal(reads, 2);
  const same = refresh.refresh(); c.window.dispatchEvent(new Event('online')); await settle(); assert.equal(reads, 2);
  release(); await same; await settle(); assert.equal(c.count, 1);
  c.hide(); assert.equal(c.count, 0); await c.tick(); assert.equal(reads, 2);
  c.advance(5_000); c.show(); await settle(); assert.equal(reads, 3); release(); await settle();
  refresh.dispose(); assert.equal(c.count, 0); c.window.dispatchEvent(new Event('online')); c.hide(); c.show(); await settle(); assert.equal(reads, 3);
});
test('read eligibility preserves a draft while polling resumes after the draft closes', async () => {
  const c = clock(); let draft = true, reads = 0;
  const handle = mountAutoRefresh({ ...c, shouldRefresh: () => !draft, refresh: () => { reads++; } });
  await c.tick(); await settle(); assert.equal(reads, 0); assert.equal(c.count, 1);
  draft = false; await c.tick(); await settle(); assert.equal(reads, 1); handle.dispose();
});
test('PR119 finding 8: a never-settling callback expires, cancels and lets recovery run', async () => {
 const c=clock();let reads=0,firstSignal;
 const handle=mountAutoRefresh({...c,timeoutMs:10,refresh:({signal}={})=>{reads++;if(reads===1){firstSignal=signal;return new Promise(()=>{});}}});
 await c.tick();await settle();assert.equal(reads,1);
 await c.tick();await settle();assert.equal(firstSignal?.aborted,true);
 assert.equal(reads,1,'online cannot bypass the failure cooldown');
 await c.tick();assert.equal(reads,2);handle.dispose();
});
for (const phase of ['request','body']) test('PR119 finding 8: ordinary MCP '+phase+' hangs are bounded and cancelled',async()=>{
 let signal;
 const client=createLiveClient({readTimeoutMs:10,fetchImpl:async(_path,init)=>{signal=init.signal;if(phase==='request')return new Promise(()=>{});return {ok:true,json:()=>new Promise(()=>{})};}});
 let timer;
 const guard=new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('read did not settle')),100));
 try { await assert.rejects(Promise.race([client.loopBoard({kind:'task'}),guard]),/timed out/i);assert.equal(signal?.aborted,true); }
 finally{clearTimeout(timer);}
});
for(const kind of ['Work Request','HTTP client'])test('PR119 finding 8: '+kind+' read has a deadline',async()=>{
 let signal;const options={readTimeoutMs:10,fetchImpl:async(_path,init)=>{signal=init.signal;return new Promise(()=>{});}};
 const client=kind==='Work Request'?createSystemWorkClient(options):createLiveClient(options);
 let timer;const guard=new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('read did not settle')),100));
 try{await assert.rejects(Promise.race([kind==='Work Request'?client.current():client.commandCenter(),guard]),/timed out/i);assert.equal(signal?.aborted,true);}finally{clearTimeout(timer);}
});
test('update timestamps use a human clock and missing clocks never look current', () => {
  assert.match(updatedLabel('2026-10-01T15:00:00Z'), /^Updated \d{1,2}:\d{2} (AM|PM)$/);
  assert.equal(updatedLabel(undefined), 'Updating…');
  assert.equal(updatedLabel(null), 'Updating…');
  assert.equal(updatedLabel('invalid'), 'Updating…');
});
for(const method of ['readDocConversation','listDocConversations','listDocSuggestions','docOutcomeCards','codexSessions','workRequestCard'])test('PR119 finding 8: aggregate cancellation reaches '+method+' transport',async()=>{
 let transportSignal;
 const client=createLiveClient({readTimeoutMs:10,fetchImpl:async(_path,init)=>{transportSignal=init.signal;return new Promise(()=>{});}});
 const controller=new AbortController();
 const pending=client[method]({}, {signal:controller.signal});
 const rejected=assert.rejects(pending,/timed out|cancelled/i);
 controller.abort();
 assert.equal(transportSignal.aborted,true,'caller abort reaches the underlying MCP request');
 await rejected;
});
test('every data surface mounts background refresh or the existing board coordinator', async () => {
  for (const name of ['workspace-command-center','workspace-business','leads-workspace-app','calendar','ideas','control-room','atlas','notifications','incidents','conversations','task-records','work-inventory','system-work-app','model-room','sessions','charts','search','status']) {
    assert.match(await readFile(new URL(`../js/${name}.js`, import.meta.url), 'utf8'), /mountAutoRefresh\(/, name);
  }
  assert.match(await readFile(new URL('../tours/app.js', import.meta.url), 'utf8'), /mountAutoRefresh\(/);
  assert.match(await readFile(new URL('../js/app.js', import.meta.url), 'utf8'), /refreshBoard/);
});

test('R1 resume invalidation fires before a coalesced in-flight read and never for polling',async()=>{
 const c=clock();let release,invalidated=0;
 const handle=mountAutoRefresh({...c,onResume:()=>{invalidated++;},refresh:()=>new Promise(resolve=>{release=resolve;})});
 handle.refresh();await settle();assert.equal(invalidated,0);c.hide();c.show();await settle();assert.equal(invalidated,1);
 release();await settle();handle.dispose();
});
test('a failure backs off above the interval and success restores the cadence', async () => {
  const c = clock(); let reads = 0;
  const handle = mountAutoRefresh({ ...c, refresh() { if (++reads <= 2) throw Error('synthetic outage'); } });
  await c.tick(); assert.equal(reads, 1); assert.deepEqual(c.delays, [60_000]);
  await c.tick(); assert.equal(reads, 2); assert.deepEqual(c.delays, [120_000]);
  await c.tick(); assert.equal(reads, 3); assert.deepEqual(c.delays, [30_000]);
  handle.dispose();
});
test('three failures pause the clock until a person resumes', async () => {
  const c = clock(); let reads = 0;
  const handle = mountAutoRefresh({ ...c, refresh() { reads++; throw Error('synthetic outage'); } });
  await c.tick(); await c.tick(); await c.tick();
  assert.equal(reads, 3); assert.equal(c.count, 0);
  c.advance(3600_000); c.window.dispatchEvent(new Event('online')); await settle();
  assert.equal(reads, 3);
  handle.dispose();
});
test('a read replaced on resume does not count as a failure', async () => {
  const c = clock(); let reads = 0;
  const handle = mountAutoRefresh({ ...c, onResume() {}, refresh() {
    if (++reads === 1) return new Promise(() => {});
    throw Error('synthetic outage');
  } });
  await c.tick(); c.hide(); c.advance(5_000); c.show(); await settle();
  assert.equal(reads, 2); assert.deepEqual(c.delays, [60_000]);
  handle.dispose();
});
