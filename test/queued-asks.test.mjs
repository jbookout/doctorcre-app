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
for (const corruptFirst of [true,false]) test(`corrupt entry isolation, corrupt first ${corruptFirst}`, async () => {
 const storage=memory(), prefix=`doctorcre:asks:v1:joe:${conversation}:`, bad=prefix+'broken';
 if(corruptFirst) storage.setItem(bad,'{');
 const s=setup(storage);s.box.saveDraft('Valid frozen ask');s.box.enqueue();s.box.saveDraft('Current draft');
 if(!corruptFirst) storage.setItem(bad,'{');
 const reopened=setup(storage);
 assert.deepEqual(reopened.box.entries().map(r=>r.request.body),['Valid frozen ask']);
 assert.deepEqual(reopened.box.recovery(),[bad]);
 reopened.connect();await reopened.box.flush();
 assert.equal(reopened.box.entries()[0].kind,'accepted');assert.equal(reopened.calls.length,1);
 assert.equal(reopened.calls[0].body,'Valid frozen ask');assert.equal(reopened.box.draft(),'Current draft');
 assert.equal(storage.getItem(bad),'{');assert.equal(setup(storage).box.entries()[0].kind,'accepted');
});
for (const raw of ['{','','{}']) test(`malformed draft is isolated and retained without overwrite ${JSON.stringify(raw)}`,async()=>{
 const s=setup(),draftKey=`doctorcre:asks:v1:joe:${conversation}:draft`;
 s.box.saveDraft('Valid');s.box.enqueue();s.storage.setItem(draftKey,raw);
 const reopened=setup(s.storage);assert.equal(reopened.box.draft(),'');
 assert.throws(()=>reopened.box.saveDraft('Replacement'),/recovery/);
 assert.throws(()=>reopened.box.enqueue('Replacement'));
 reopened.connect();await reopened.box.flush();assert.equal(reopened.box.entries()[0].kind,'accepted');
 assert.equal(s.storage.getItem(draftKey),raw);assert.deepEqual(reopened.box.recovery(),[draftKey]);
});
test('recovery scan captures storage length once and stops despite new producers',()=>{
 const s=setup(),prefix=`doctorcre:asks:v1:joe:${conversation}:`;
 s.storage.setItem(prefix+'broken','{');
 let reads=0,keys=0;
 Object.defineProperty(s.storage,'length',{get(){reads++;return 1;}});
 const original=s.storage.key;
 s.storage.key=i=>{keys++;s.storage.setItem(prefix+'new-'+i,'{');return original(i);};
 assert.deepEqual(s.box.recovery(),[prefix+'broken']);assert.equal(reads,1);assert.equal(keys,1);
});
test('invalid shapes stay held, other scopes excluded, access failures throw',()=>{
 const s=setup(),prefix=`doctorcre:asks:v1:joe:${conversation}:`;
 s.storage.setItem(prefix+'bad','{}');
 s.storage.setItem(prefix+'wrong',JSON.stringify({kind:'queued',request:{body:'Wrong',conversation_id:key,idempotency_key:key}}));
 s.storage.setItem(`doctorcre:asks:v1:dell:${conversation}:bad`,'{');
 s.storage.setItem(`doctorcre:asks:v1:joe:${key}:bad`,'{');
 assert.equal(s.box.entries().length,0);assert.equal(s.box.recovery().length,2);
 s.storage.getItem=()=>{throw Error('access denied');};assert.throws(()=>s.box.entries(),/access denied/);
});
function setup(storage = memory()) {
 let online = false, send = async request => receipt(request);
 const calls = [];
 const box = createAskOutbox({ storage, actor: 'joe', conversation, online: () => online, uuid: () => key, submit: async request => { calls.push(request); return send(request); } });
 return { box, calls, storage, connect: () => { online = true; }, sender: fn => { send = fn; } };
}
test('offline ask persists, reconnect accepts once, reopening never resubmits accepted', async () => {
 const s = setup(); s.box.saveDraft('Ask offline'); s.box.enqueue();
 assert.equal(s.box.entries()[0].kind, 'queued'); assert.equal(s.calls.length, 0);
 s.connect(); await s.box.flush(); assert.equal(s.box.entries()[0].kind, 'accepted');
 await s.box.flush(); assert.equal(s.calls.length, 1);
 assert.equal(setup(s.storage).box.entries()[0].kind, 'accepted');
 assert.equal(createAskOutbox({ storage:s.storage, actor:'dell', conversation, online:()=>false, uuid:()=>key, submit:receipt }).entries().length,0);
});
test('lost or malformed receipts stay unknown and replay the frozen request', async () => {
 for (const fail of [async () => { throw Error('timeout'); }, async () => ({ ok:true }), async r => ({ ...receipt(r), conversation_id:'wrong' })]) {
  const s = setup(); s.box.saveDraft('Original'); s.box.enqueue(); s.connect(); s.sender(fail); await s.box.flush();
  assert.equal(s.box.entries()[0].kind,'unknown'); s.box.saveDraft('Newer'); s.sender(receipt); await s.box.flush();
  assert.deepEqual(s.calls[0],s.calls[1]); assert.equal(s.box.entries()[0].kind,'accepted'); assert.equal(s.box.draft(),'Newer');
 }
});
test('interrupted submission reopens unknown', async () => {
 const s = setup(); s.box.saveDraft('Interrupted'); s.box.enqueue(); s.connect();
 let finish; s.sender(r => new Promise(resolve => { finish=()=>resolve(receipt(r)); }));
 const pending = s.box.flush(); await new Promise(resolve=>setImmediate(resolve));
 assert.equal(s.box.entries()[0].kind,'submitting');
 assert.equal(setup(s.storage).box.entries()[0].kind,'unknown'); finish(); await pending;
 assert.equal(s.box.entries()[0].kind,'accepted');
});
test('contract refusals wait for explicit retry', async () => {
 const s=setup(); s.box.saveDraft('Ask'); s.box.enqueue(); s.connect();
 s.sender(r=>({contract:'doc-request.v1',status:'refused',idempotency_key:r.idempotency_key,conversation_id:r.conversation_id,reason:'not_available'}));
 await s.box.flush(); assert.equal(s.box.entries()[0].kind,'refused'); await s.box.flush(); assert.equal(s.calls.length,1);
 s.sender(receipt); await s.box.retry(key); assert.equal(s.box.entries()[0].kind,'accepted');
});
test('quota failure never dispatches and stale queue cleanup preserves newer text', async () => {
 const s=setup(); s.box.saveDraft('Newer');
 assert.throws(()=>s.box.enqueue('Old text'),/changed/); assert.equal(s.box.draft(),'Newer');
 const broken = { ...memory(), setItem() { throw Error('quota'); } };
 const bad=setup(broken); assert.throws(()=>bad.box.saveDraft('Ask')); assert.throws(()=>bad.box.enqueue('Ask')); bad.connect(); await bad.box.flush(); assert.equal(bad.calls.length,0);
});
test('late failure from another tab cannot replace a confirmed acceptance', async () => {
 const s=setup();s.box.saveDraft('Ask');s.box.enqueue();s.connect();
 let finish;s.sender(()=>new Promise(resolve=>{finish=()=>resolve({});}));
 const pending=s.box.flush();await new Promise(resolve=>setImmediate(resolve));
 const other=setup(s.storage);other.connect();await other.box.flush();
 assert.equal(other.box.entries()[0].kind,'accepted');finish();await pending;
 assert.equal(s.box.entries()[0].kind,'accepted');
});
test('queue cleanup compares draft version even when another tab writes identical text', () => {
 const storage=memory(), s=setup(storage);s.box.saveDraft('Same text');
 const original=storage.setItem;
 storage.setItem=(key,value)=>{
  original(key,value);
  if (!key.endsWith(':draft')) s.box.saveDraft('Same text');
 };
 s.box.enqueue();assert.equal(s.box.draft(),'Same text');assert.equal(s.box.entries()[0].kind,'queued');
});
test('unknown stays unknown while offline and concurrent flush sends once in one controller', async () => {
 const s=setup();s.box.saveDraft('Ask');s.box.enqueue();s.connect();
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
 box.saveDraft('First');box.enqueue();const pending=box.flush();
 assert.equal(box.entries()[0].kind,'submitting');
 box.saveDraft('Second');box.enqueue();await box.flush();
 box.saveDraft('Third draft');
 finish();await pending;
 assert.deepEqual(box.entries().map(row=>row.kind),['unknown','accepted']);
 assert.equal(calls.length,2);assert.equal(box.draft(),'Third draft');
 assert.equal(calls[1].body,'Second');
});

