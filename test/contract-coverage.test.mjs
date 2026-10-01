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
    '0cc6fe2538a81521bf8c25b0df58aa4063ed614b',
    'the pinned CARR main source contains Codex sessions, Tour search/cart and client feedback');
});

test('Tour client feedback endpoints have an explicit contract newer than the prior search/cart interface', async () => {
  const contract = JSON.parse(await read('contracts/carr-interface.v1.json'));
  assert.equal(contract.version, '1.35.0');
  for (const path of ['/api/share/feedback', '/api/share/shortlist', '/api/share/comment', '/api/tours/feedback'])
    assert.ok(contract.http_surfaces.includes(path), `${path} is missing from the feedback interface`);
});
