import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runLocalAgent } from '../scripts/e2e-agent-local.mjs';
import { commit, plan, report } from './e2e-ci-fixtures.mjs';

function fixture({ setupFailure = false, missingAction = false, changedHead = false, postFailure = false } = {}) {
  const calls = [];
  let post;
  const command = async (executable, args, options) => {
    calls.push({ executable, args, ...options });
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.env.E2E_OAUTH_CREDENTIALS, undefined, 'reuse the local login store');
    if (executable === 'gh') {
      if (args.includes('--method')) {
        if (postFailure) throw Error('status write denied');
        post = JSON.parse(options.input);
        return { code: 0, stdout: JSON.stringify({ ...post, id: 123 }) };
      }
      return { code: 0, stdout: JSON.stringify({ head: { sha: commit }, html_url: 'https://github.com/jbookout/doctorcre-app/pull/181' }) };
    }
    if (executable === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: changedHead ? 'b'.repeat(40) : commit };
    if (executable === 'npm' && args[0] === 'ci' && setupFailure) return { code: 1 };
    if (executable === 'git' && args[0] === 'worktree') await mkdir(args[3], { recursive: true });
    if (executable === process.execPath && args[0] === 'node_modules/e2e/dist/cli/bin.js') {
      const shard = Number(args[args.indexOf('--shard') + 1]?.split('/')[0]);
      if (args[1] === 'list') return { code: 0, stdout: JSON.stringify({ pairs: shard ? [plan[shard - 1]] : plan }) };
      const value = report(shard);
      value.run.startedAt = new Date().toISOString();
      if (missingAction) value.run.results[shard - 1].attempts[0].steps = [];
      await writeFile(join(options.cwd, `.e2e/ci/shard-${shard}/report.json`), JSON.stringify(value));
    }
    return { code: 0, stdout: '' };
  };
  return { command, calls, get post() { return post; } };
}

test('the local runner pins the PR head, runs both shards, retains reports and posts an advisory status', async () => {
  const fake = fixture();
  const result = await runLocalAgent(181, { command: fake.command, env: { OPENAI_API_KEY: 'synthetic-unused', E2E_OAUTH_CREDENTIALS: 'synthetic-unused' } });
  assert.equal(result.state, 'success');
  assert.equal(result.sha, commit);
  assert.equal(fake.post.context, 'agent-journeys');
  assert.equal(fake.post.state, 'success');
  assert.ok(fake.post.description.includes(result.reportPath));
  assert.ok(fake.post.description.length <= 140);
  const statusCall = fake.calls.find(call => call.args.includes('--method'));
  assert.ok(statusCall.args.includes(`repos/jbookout/doctorcre-app/statuses/${commit}`));
  const checkout = fake.calls.find(call => call.executable === 'git' && call.args[0] === 'worktree');
  assert.equal(checkout.args.at(-1), commit);
  assert.notEqual(checkout.cwd, checkout.args[3], 'the caller checkout stays untouched');
  assert.equal(fake.calls.filter(call => call.args[1] === 'run' && call.args.includes('--shard')).length, 2);
  const aggregate = JSON.parse(await readFile(result.reportPath, 'utf8'));
  assert.equal(aggregate.run.status, 'passed');
  assert.equal(aggregate.run.vcs.commit, commit);
  assert.doesNotMatch(JSON.stringify(fake.calls.map(call => call.args)), /rulesets|branch_protection|login/);
});

for (const options of [{ setupFailure: true }, { missingAction: true }, { changedHead: true }]) {
  test(`local failures post failure on the captured head: ${JSON.stringify(options)}`, async () => {
    const fake = fixture(options);
    const result = await runLocalAgent(181, { command: fake.command, env: {} });
    assert.equal(result.state, 'failure');
    assert.equal(fake.post.state, 'failure');
    assert.equal(result.sha, commit);
    assert.ok(fake.post.description.includes(result.reportPath));
    assert.ok(await readFile(result.reportPath, 'utf8'));
    if (options.changedHead) assert.equal(fake.calls.some(call => call.executable === 'npm'), false);
  });
}

test('the runner refuses hosted CI and invalid PR input before any external effects', async () => {
  const command = () => assert.fail('no external effects allowed');
  for (const env of [{ GITHUB_ACTIONS: 'true' }, { CI: '1' }]) await assert.rejects(runLocalAgent(181, { command, env }), /local Studio/);
  for (const pr of [0, '181;touch marker', -1, 1.5]) await assert.rejects(runLocalAgent(pr, { command, env: {} }), /PR number/);
});

test('a denied status write is surfaced without claiming publication', async () => {
  const fake = fixture({ postFailure: true });
  await assert.rejects(runLocalAgent(181, { command: fake.command, env: {} }), /status write denied/);
  assert.equal(fake.calls.filter(call => call.args.includes('--method')).length, 1, 'do not retry external effects');
});
