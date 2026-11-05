import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const load = async entry => {
  const bundle = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
};
const { parseActionReceipt, completeAction } = await load('src/ui/home/task-done.ts');
const { createInboxClient, taskCommand } = await load('src/ui/home/inbox.tsx');
const event = '00000000-0000-4000-8000-000000000009';
const args = { action_id: '00000000-0000-4000-8000-000000000002', base_version: 1, idempotency_key: '00000000-0000-4000-8000-000000000003' };
const receipt = { ok: true, action_id: args.action_id, version: 2, status: 'done', completion_event_id: event };
for (const [name, fields] of [['absent', { completion_event_id: undefined }], ['null', { completion_event_id: null }], ['malformed', { completion_event_id: 'bad' }], ['number', { completion_event_id: 4 }], ['unrelated', { action_id: event }], ['contradictory', { status: 'open' }], ['stale', { version: 1 }], ['unsafe', { version: Number.MAX_SAFE_INTEGER + 1 }]]) {
  test(`done refuses ${name} receipt`, async () => {
    const value = { ...receipt, ...fields };
    if (name === 'absent') delete value.completion_event_id;
    assert.throws(() => parseActionReceipt(value, args, 'done'));
    await assert.rejects(completeAction({ completeOneAction: async () => value }, args));
  });
}
test('completeAction retries exact request after missing event', async () => {
  const writes = [];
  const client = { completeOneAction: async value => { writes.push(structuredClone(value)); return writes.length === 1 ? { ok: true, action_id: args.action_id, version: 2, status: 'done' } : receipt; } };
  await assert.rejects(completeAction(client, args));
  assert.equal((await completeAction(client, args)).completion_event_id, event);
  assert.deepEqual(writes, [args, args]);
});
test('reopen admits only the original completion event', () => {
  const reopen = { ...args, base_version: 2, completion_event_id: event };
  assert.equal(parseActionReceipt({ ...receipt, version: 3, status: 'open' }, reopen, 'open').completion_event_id, event);
  for (const completion_event_id of [undefined, null, 'bad', args.action_id]) assert.throws(() => parseActionReceipt({ ...receipt, version: 3, status: 'open', completion_event_id }, reopen, 'open'));
});
const item = fields => ({ completed_at: null, auto_settled: false, item_id: 'synthetic', source_type: 'next_action', source_id: args.action_id, source_version: 's1', source_state: 'needs_attention', title: 'Synthetic task', activity_at: '2026-10-30T12:00:00Z', hold_until: null, unseen: false, disposition: 'inbox', snoozed_until: null, explicit_unsettle: false, section: 'inbox', base_version: 'opaque:1', context_label: null, due_on: null, open_url: null, kind_label: 'Task', merged_source_ids: [], action_id: args.action_id, action_version: 1, deal_id: null, ...fields });
test('actual Home client requires event before readback and recovers by exact replay', async () => {
  let attempts = 0, reads = 0;
  const writes = [];
  const current = item({ source_state: 'done', action_version: 2 });
  const client = createInboxClient(async (name, value) => {
    if (name === 'read-home-inbox-v4') return { error: 'unknown_tool' };
    if (name === 'read-home-inbox-v3') { reads++; return { ok: true, schema_version: 'home-inbox.v3', truncated: false, limit: 1000, items: [current], working_collapsed: true, auto_settle_enabled: true }; }
    writes.push(structuredClone(value));
    if (name === 'reopen-one-action') { Object.assign(current, { source_state: 'needs_attention', action_version: 3 }); return { ...receipt, version: 3, status: 'open' }; }
    return ++attempts === 1 ? { ok: true, action_id: args.action_id, version: 2, status: 'done' } : receipt;
  });
  const request = taskCommand('complete', item());
  await assert.rejects(client.run(request));
  assert.equal(reads, 0);
  const [result] = await client.run(request);
  assert.equal(result.ok, true);
  assert.deepEqual(writes[0], writes[1]);
  const [undone] = await client.run(taskCommand('reopen', result.item, result.receipt));
  assert.equal(undone.ok, true);
  assert.equal(writes[2].completion_event_id, event);
});

test('Home readback failure retains request and stale version refreshes before a new write', async () => {
  const { JSDOM } = await import('jsdom');
  const { complete, retain } = await load('src/ui/home/task-done.ts');
  const dom = new JSDOM(`<main><button data-task-done="${args.action_id}" data-deal="synthetic" data-version="1">Done</button></main>`);
  const host = dom.window.document.querySelector('main'), button = host.querySelector('button');
  const snapshot = { details: new Map([['synthetic', { next_actions: [{ id: args.action_id, status: 'open' }] }]]) };
  let reads = 0, updates = 0;
  const writes = [];
  const client = { completeOneAction: async value => { writes.push(structuredClone(value)); return writes.length === 3 ? { error: 'version_conflict' } : receipt; }, getDeal: async () => { if (++reads === 1) throw Error('Read unavailable'); return { next_actions: [{ id: args.action_id, status: writes.length === 3 ? 'open' : 'done' }] }; } };
  await complete(host, button, client, () => updates++, () => true, snapshot);
  assert.equal(updates, 0);
  await complete(host, button, client, () => updates++, () => true, snapshot);
  assert.equal(updates, 1);
  assert.deepEqual(writes[0], writes[1]);
  await complete(host, button, client, () => updates++, () => true, snapshot);
  assert.equal(updates, 2);
  assert.notEqual(writes[2].idempotency_key, writes[1].idempotency_key);
  assert.match(host.textContent, /changed/);
  const fresh = { details: new Map([['synthetic', { next_actions: [] }]]) };
  retain(host, fresh);
  assert.equal(fresh.details.get('synthetic').next_actions.length, 0);
  dom.window.close();
});
test('unavailable task operation retires controls and stops subsequent writes', async () => {
  const { JSDOM } = await import('jsdom');
  const { complete } = await load('src/ui/home/task-done.ts');
  const dom = new JSDOM(`<main><button data-task-done="${args.action_id}" data-deal="synthetic" data-version="1">Done</button></main>`);
  const host = dom.window.document.querySelector('main'), button = host.querySelector('button');
  let writes = 0;
  const client = { completeOneAction: async () => { writes++; throw Object.assign(Error('Unavailable'), { rpcCode: -32601 }); }, getDeal: async () => { throw Error('Unexpected read'); } };
  await complete(host, button, client, () => assert.fail('Unexpected update'), () => true, null);
  assert.equal(host.querySelector('button'), null);
  await complete(host, button, client, () => assert.fail('Unexpected update'), () => true, null);
  assert.equal(writes, 1);
  dom.window.close();
});
test('disposed Home ignores a late completion reply', async () => {
  const { JSDOM } = await import('jsdom');
  const { complete } = await load('src/ui/home/task-done.ts');
  const dom = new JSDOM(`<main><button data-task-done="${args.action_id}" data-deal="synthetic" data-version="1">Done</button></main>`);
  const host = dom.window.document.querySelector('main'), button = host.querySelector('button');
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let current = true;
  const request = complete(host, button, { completeOneAction: () => pending, getDeal: async () => ({ next_actions: [{ id: args.action_id, status: 'done' }] }) }, () => assert.fail('Disposed view updated'), () => current, null);
  current = false; host.remove(); release(receipt);
  await request;
  dom.window.close();
});
