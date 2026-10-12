import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
  assert.match(ci, /name: performance-\$\{\{ github.sha \}\}-\$\{\{ github.run_attempt \}\}/);
  assert.match(publisher, /RUN_ATTEMPT: \$\{\{ github.event.workflow_run.run_attempt \}\}/);
  assert.match(publisher, /endswith\("-"\+env.RUN_ATTEMPT\)/);
});

// Runs the publisher CLI against a fake `gh` on PATH that serves one PR and a
// paginated comment list, and records every call it receives.
const head = 'a'.repeat(40);
const fakeGh = `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
const args = process.argv.slice(2);
const method = args[args.indexOf('-X') + 1], path = args[args.indexOf('-X') + 2];
const input = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ method, path, input }) + '\\n');
const url = new URL(path, 'https://api.invalid/');
if (url.pathname === '/repos/jbookout/doctorcre-app/pulls/172') process.stdout.write(JSON.stringify(state.pr));
else if (url.pathname === '/repos/jbookout/doctorcre-app/issues/172/comments' && method === 'GET') {
  const size = Number(url.searchParams.get('per_page')), page = Number(url.searchParams.get('page'));
  process.stdout.write(JSON.stringify(state.comments.slice((page - 1) * size, page * size)));
} else process.stdout.write(JSON.stringify({ id: 1 }));
`;
const budget = JSON.parse(readFileSync(new URL('../contracts/performance-budget.v1.json', import.meta.url), 'utf8'));
const validReport = () => {
  const screens = Object.fromEntries(Object.entries(budget.screens).map(([id, metrics]) =>
    [id, Object.fromEntries(Object.entries(metrics).map(([metric, { baseline }]) => [metric, baseline]))]));
  return { schema: 'doctorcre-performance-report.v1', prHeadCommit: head, sourceCommit: 'b'.repeat(40), buildDigest: 'c'.repeat(64),
    profile: budget.profile, screens, bundle: { jsBytes: budget.bundle.jsBytes.baseline, gzipBytes: 1000 }, evaluatedBudget: budget };
};
const marked = (id, login) => ({ id, body: '<!-- doctorcre-performance-budget -->\nold', user: { login } });
function publish({ report = validReport(), pr = { state: 'open', head: { sha: head } }, comments = [], args } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'doctorcre-comment-'));
  writeFileSync(join(dir, 'gh'), fakeGh);
  chmodSync(join(dir, 'gh'), 0o755);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ pr, comments }));
  writeFileSync(join(dir, 'report.json'), typeof report === 'string' ? report : JSON.stringify(report));
  writeFileSync(join(dir, 'calls.log'), '');
  const run = spawnSync(process.execPath, ['scripts/performance-comment.mjs', ...(args ?? [join(dir, 'report.json'), '172', head])], {
    encoding: 'utf8', env: { ...process.env, PATH: dir + delimiter + process.env.PATH, GITHUB_REPOSITORY: 'jbookout/doctorcre-app',
      FAKE_GH_STATE: join(dir, 'state.json'), FAKE_GH_LOG: join(dir, 'calls.log') } });
  const calls = readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { ...run, calls, writes: calls.filter(call => call.method !== 'GET') };
}

test('the publisher CLI finds the trusted comment on a later page and updates it', () => {
  const comments = [...Array.from({ length: 100 }, (_, id) => ({ id: id + 1, body: 'chatter', user: { login: 'someone' } })),
    marked(500, 'untrusted'), marked(501, 'github-actions[bot]')];
  const run = publish({ comments });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.calls.filter(call => call.method === 'GET').map(call => call.path), [
    'repos/jbookout/doctorcre-app/pulls/172',
    'repos/jbookout/doctorcre-app/issues/172/comments?per_page=100&page=1',
    'repos/jbookout/doctorcre-app/issues/172/comments?per_page=100&page=2']);
  assert.equal(run.writes.length, 1);
  assert.equal(run.writes[0].method, 'PATCH');
  assert.equal(run.writes[0].path, 'repos/jbookout/doctorcre-app/issues/comments/501');
  assert.match(run.writes[0].input.body, /\| bundle \| jsBytes \|.*\| PASS \|/);
  assert.match(run.writes[0].input.body, new RegExp(`PR head: \`${head}\``));
});

test('the publisher CLI creates the first report when no trusted comment exists', () => {
  const run = publish({ comments: [marked(9, 'untrusted')] });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.writes.map(call => [call.method, call.path]), [['POST', 'repos/jbookout/doctorcre-app/issues/172/comments']]);
});

test('a stale head or closed PR leaves every comment unchanged', () => {
  for (const pr of [{ state: 'open', head: { sha: 'd'.repeat(40) } }, { state: 'closed', head: { sha: head } }]) {
    const run = publish({ pr, comments: [marked(1, 'github-actions[bot]')] });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Superseded report; no comment changed/);
    assert.deepEqual(run.writes, []);
  }
});

test('invalid bindings and malformed artifacts are refused without writing', () => {
  const cases = [
    ['invalid PR binding', { args: ['report.json', '172', 'not-a-sha'] }],
    ['report source binding mismatch', { report: { ...validReport(), prHeadCommit: 'e'.repeat(40) } }],
    ['report source binding mismatch', { report: { ...validReport(), buildDigest: 'short' } }],
    ['invalid schema', { report: { ...validReport(), evaluatedBudget: undefined } }],
    ['invalid evidence or budget: bundle jsBytes', { report: { ...validReport(), bundle: { jsBytes: -1, gzipBytes: 1000 } } }],
    ['invalid gzip size', { report: { ...validReport(), bundle: { ...validReport().bundle, gzipBytes: 0 } } }],
    ['JSON', { report: '{not json' }],
  ];
  for (const [pattern, options] of cases) {
    const run = publish({ ...options, comments: [marked(1, 'github-actions[bot]')] });
    assert.equal(run.status, 1, pattern);
    assert.match(run.stderr, new RegExp(`performance-comment: refused: .*${pattern}`), pattern);
    assert.deepEqual(run.writes, [], pattern);
  }
});
