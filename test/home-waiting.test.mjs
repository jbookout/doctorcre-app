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
test('v5 validates identities and legacy fields never enable waiting controls', async () => {
  const snapshot = await fixtureInboxRpc()('read-home-inbox-v5', {});
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
  assert.deepEqual(calls.slice(-2).map(row => row.name), ['set-home-waiting', 'read-home-inbox-v5']);
  await client.wait(request);
  assert.deepEqual(calls.filter(row => row.name === 'set-home-waiting').map(row => row.args), [request.args, request.args]);
  await assert.rejects(client.wait({ ...request, args: { ...request.args, idempotency_key: crypto.randomUUID() } }), error => error.payload.error === 'version_conflict');
});
for (const code of ['network_error', 'partner_required']) test(`v5 ${code} never falls back`, async () => {
  const calls = [];
  const client = api.createInboxClient(async name => { calls.push(name); throw Object.assign(Error(code), { payload: { error: code } }); });
  await assert.rejects(client.read()); assert.deepEqual(calls, ['read-home-inbox-v5']);
});

test('waiting_picker_offers_actors_and_searched_parties', async () => {
  const calls = [];
  const id = '00000000-0000-0000-0000-000000000071';
  const cursor = { query: 'alex', name: 'Alex A', id };
  const client = api.createInboxClient(async (name, args) => {
    calls.push({ name, args });
    if (name === 'read-actor-roster-v1') return { ok: true, schema_version: 'actor-roster.v1', actors: [
      { id, slug: 'demo-human', display_name: 'Demo human', kind: 'human' },
      { id: '00000000-0000-0000-0000-000000000072', slug: 'bot', display_name: 'Demo bot', kind: 'automation' }
    ] };
    return { ok: true, schema_version: 'party-search.v1', parties: [{ id, display_name: 'Alex A', kind: 'person' }], next_cursor: args.cursor ? null : cursor };
  });
  assert.deepEqual(await client.actors(), [{ kind: 'actor', id, name: 'Demo human' }]);
  assert.deepEqual(await client.search('  Alex  '), { choices: [{ kind: 'party', id, name: 'Alex A' }], next_cursor: cursor });
  assert.equal((await client.search('Alex', cursor)).next_cursor, null);
  assert.deepEqual(calls[1], { name: 'search-parties-v1', args: { query: 'Alex', limit: 25 } });
  assert.deepEqual(calls[2].args.cursor, cursor);
});
for (const thrown of [false, true]) test(`directory unknown_tool supports contact fallback (${thrown})`, async () => {
  const rpc = fixtureInboxRpc();
  const client = api.createInboxClient(async (name, args) => {
    if (['read-actor-roster-v1', 'search-parties-v1'].includes(name)) {
      if (thrown) throw Object.assign(Error('unavailable'), { payload: { error: 'unknown_tool' } });
      return { error: 'unknown_tool' };
    }
    return rpc(name, args);
  });
  assert.equal(await client.actors(), null);
  assert.equal(await client.search('Demo'), null);
  assert.equal((await client.choices()).length, 2);
});
test('directory refuses malformed identities, cursors and non-capability failures', async () => {
  for (const response of [
    null,
    { ok: true, schema_version: 'party-search.v1', parties: [{ id: 'invented', display_name: 'Invented', kind: 'person' }], next_cursor: null },
    { ok: true, schema_version: 'party-search.v1', parties: [], next_cursor: { query: 'other', name: 'Other', id: '00000000-0000-0000-0000-000000000071' } }
  ]) await assert.rejects(api.createInboxClient(async () => response).search('Demo'));
  let calls = 0;
  const client = api.createInboxClient(async () => { calls++; throw Object.assign(Error('network'), { payload: { error: 'network_error' } }); });
  await assert.rejects(client.actors());
  await assert.rejects(client.search('Demo'));
  await assert.rejects(client.search('   '));
  await assert.rejects(client.search('x'.repeat(101)));
  assert.equal(calls, 2);
});

test('v4 renders without waiting identity while v5 requires and displays it', async () => {
  const rpc = fixtureInboxRpc();
  const v4 = await rpc('read-home-inbox-v4', {});
  assert.ok(v4.items.every(item => !('waiting_version' in item) && !('waiting_on' in item)));
  const legacy = api.parseSnapshot(v4);
  assert.ok(legacy.items.length > 0);
  assert.ok(legacy.items.every(item => api.waitingLabel(item) === null));
  const v5 = await rpc('read-home-inbox-v5', {});
  const row = v5.items[0];
  const waiting = { identity: { kind: 'party', id: '00000000-0000-0000-0000-000000000001', available: true, display_name: 'Demo reviewer' }, reason: 'Review', evidence: ['source:demo'], version: 1 };
  assert.equal(api.waitingLabel(api.parseSnapshot({ ...v5, items: [{ ...row, waiting_version: 1, waiting_on: waiting }] }).items[0]), 'Waiting on Demo reviewer');
  for (const schema_version of ['home-inbox.v2', 'home-inbox.v3', 'home-inbox.v4']) {
    const parsed = api.parseSnapshot({ ...v5, schema_version, auto_settle_enabled: schema_version !== 'home-inbox.v2' });
    assert.ok(parsed.items.every(item => item.waiting_version === undefined));
  }
});
test('v5 unsupported falls back through every legacy version only for unknown_tool', async () => {
  for (const supported of ['v5', 'v4', 'v3', 'v2']) {
    const calls = []; const rpc = fixtureInboxRpc();
    const client = api.createInboxClient(async (name, args) => {
      calls.push(name);
      return name === `read-home-inbox-${supported}` ? rpc(name, args) : { error: 'unknown_tool' };
    });
    const snapshot = await client.read();
    assert.equal(snapshot.schema_version, `home-inbox.${supported}`);
    assert.deepEqual(calls, ['v5', 'v4', 'v3', 'v2'].slice(0, ['v5', 'v4', 'v3', 'v2'].indexOf(supported) + 1).map(v => `read-home-inbox-${v}`));
  }
});
