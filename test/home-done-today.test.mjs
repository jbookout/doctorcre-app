import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/ui/home/sections.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { completionGroups, completionLabel, HomeWelcome } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const done = (item_id, completed_at, fields = {}) => ({ item_id, completed_at, source_state: 'done', section: 'done', activity_at: '2026-11-04T16:00:00Z', auto_settled: false, ...fields });
test('done_today_uses_completion_time_not_activity', () => {
  const groups = completionGroups([done('yesterday', '2026-11-04T05:30:00Z'), done('today', '2026-11-04T06:10:00Z')], new Date('2026-11-04T16:00:00Z'));
  assert.deepEqual(groups.today.map(x => x.item_id), ['today']);
  assert.deepEqual(groups.earlier.map(x => x.item_id), ['yesterday']);
});
for (const [label, now, stamps] of [
  ['spring DST', '2026-03-08T18:00:00Z', ['2026-03-08T05:59:59Z', '2026-03-08T06:00:00Z', '2026-03-09T04:59:59Z', '2026-03-09T05:00:00Z']],
  ['fall DST', '2026-11-01T18:00:00Z', ['2026-11-01T04:59:59Z', '2026-11-01T05:00:00Z', '2026-11-02T05:59:59Z', '2026-11-02T06:00:00Z']],
]) test(`${label} uses Chicago midnight, including the whole transition day`, () => {
  const groups = completionGroups(stamps.map((stamp, i) => done(String(i), stamp)), new Date(now));
  assert.deepEqual(groups.today.map(x => x.item_id), ['2', '1']);
  assert.deepEqual(groups.earlier.map(x => x.item_id), ['3', '0']);
});
test('automatic settlement retains completions; manual hiding and reopened work stay out', () => {
  const groups = completionGroups([done('auto', '2026-11-04T06:10:00Z', { auto_settled: true, section: 'settled' }), done('manual', '2026-11-04T06:10:00Z', { section: 'settled' }), done('unknown', null), done('reopened', null, { source_state: 'needs_attention', section: 'inbox' })], new Date('2026-11-04T16:00:00Z'));
  assert.deepEqual(groups.today.map(x => x.item_id), ['auto']);
  assert.deepEqual(groups.earlier.map(x => x.item_id), ['unknown']);
});
const inboxBundle = await build({ entryPoints: ['src/ui/home/fixture.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { fixtureInboxRpc } = await import(`data:text/javascript;base64,${Buffer.from(inboxBundle.outputFiles[0].contents).toString('base64')}`);
const parserBundle = await build({ entryPoints: ['src/ui/home/inbox.tsx'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { parseSnapshot, createInboxClient } = await import(`data:text/javascript;base64,${Buffer.from(parserBundle.outputFiles[0].contents).toString('base64')}`);
test('v4 validates evidence and legacy reads discard any unsupported timestamp', async () => {
  const snapshot = await fixtureInboxRpc()('read-home-inbox-v4');
  assert.equal(parseSnapshot(snapshot).schema_version, 'home-inbox.v4');
  const completed = snapshot.items.find(x => x.source_state === 'done');
  for (const completed_at of [undefined, 'yesterday', '2026-11-04', '2026-11-04T06:10:00', 42]) assert.throws(() => parseSnapshot({ ...snapshot, items: [{ ...completed, completed_at }] }));
  assert.throws(() => parseSnapshot({ ...snapshot, items: [{ ...snapshot.items[0], completed_at: '2026-11-04T06:10:00Z' }] }));
  for (const version of ['v2', 'v3']) assert.equal(parseSnapshot({ ...snapshot, schema_version: `home-inbox.${version}`, auto_settle_enabled: version === 'v3', items: [completed] }).items[0].completed_at, null);
});
test('v4 falls back only for unknown_tool with at most four reads', async () => {
  const snapshot = await fixtureInboxRpc()('read-home-inbox-v3');
  const calls = [];
  const client = createInboxClient(async name => { calls.push(name); return ['read-home-inbox-v5', 'read-home-inbox-v4'].includes(name) ? { error: 'unknown_tool' } : snapshot; });
  assert.equal((await client.read()).items.find(x => x.source_state === 'done').completed_at, null);
  assert.deepEqual(calls, ['read-home-inbox-v5', 'read-home-inbox-v4', 'read-home-inbox-v3']);
  for (const payload of [{ error: 'partner_required' }, { ...snapshot, schema_version: 'home-inbox.v4', items: [{}] }]) {
    let count = 0;
    await assert.rejects(createInboxClient(async () => { count++; return payload; }).read());
    assert.equal(count, 1);
  }
  let count = 0;
  await assert.rejects(createInboxClient(async () => { count++; return { error: 'unknown_tool' }; }).read());
  assert.equal(count, 4);
});
test('reopen then recomplete uses latest source completion, with exact retry identity', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-04T05:30:00Z') });
  const rpc = fixtureInboxRpc();
  const initial = await rpc('read-home-inbox-v4');
  const item = initial.items.find(x => x.item_id === 'demo-review');
  const complete = { action_id: item.action_id, base_version: item.action_version, idempotency_key: 'first' };
  const receipt = await rpc('complete-one-action', complete);
  const first = (await rpc('read-home-inbox-v4')).items.find(x => x.item_id === item.item_id);
  assert.equal(first.completed_at, '2026-11-04T05:30:00.000Z');
  assert.deepEqual(await rpc('complete-one-action', complete), receipt);
  await rpc('reopen-one-action', { action_id: item.action_id, base_version: receipt.version, completion_event_id: receipt.completion_event_id, idempotency_key: 'reopen' });
  const reopened = (await rpc('read-home-inbox-v4')).items.find(x => x.item_id === item.item_id);
  assert.equal(reopened.completed_at, null);
  assert.equal(completionGroups([reopened], new Date()).today.length, 0);
  t.mock.timers.tick(40 * 60 * 1000);
  await rpc('complete-one-action', { action_id: item.action_id, base_version: reopened.action_version, idempotency_key: 'second' });
  const second = (await rpc('read-home-inbox-v4')).items.find(x => x.item_id === item.item_id);
  assert.equal(second.completed_at, '2026-11-04T06:10:00.000Z');
  assert.equal(completionGroups([first], new Date(second.completed_at)).today.length, 0);
  assert.deepEqual(completionGroups([second], new Date(second.completed_at)).today.map(x => x.item_id), [item.item_id]);
});

test('completion grouping has a fixed formatter setup cost across repeated 1000-card snapshots', async () => {
  const { runInNewContext } = await import('node:vm');
  const compiled = await build({ entryPoints: ['src/ui/home/sections.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs' });
  let constructors = 0;
  const DateTimeFormat = new Proxy(Intl.DateTimeFormat, { construct(target, args) { constructors++; return Reflect.construct(target, args); } });
  const sandbox = { exports: {}, Intl: { DateTimeFormat }, Date, process: { env: { NODE_ENV: 'production' } } };
  sandbox.module = { exports: sandbox.exports };
  runInNewContext(compiled.outputFiles[0].text, sandbox);
  const snapshot = await fixtureInboxRpc()('read-home-inbox-v4');
  const completed = snapshot.items.find(item => item.source_state === 'done');
  const { items } = parseSnapshot({ ...snapshot, items: Array.from({ length: 1000 }, (_, index) => ({ ...completed, item_id: String(index), completed_at: index % 2 ? '2026-11-04T06:10:00Z' : '2026-11-03T06:10:00Z' })) });
  for (let index = 0; index < 3; index++) {
    const grouped = sandbox.module.exports.completionGroups(items, new Date('2026-11-04T18:00:00Z'));
    assert.equal(grouped.today.length, 500);
    assert.equal(grouped.earlier.length, 500);
  }
  assert.equal(constructors, 3);
  assert.ok(constructors <= 3, `formatter setup must be bounded independently of snapshot size, got ${constructors}`);
});


test('pooled formatters preserve per-input Chicago strings across DST and midnight', async t => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  for (const [stamp, expected] of [
    ['2026-03-08T07:59:00Z', 'Done Mar 8, 2026, 1:59 AM CST'],
    ['2026-03-08T08:00:00Z', 'Done Mar 8, 2026, 3:00 AM CDT'],
    ['2026-11-01T06:59:00Z', 'Done Nov 1, 2026, 1:59 AM CDT'],
    ['2026-11-01T07:00:00Z', 'Done Nov 1, 2026, 1:00 AM CST'],
  ]) assert.equal(completionLabel(done('timestamp', stamp)), expected);
  assert.equal(completionLabel(done('undated', null)), 'Done, time not recorded');
  const completed = done('midnight', '2026-11-04T06:10:00Z');
  assert.equal(completionGroups([completed], new Date('2026-11-05T05:59:59Z')).today.length, 1);
  assert.equal(completionGroups([completed], new Date('2026-11-05T06:00:00Z')).today.length, 0);
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T05:59:59Z') });
  assert.match(renderToStaticMarkup(HomeWelcome()), /Wednesday, November 4/);
  t.mock.timers.tick(1000);
  assert.match(renderToStaticMarkup(HomeWelcome()), /Thursday, November 5/);
});
