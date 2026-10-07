import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { labelFor } from '../js/observatory-model.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Observatory extends the current contract under a new version and exact producer', async () => {
  const contract = JSON.parse(await read('contracts/carr-interface.v1.json'));
  assert.equal(contract.version, '1.44.0');
  assert.equal(contract.producer.source_commit, 'b8e044ace2ef2270ab75d63a628448e04e392e81');
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
  assert.match(await read('room.html'), /progress-legacy\.js/);
  assert.match(await read('observatory.html'), /js\/observatory\.js/);
});

test('the active Progress wire replaces the retired room module', async () => {
  await assert.rejects(read('js/room.js'), { code: 'ENOENT' });
  assert.match(await read('js/progress-work.js'), /from ['"]\.\/progress-wire\.js['"]/);
});
