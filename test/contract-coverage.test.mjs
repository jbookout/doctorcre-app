import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const assertProducerReference = producer => {
  assert.equal(producer.repository, 'jbookout/carr-system');
  assert.match(producer.source_commit, /^[a-f0-9]{40}$/);
};

test('every literal browser MCP call is pinned in the versioned interface', async () => {
  const contract = JSON.parse(await read('contracts/carr-interface.v1.json'));
  const names = new Set();
  for (const path of ['js/live-client.js', 'js/leads-client.js']) {
    const source = await read(path);
    for (const match of source.matchAll(/\b(?:rpc|write)\s*\(\s*['"]([a-z][a-z-]+)['"]/g)) names.add(match[1]);
  }
  const missing = [...names].filter(name => !contract.mcp_operations.includes(name)).sort();
  assert.deepEqual(missing, [], 'browser MCP calls missing from the versioned interface');
  assert.deepEqual(contract.mcp_operations, [...new Set(contract.mcp_operations)].sort(),
    'the pinned operations stay unique and sorted');
  assertProducerReference(contract.producer);
});

test('Tour client feedback endpoints remain in the versioned interface', async () => {
  const contract = JSON.parse(await read('contracts/carr-interface.v1.json'));
  for (const path of ['/api/share/feedback', '/api/share/shortlist', '/api/share/comment', '/api/tours/feedback'])
    assert.ok(contract.http_surfaces.includes(path), `${path} is missing from the feedback interface`);
});

test('vendor directory revision, selector and content digest are pinned together', async () => {
  const contract = JSON.parse(await read('contracts/carr-interface.v1.json'));
  const source = await read(contract.vendor_directory.path);
  const directory = JSON.parse(source);
  assert.equal(directory.schema, contract.vendor_directory.schema);
  assert.equal(directory.version, contract.vendor_directory.version);
  assert.equal(createHash('sha256').update(source).digest('hex'), contract.vendor_directory.sha256);
  assert.equal(contract.vendor_directory.request_selector, 'contract=vendor-directory.v1');
  assert.ok(contract.mcp_operations.includes('update-vendor'));
});

test('the inherited vendor directory records its own exact producer reference', async () => {
  const contract = JSON.parse(await read('contracts/carr-interface.v1.json'));
  assertProducerReference(contract.vendor_directory.producer);
});

test('the merged interface records the Leads and relationship schemas and producer reference', async () => {
  const contract = JSON.parse(await read('contracts/carr-interface.v1.json'));
  assertProducerReference(contract.lead_workspace.producer);
  assert.equal(contract.lead_workspace.schema_version, 'lead-workspace.v1');
  assert.equal(contract.relationship_network.schema, 'carr-relationship-network.v1');
  for (const retired of ['claim-card', 'promote-pool', 'decline-candidate']) assert.ok(!contract.mcp_operations.includes(retired));
});

test('Doc activity records a feature producer reference alongside the merged interface', async () => {
  const contract = JSON.parse(await read('contracts/carr-interface.v1.json'));
  assertProducerReference(contract.mcp_read_contracts.doc_activity.producer);
});
