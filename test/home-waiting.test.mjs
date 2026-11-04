import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/ui/home/inbox.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
test('waiting_on_shows_recorded_person_never_invented', () => {
  const item = { waiting_version: 1, waiting_on: { identity: { kind: 'party', id: '00000000-0000-0000-0000-000000000001', available: true, display_name: 'Demo reviewer' }, reason: 'Review lease', evidence: ['call:demo'], version: 1 }, source_state: 'needs_attention', section: 'inbox' };
  assert.equal(api.waitingLabel(item), 'Waiting on Demo reviewer');
  assert.equal(api.waitingLabel({ ...item, waiting_on: null }), 'Waiting on someone · Not recorded');
  for (const section of ['working', 'held', 'snoozed', 'done', 'settled']) assert.equal(api.waitingLabel({ ...item, waiting_on: null, section }), null);
  for (const section of ['working', 'held', 'snoozed']) assert.equal(api.waitingLabel({ ...item, section }), 'Waiting on Demo reviewer');
  for (const section of ['done', 'settled']) assert.equal(api.waitingLabel({ ...item, section }), null);
  assert.equal(api.waitingLabel({ ...item, waiting_version: undefined }), null);
  assert.equal(api.waitingLabel({ ...item, waiting_on: { ...item.waiting_on, identity: { ...item.waiting_on.identity, available: false, display_name: null } } }), 'Waiting on someone · Identity unavailable');
});

const fixtureBundle = await build({ entryPoints: ['src/ui/home/fixture.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { fixtureInboxRpc } = await import(`data:text/javascript;base64,${Buffer.from(fixtureBundle.outputFiles[0].contents).toString('base64')}`);
test('v4 validates identities and legacy fields never enable waiting controls', async () => {
  const snapshot = await fixtureInboxRpc()('read-home-inbox-v4', {});
  const row = snapshot.items[0];
  const waiting = { identity: { kind: 'party', id: '00000000-0000-0000-0000-000000000001', available: true, display_name: 'Demo person' }, reason: 'Review', evidence: ['source:demo'], version: 1 };
  for (const fields of [{ waiting_version: -1 }, { waiting_version: 1, waiting_on: { ...waiting, version: 2 } }, { waiting_version: 1, waiting_on: { ...waiting, identity: { ...waiting.identity, display_name: null } } }]) assert.throws(() => api.parseSnapshot({ ...snapshot, items: [{ ...row, ...fields }] }));
  const legacy = api.parseSnapshot({ ...snapshot, schema_version: 'home-inbox.v3' });
  assert.equal(api.waitingLabel(legacy.items[0]), null);
});
test('one waiting write uses both versions and canonical readback; stale writes refuse', async () => {
  const rpc = fixtureInboxRpc(); const calls = [];
  const client = api.createInboxClient(async (name, args) => { calls.push({ name, args }); return rpc(name, args); });
  const [item] = (await client.read()).items;
  const [target] = await client.choices();
  const request = { action: 'set', args: { idempotency_key: crypto.randomUUID(), item_id: item.item_id, item_version: item.base_version, base_version: 0, reason: 'Lease review', evidence: ['source:demo'], target: { kind: target.kind, id: target.id } } };
  const next = await client.wait(request);
  assert.equal(next.waiting_on.identity.display_name, 'Demo reviewer');
  assert.deepEqual(calls.slice(-2).map(row => row.name), ['set-home-waiting', 'read-home-inbox-v4']);
  await client.wait(request);
  assert.deepEqual(calls.filter(row => row.name === 'set-home-waiting').map(row => row.args), [request.args, request.args]);
  await assert.rejects(client.wait({ ...request, args: { ...request.args, idempotency_key: crypto.randomUUID() } }), error => error.payload.error === 'version_conflict');
});
for (const code of ['network_error', 'partner_required']) test(`v4 ${code} never falls back`, async () => {
  const calls = [];
  const client = api.createInboxClient(async name => { calls.push(name); throw Object.assign(Error(code), { payload: { error: code } }); });
  await assert.rejects(client.read()); assert.deepEqual(calls, ['read-home-inbox-v4']);
});
