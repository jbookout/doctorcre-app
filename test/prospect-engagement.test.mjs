import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngagementWriter } from '../js/prospect-engagement.mjs';

const request = (client_id = 'synthetic-a') => ({ client_id, base_version: 7, status: 'inactive',
  reason: 'Synthetic deferral', human_quote: 'Synthetic deferral', expected_actor: 'joe' });
const failure = code => Object.assign(new Error(code), { code, payload: { error: code } });

test('offline retry retains the full uncertain request and key', async () => {
  const sent = [];
  const write = createEngagementWriter(async args => { sent.push(structuredClone(args)); throw failure(sent.length === 1 ? 'unknown_outcome' : 'offline'); });
  await assert.rejects(write(request()), { code: 'unknown_outcome' });
  await assert.rejects(write({ ...request(), reason: 'Changed draft', base_version: 99 }), { code: 'unknown_outcome' });
  assert.deepEqual(sent[1], sent[0]);
  assert.deepEqual(write.get('synthetic-a', 'joe').request, sent[0]);
});

for (const code of ['unknown_outcome', 'internal_error', 'network_error', 'unclassified_error', 'account_changed'])
  test(`${code} keeps the request for identical replay`, async () => {
    const sent = [];
    const write = createEngagementWriter(async args => { sent.push(structuredClone(args)); if (sent.length === 1) throw failure(code); return { ok: true }; });
    await assert.rejects(write(request()), { code: 'unknown_outcome' });
    await write({ ...request(), reason: 'Another draft' });
    assert.deepEqual(sent[1], sent[0]);
    assert.equal(write.get('synthetic-a', 'joe'), undefined);
  });
for (const code of ['version_conflict', 'forbidden', 'not_a_prospect'])
  test(`confirmed ${code} refusal clears only that client`, async () => {
    const write = createEngagementWriter(async () => { throw failure(code); });
    await assert.rejects(write(request()), error => error.code === code);
    assert.equal(write.get('synthetic-a', 'joe'), undefined);
  });
test('acknowledged success clears the pending request', async () => {
  const write = createEngagementWriter(async () => ({ ok: true }));
  await write(request());
  assert.equal(write.get('synthetic-a', 'joe'), undefined);
});
test('two clients write concurrently while one client shares its in-flight request', async () => {
  const releases = [], sent = [];
  const write = createEngagementWriter(args => { sent.push(args); return new Promise(resolve => releases.push(resolve)); });
  const a = write(request()), duplicate = write(request()), b = write(request('synthetic-b'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].idempotency_key, sent[1].idempotency_key);
  releases.forEach(resolve => resolve({ ok: true }));
  await Promise.all([a, duplicate, b]);
  assert.equal(write.values('joe').length, 0);
});
test('refresh restores original requests and isolates actors and clients', async () => {
  const data = new Map();
  const storage = { get length() { return data.size; }, key: i => [...data.keys()][i],
    getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const sent = [];
  let write = createEngagementWriter(async args => { sent.push(args); throw failure('unknown_outcome'); }, { storage });
  await assert.rejects(write(request()));
  await assert.rejects(write(request('synthetic-b')));
  write = createEngagementWriter(async args => { sent.push(args); return { ok: true }; }, { storage });
  assert.equal(write.values('dell').length, 0);
  await write({ ...request(), reason: 'Changed after refresh' });
  assert.deepEqual(sent[2], sent[0]);
  assert.equal(write.values('joe').length, 1);
  assert.equal(data.size, 1);
});
test('read-back requires the same client, target status, and a newer version', async () => {
  const sent = [];
  const write = createEngagementWriter(async args => { sent.push(args); throw failure('unknown_outcome'); });
  await assert.rejects(write(request()));
  assert.equal(write.confirm({ client_id: 'synthetic-other', status: 'inactive', version: 8 }, 'joe'), false);
  assert.equal(write.confirm({ client_id: 'synthetic-a', status: 'active', version: 8 }, 'joe'), false);
  assert.equal(write.confirm({ client_id: 'synthetic-a', status: 'inactive', version: 7 }, 'joe'), false);
  await write(request(), { readBack: async () => ({ client_id: 'synthetic-a', status: 'inactive', version: 8 }) });
  assert.equal(sent.length, 1, 'confirmed read-back never replays');
  assert.equal(write.get('synthetic-a', 'joe'), undefined);
});

test('different transports in one session share the same pending client request', async () => {
 const data=new Map(),sent=[];
 const storage={get length(){return data.size},key:i=>[...data.keys()][i],getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
 const first=createEngagementWriter(async args=>{sent.push(args);throw failure('unknown_outcome')},{storage});
 const second=createEngagementWriter(async args=>{sent.push(args);return {ok:true}},{storage});
 await assert.rejects(first(request()));
 await second({...request(),reason:'Changed transport'});
 assert.deepEqual(sent[1],sent[0]);
 assert.equal(first.values('joe').length,0);
});

test('a completed old flight cannot clear a newer request confirmed by another read',async()=>{
 const releases=[];
 const write=createEngagementWriter(()=>new Promise(resolve=>releases.push(resolve)));
 const first=write(request());await new Promise(resolve=>setImmediate(resolve));
 assert.equal(write.confirm({client_id:'synthetic-a',status:'inactive',version:8},'joe'),true);
 const second=write({...request(),status:'active',base_version:8});await new Promise(resolve=>setImmediate(resolve));
 const current=write.get('synthetic-a','joe').request;
 releases[0]({ok:true});await first;
 assert.deepEqual(write.get('synthetic-a','joe')?.request,current);
 releases[1]({ok:true});await second;
});

test('a read-back that also refreshes shared state completes without replay',async()=>{
 const sent=[];
 const write=createEngagementWriter(async args=>{sent.push(args);throw failure('unknown_outcome')});
 await assert.rejects(write(request()));
 await write(request(),{readBack:async()=>{
  const row={client_id:'synthetic-a',status:'inactive',version:8};
  write.confirm(row,'joe');return row;
 }});
 assert.equal(sent.length,1);
});
