import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLiveClient } from '../js/live-client.js';
import { createFixtureClient } from '../js/fixture-client.js';

test('overdue review client uses the versioned read and exact session-bound resolve and dismiss arguments', async () => {
  const calls = [];
  const client = createLiveClient({ fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: 'joe' }, csrf_token: 'synthetic' });
    const rpc = JSON.parse(init.body); calls.push({ ...rpc.params, csrf: init.headers['x-carr-csrf'] });
    return Response.json({ result: { content: [{ text: JSON.stringify({ ok: true, decision: rpc.params.arguments.decision, action_id: 'demo-action' }) }] } });
  } });
  await client.readDealUpdateReviews();
  assert.deepEqual(calls[0], { name: 'read-deal-update-reviews', arguments: {}, csrf: undefined });
  for (const decision of ['resolve', 'dismiss', 'undo']) {
    const args = { assessment_id: `demo-${decision}`, decision, reason: 'Synthetic partner review', idempotency_key: decision };
    await client.reviewDealUpdate(args);
    assert.deepEqual(calls.at(-1), { name: 'review-deal-update', arguments: args, csrf: 'synthetic' });
  }
  const seedUrl = `data:application/json;base64,${Buffer.from(await readFile(new URL('../data/board-seed.json', import.meta.url))).toString('base64')}`;
  const fixture = await createFixtureClient({ seedUrl });
  assert.deepEqual(await fixture.readDealUpdateReviews(), { schema_version: 'deal-update-reviews.v1', proposals: [] });
  await assert.rejects(fixture.reviewDealUpdate({ assessment_id: 'unknown', decision: 'resolve' }));
});
test('uncertain live reviews retain exact decisions and cannot replay into a changed session', async () => {
  let actor = 'joe', fail = true;
  const calls = [];
  const client = createLiveClient({ fetchImpl: async (path, init) => {
    if (path === '/auth/session') return Response.json({ actor: { slug: actor }, csrf_token: `synthetic-${actor}` });
    const rpc = JSON.parse(init.body); calls.push(rpc.params.arguments);
    if (fail) throw Error('lost response');
    return Response.json({ result: { content: [{ text: JSON.stringify({ ok: true, decision: 'resolve', action_id: 'demo-action' }) }] } });
  } });
  const args = { assessment_id: 'demo-assessment', decision: 'resolve', reason: 'Synthetic review', idempotency_key: 'original-review' };
  await assert.rejects(client.reviewDealUpdate(args));
  actor = 'dell';
  await assert.rejects(client.reviewDealUpdate(args), /Session changed/);
  assert.equal(calls.length, 1);
  actor = 'joe'; fail = false;
  await client.reviewDealUpdate(args);
  assert.deepEqual(calls[1], calls[0]);
});
