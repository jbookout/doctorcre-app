import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { uiBundle } from '../scripts/ui-bundle.mjs';
const bundle = await uiBundle(path => readFile(new URL('../' + path, import.meta.url), 'utf8'), 'src/ui/queued-asks.ts');
const { createAskOutbox } = await import(`data:text/javascript;base64,${bundle.toString('base64')}`);
const conversation = '11111111-1111-4111-8111-111111111111';
const key = '22222222-2222-4222-8222-222222222222';
function memory() { const data = new Map(); return { get length() { return data.size; }, key: i => [...data.keys()][i], getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) }; }
const receipt = request => ({ ok: true, contract: 'doc-request.v1', status: 'accepted', conversation_id: request.conversation_id, request_msg_id: request.idempotency_key, idempotency_key: request.idempotency_key });
function setup(storage = memory()) {
 let online = false, send = async request => receipt(request);
 const calls = [];
 const box = createAskOutbox({ storage, actor: 'joe', conversation, online: () => online, uuid: () => key, submit: async request => { calls.push(request); return send(request); } });
 return { box, calls, storage, connect: () => { online = true; }, sender: fn => { send = fn; } };
}
test('offline ask persists, reconnect accepts once, reopening never resubmits accepted', async () => {
 const s = setup(); await s.box.saveDraft('Ask offline'); await s.box.enqueue();
 assert.equal(s.box.entries()[0].kind, 'queued'); assert.equal(s.calls.length, 0);
 s.connect(); await s.box.flush(); assert.equal(s.box.entries()[0].kind, 'accepted');
 await s.box.flush(); assert.equal(s.calls.length, 1);
 assert.equal(setup(s.storage).box.entries()[0].kind, 'accepted');
 assert.equal(createAskOutbox({ storage:s.storage, actor:'dell', conversation, online:()=>false, uuid:()=>key, submit:receipt }).entries().length,0);
});
test('lost or malformed receipts stay unknown and replay the frozen request', async () => {
 for (const fail of [async () => { throw Error('timeout'); }, async () => ({ ok:true }), async r => ({ ...receipt(r), conversation_id:'wrong' })]) {
  const s = setup(); await s.box.saveDraft('Original'); await s.box.enqueue(); s.connect(); s.sender(fail); await s.box.flush();
  assert.equal(s.box.entries()[0].kind,'unknown'); await s.box.saveDraft('Newer'); s.sender(receipt); await s.box.flush();
  assert.deepEqual(s.calls[0],s.calls[1]); assert.equal(s.box.entries()[0].kind,'accepted'); assert.equal(s.box.draft(),'Newer');
 }
});
test('interrupted submission reopens unknown', async () => {
 const s = setup(); await s.box.saveDraft('Interrupted'); await s.box.enqueue(); s.connect();
 let finish; s.sender(r => new Promise(resolve => { finish=()=>resolve(receipt(r)); }));
 const pending = s.box.flush(); await new Promise(resolve=>setImmediate(resolve));
 assert.equal(s.box.entries()[0].kind,'submitting');
 assert.equal(setup(s.storage).box.entries()[0].kind,'unknown'); finish(); await pending;
 assert.equal(s.box.entries()[0].kind,'accepted');
});
test('contract refusals wait for explicit retry', async () => {
 const s=setup(); await s.box.saveDraft('Ask'); await s.box.enqueue(); s.connect();
 s.sender(r=>({contract:'doc-request.v1',status:'refused',idempotency_key:r.idempotency_key,conversation_id:r.conversation_id,reason:'not_available'}));
 await s.box.flush(); assert.equal(s.box.entries()[0].kind,'refused'); await s.box.flush(); assert.equal(s.calls.length,1);
 s.sender(receipt); await s.box.retry(key); assert.equal(s.box.entries()[0].kind,'accepted');
});
test('quota failure never dispatches and stale queue cleanup preserves newer text', async () => {
 const s=setup(); await s.box.saveDraft('Newer');
 await assert.rejects(()=>s.box.enqueue('Old text'),/changed/); assert.equal(s.box.draft(),'Newer');
 const broken = { ...memory(), setItem() { throw Error('quota'); } };
 const bad=setup(broken); await assert.rejects(()=>bad.box.saveDraft('Ask')); await assert.rejects(()=>bad.box.enqueue('Ask')); bad.connect(); await bad.box.flush(); assert.equal(bad.calls.length,0);
});
test('late failure from another tab cannot replace a confirmed acceptance', async () => {
 const s=setup();await s.box.saveDraft('Ask');await s.box.enqueue();s.connect();
 let finish;s.sender(()=>new Promise(resolve=>{finish=()=>resolve({});}));
 const pending=s.box.flush();await new Promise(resolve=>setImmediate(resolve));
 const other=setup(s.storage);other.connect();await other.box.flush();
 assert.equal(other.box.entries()[0].kind,'accepted');finish();await pending;
 assert.equal(s.box.entries()[0].kind,'accepted');
});
test('queue cleanup serializes a same-text edit requested while enqueue persists', async () => {
 const storage=memory(), s=setup(storage);await s.box.saveDraft('Same text');
 let competing;
 const original=storage.setItem;
 storage.setItem=(key,value)=>{
  original(key,value);
  if (!key.endsWith(':draft')) competing=s.box.saveDraft('Same text');
 };
 await s.box.enqueue();await competing;assert.equal(s.box.draft(),'Same text');assert.equal(s.box.entries()[0].kind,'queued');
});
test('unknown stays unknown while offline and concurrent flush sends once in one controller', async () => {
 const s=setup();await s.box.saveDraft('Ask');await s.box.enqueue();s.connect();
 let finish;s.sender(()=>new Promise(resolve=>{finish=()=>resolve({});}));
 const pending=s.box.flush();await new Promise(resolve=>setImmediate(resolve));await s.box.flush();
 assert.equal(s.calls.length,1);finish();await pending;
 const offline=setup(s.storage);await offline.box.flush();
 assert.equal(offline.box.entries()[0].kind,'unknown');assert.equal(offline.calls.length,0);
});

test('asks queued during a held submission drain without retrying unknown outcomes', async () => {
 const storage=memory(), calls=[];
 let finish, serial=0;
 const box=createAskOutbox({storage,actor:'busy',conversation,online:()=>true,
  uuid:()=>`22222222-2222-4222-8222-${String(++serial).padStart(12,'0')}`,
  submit:request=>{calls.push(request);return calls.length===1?new Promise(resolve=>{finish=()=>resolve({});}):receipt(request);}});
 await box.saveDraft('First');await box.enqueue();const pending=box.flush();
 assert.equal(box.entries()[0].kind,'submitting');
 await box.saveDraft('Second');await box.enqueue();await box.flush();
 await box.saveDraft('Third draft');
 finish();await pending;
 assert.deepEqual(box.entries().map(row=>row.kind),['unknown','accepted']);
 assert.equal(calls.length,2);assert.equal(box.draft(),'Third draft');
 assert.equal(calls[1].body,'Second');
});
