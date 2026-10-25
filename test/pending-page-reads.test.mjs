import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveClient } from '../js/live-client.js';

for (const method of ['getBoard', 'morningBrief']) test(`${method} callers own independent pending snapshots`, async () => {
  const calls = [];
  const fetchImpl = (_path, init) => new Promise(resolve => calls.push({ signal: init.signal,
    finish: value => resolve(Response.json({ result: { content: [{ text: JSON.stringify(value) }] } })) }));
  const a = createLiveClient({ fetchImpl }), b = createLiveClient({ fetchImpl });
  const reads = [a[method](), b[method]()];
  const count = calls.length;
  calls.forEach((call, index) => call.finish({ actor: 'joe', deals: [], sponsor: index ? 'fresh' : 'previous' }));
  const values = await Promise.all(reads);
  assert.equal(count, 2, 'each caller starts its own authorized snapshot');
  assert.equal(values[1].sponsor, 'fresh');
});
