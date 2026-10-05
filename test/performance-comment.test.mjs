import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { upsertComment } from '../scripts/performance-comment.mjs';

test('a repeated report updates the one marked comment', async () => {
  const calls = [];
  const api = {
    comments: async () => [{ id: 5, body: 'unrelated' }, { id: 9, body: '<!-- doctorcre-performance-budget --> old', user: { login: 'github-actions[bot]' } }],
    create: async body => calls.push(['create', body]),
    update: async (id, body) => calls.push(['update', id, body]),
  };
  await upsertComment(api, 'new');
  await upsertComment(api, 'newer');
  assert.deepEqual(calls, [['update', 9, 'new'], ['update', 9, 'newer']]);
});

test('a foreign marker does not prevent creating the first trusted report', async () => {
  const calls = [];
  await upsertComment({ comments: async () => [{ id: 7, body: '<!-- doctorcre-performance-budget -->', user: { login: 'untrusted-contributor' } }],
    create: async body => calls.push(body), update: async () => assert.fail('foreign comment updated') }, 'report');
  assert.deepEqual(calls, ['report']);
});

test('the required test context measures every PR and the writer runs trusted main', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const publisher = readFileSync(new URL('../.github/workflows/performance-report.yml', import.meta.url), 'utf8');
  assert.match(ci, /- run: npm run performance:check\n        if: github.event_name == 'pull_request'/);
  assert.doesNotMatch(ci, /pull-requests: write|continue-on-error:/);
  assert.match(publisher, /workflow_run:/);
  assert.match(publisher, /ref: main/);
  assert.doesNotMatch(publisher, /npm (?:ci|install)|pull_request_target:/);
});
