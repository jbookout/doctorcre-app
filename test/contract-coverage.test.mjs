import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('every literal browser MCP call is pinned to a producer revision containing its verb', async () => {
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
  assert.equal(contract.producer.source_commit,
    'f3f57f42a881c103bf3eca14bd69b23bec2b41a1',
    'the pinned CARR source contains Doc activity and the inherited app contracts');
});

test('Tour client feedback endpoints have an explicit contract newer than the prior search/cart interface', async () => {
  const contract = JSON.parse(await read('contracts/carr-interface.v1.json'));
  assert.equal(contract.version, '1.39.0');
  for (const path of ['/api/share/feedback', '/api/share/shortlist', '/api/share/comment', '/api/tours/feedback'])
    assert.ok(contract.http_surfaces.includes(path), `${path} is missing from the feedback interface`);
});
