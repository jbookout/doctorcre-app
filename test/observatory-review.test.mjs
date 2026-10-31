import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { labelFor } from '../js/observatory-model.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Observatory pins its read operations and exact producer', async () => {
  const contract = JSON.parse(await read('contracts/carr-interface.v1.json'));
  assert.equal(contract.producer.source_commit, '95826fa82e8b6976ad1eb9e8b0c3b19f00f9c925');

  assert.ok(contract.mcp_operations.includes('read-room-latest'));
  assert.ok(contract.mcp_operations.includes('append-tour-selection-cart-version'));
});

test('human labels require an explicitly recorded partner', () => {
  assert.equal(labelFor({ seat: 'human', sponsor: 'joe' }), 'Joe');
  assert.equal(labelFor({ seat: 'human', sponsor: 'dell' }), 'Dell');
  for (const sponsor of [undefined, null, '', 'other', 'constructor', 'toString', '__proto__']) {
    assert.equal(labelFor({ seat: 'human', sponsor }), 'Partner');
  }
});

test('Observatory coexists with the current Progress navigation', async () => {
  for (const retired of ['room.html', 'queue.html', 'js/progress-legacy.js']) await assert.rejects(read(retired), { code: 'ENOENT' });
  assert.match(await read('observatory.html'), /js\/observatory\.js/);
});

test('the active Progress wire replaces the retired room module', async () => {
  await assert.rejects(read('js/room.js'), { code: 'ENOENT' });
  assert.match(await read('js/progress-work.js'), /from ['"]\.\/progress-wire\.js['"]/);
});