for (const failure of ['corrupt', 'conversation', 'idempotency_key', 'storage']) for (const arrival of ['accepted','refused','unknown','rejected']) test(`receipt update isolates ${failure} during ${arrival} arrival`, async () => {
 const storage=memory(),calls=[],prefix=`doctorcre:asks:v1:joe:${conversation}:`;
 let serial=0,finish;
 const box=createAskOutbox({storage,actor:'joe',conversation,online:()=>true,
  uuid:()=>`22222222-2222-4222-8222-${String(++serial).padStart(12,'0')}`,
  submit:request=>{calls.push(request);return calls.length===1?new Promise((resolve,reject)=>{finish=()=>{
   if(arrival==='rejected') reject(Error('lost receipt'));
   else resolve(arrival==='accepted'?receipt(request):arrival==='unknown'?{}:{...receipt(request),ok:false,status:'refused',reason:'not_available'});
  };}):receipt(request);}});
 box.saveDraft('First');const first=box.enqueue();box.saveDraft('Second');box.enqueue();box.saveDraft('Current draft');
 const pending=box.flush(),heldKey=prefix+first.idempotency_key;
 const request={...first};
 if(failure==='conversation') request.conversation_id=key;
 if(failure==='idempotency_key') request.idempotency_key=key;
 const raw=failure==='corrupt'?'{':JSON.stringify({kind:'submitting',request});
 if(failure==='storage') storage.setItem=()=>{throw Error('access denied');};
 else {storage.setItem(heldKey,raw);assert.deepEqual(box.recovery(),[heldKey]);}
 finish();
 if(failure==='storage') {await assert.rejects(pending,/access denied/);assert.equal(calls.length,1);return;}
 await pending;
 assert.equal(storage.getItem(heldKey),raw,'receipt must preserve held bytes');
 assert.deepEqual(box.recovery(),[heldKey]);
 assert.deepEqual(calls.map(r=>r.body),['First','Second']);
 assert.deepEqual(calls[0],first);assert.equal(box.entries()[0].kind,'accepted');assert.equal(box.draft(),'Current draft');
 const reopened=setup(storage);reopened.connect();await reopened.box.flush();
 assert.equal(reopened.calls.length,0);assert.deepEqual(reopened.box.recovery(),[heldKey]);
 assert.equal(storage.getItem(heldKey),raw);
});
for (const kind of ['queued','unknown','refused','accepted','corrupt']) test(`stop retires ${kind} without changing saved bytes`,async()=>{
 const s=setup(),prefix=`doctorcre:asks:v1:joe:${conversation}:`;
 s.box.saveDraft('Saved');const request=s.box.enqueue();s.box.saveDraft('Current draft');
 s.storage.setItem(prefix+key,kind==='corrupt'?'{':JSON.stringify({kind,request}));
 const before=[...Array(s.storage.length)].map((_,i)=>[s.storage.key(i),s.storage.getItem(s.storage.key(i))]);
 s.box.stop();s.connect();await s.box.flush();await s.box.retry(key);
 assert.equal(s.calls.length,0);
 assert.deepEqual([...Array(s.storage.length)].map((_,i)=>[s.storage.key(i),s.storage.getItem(s.storage.key(i))]),before);
});
test('stop during submission ignores late acceptance and leaves neighbors saved',async()=>{
 const s=setup();s.box.saveDraft('First');s.box.enqueue();s.connect();
 let release;s.sender(request=>new Promise(resolve=>{release=()=>resolve(receipt(request));}));
 const pending=s.box.flush();s.box.saveDraft('Current draft');
 const before=s.storage.getItem(`doctorcre:asks:v1:joe:${conversation}:`+key);
 s.box.stop();release();await pending;await s.box.flush();
 assert.equal(s.calls.length,1);assert.equal(s.box.entries()[0].kind,'submitting');
 assert.equal(s.storage.getItem(`doctorcre:asks:v1:joe:${conversation}:`+key),before);
 assert.equal(s.box.draft(),'Current draft');
});
