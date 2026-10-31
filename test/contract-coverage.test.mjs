import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { carrInterface } from "./carr-contract.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('deal reads bind vendor assignments and held action history to their producer revisions', async () => {
  const contract = carrInterface;
  for (const verb of ['deal-room-board', 'get-deal-room']) {
    const operation = contract.mcp_read_contracts[verb];
    assert.equal(operation.producer.source_commit, verb === 'get-deal-room'
      ? contract.producer.source_commit : 'b281ef8c69dad3c1dab98229074de1b167f06e02');

    assert.deepEqual(operation.response.vendors.item_keys, ['party_id', 'role', 'company', 'contact', 'note', 'updated_at']);
  }
});

test('every literal browser MCP call is pinned in the versioned interface', async () => {
  const contract = carrInterface;
  const names = new Set();
  for (const path of ['js/live-client.js', 'js/leads-client.js']) {
    const source = await read(path);
    for (const match of source.matchAll(/\b(?:rpc|write)\s*\(\s*['"]([a-z][a-z-]+)['"]/g)) names.add(match[1]);
  }
  const missing = [...names].filter(name => !contract.mcp_operations.includes(name)).sort();
  assert.deepEqual(missing, [], 'browser MCP calls missing from the versioned interface');

});

test('Tour client feedback endpoints have an explicit contract newer than the prior search/cart interface', async () => {
  const contract = carrInterface;
  for (const path of ['/api/share/feedback', '/api/share/shortlist', '/api/share/comment', '/api/tours/feedback'])
    assert.ok(contract.http_surfaces.includes(path), `${path} is missing from the feedback interface`);
});

test('vendor directory revision, selector and content digest are pinned together', async () => {
  const contract = carrInterface;
  const source = await read(contract.vendor_directory.path);
  const directory = JSON.parse(source);
  assert.equal(directory.schema, contract.vendor_directory.schema);
  assert.equal(directory.version, contract.vendor_directory.version);
  assert.equal(createHash('sha256').update(source).digest('hex'), contract.vendor_directory.sha256);
  assert.equal(contract.vendor_directory.request_selector, 'contract=vendor-directory.v1');
  assert.ok(contract.mcp_operations.includes('update-vendor'));
});

test('vendor people pin the negotiated producer revision without changing the v1 contract', async () => {
  const contract = carrInterface;
  const pin = contract.vendor_directory_people;
  assert.equal(pin.request_selector, 'contract=vendor-directory.v2');
  assert.equal(pin.producer.source_commit, '3ade6e86dbf7260114cd64f0b23a80d689b64e15');
  const source = await read(pin.path);
  const directory = JSON.parse(source);
  assert.equal(directory.schema, pin.schema);
  assert.equal(directory.version, '2.0.0');
  assert.equal(createHash('sha256').update(source).digest('hex'), pin.sha256);
});
