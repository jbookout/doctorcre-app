import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { liveComment, previewConfig, workerName } from '../scripts/pr-preview.mjs';
import preview from '../src/preview-worker.js';

const base = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const sha = 'a'.repeat(40);
const env = { GIT_SHA: sha, ASSETS: { fetch: async () => new Response('<h1>page</h1>', { headers: { 'content-type': 'text/html' } }) } };

test('a preview Worker binds no production service, route, secret or environment', () => {
  const config = previewConfig(base, workerName(7), sha);
  assert.equal(config.name, 'doctorcre-app-pr-7');
  assert.equal(config.main, 'src/preview-worker.js');
  assert.deepEqual(config.vars, { GIT_SHA: sha });
  for (const key of ['services', 'routes', 'env', 'kv_namespaces', 'd1_databases', 'r2_buckets', 'observability'])
    assert.equal(key in config, false, `${key} must not reach a preview`);
  assert.equal(config.account_id, base.account_id);
});

test('the PR comment names the URL and commit under one stable marker', () => {
  const body = liveComment('PREVIEW-URL', sha);
  assert.ok(body.startsWith('<!-- doctorcre-pr-preview -->'));
  assert.ok(body.includes('PREVIEW-URL') && body.includes(sha));
});

test('the preview serves pages from its own gate and refuses everything that could reach CARR', async () => {
  const page = await preview.fetch(new Request('https://preview.test/leads'), env);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'(;|$)/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /127\.0\.0\.1/);
  for (const [method, path] of [['POST', '/mcp'], ['GET', '/api/v1/leads'], ['POST', '/leads']]) {
    const response = await preview.fetch(new Request(`https://preview.test${path}`, { method, body: method === 'POST' ? '{}' : undefined }), env);
    assert.ok(response.status >= 400, `${method} ${path} -> ${response.status}`);
  }
});
