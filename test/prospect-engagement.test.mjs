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
