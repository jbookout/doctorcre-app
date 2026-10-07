import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { aggregateShards, runShard } from './e2e-ci.mjs';

const repository = 'jbookout/doctorcre-app';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');

function execute(executable, args, { cwd, env, input, capture = false }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { cwd, env, timeout: 1_200_000, stdio: ['pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'] });
    let stdout = '';
    child.stdout?.on('data', bytes => { stdout += bytes; });
    child.stderr?.resume();
    child.on('error', reject);
    child.on('close', code => resolveRun({ code: code ?? 130, stdout }));
    child.stdin.end(input);
  });
}

export async function runLocalAgent(pr, { root = process.cwd(), env = process.env, command = execute } = {}) {
  assert.ok(Number.isSafeInteger(pr) && pr > 0, 'provide a positive PR number');
  assert.ok(env.GITHUB_ACTIONS !== 'true' && ['', '0', 'false'].includes(env.CI ?? ''), 'agent journeys run only on the local Studio, outside CI');
  const localEnv = { ...env, E2E_TELEMETRY_DISABLED: '1' };
  delete localEnv.OPENAI_API_KEY;
  delete localEnv.E2E_OAUTH_CREDENTIALS;
  const run = async (executable, args, cwd = root, options = {}) => {
    const result = await command(executable, args, { cwd, env: localEnv, ...options });
    assert.equal(result.code, 0, `${executable} ${args[0]} failed with exit ${result.code}`);
    return result.stdout?.trim() ?? '';
  };
  const pull = JSON.parse(await run('gh', ['api', `repos/${repository}/pulls/${pr}`], root, { capture: true }));
  const sha = pull.head?.sha;
  assert.match(sha ?? '', /^[a-f0-9]{40}$/, 'PR head must be an exact commit');
  const directory = await mkdtemp(join(tmpdir(), `dcre-agent-${pr}-`));
  const worktree = join(directory, 'worktree');
  const reportPath = join(directory, 'report.json');
  const startedAt = new Date().toISOString();
  let aggregate;
  let error;
  try {
    await run('git', ['fetch', `https://github.com/${repository}.git`, sha]);
    await run('git', ['worktree', 'add', '--detach', worktree, sha]);
    assert.equal(await run('git', ['rev-parse', 'HEAD'], worktree, { capture: true }), sha, 'checked-out PR head differs');
    await run('npm', ['ci'], worktree);
    await run('npm', ['run', 'build'], worktree);
    await run('npm', ['run', 'artifact:verify'], worktree);
    const build = join(directory, 'build');
    await mkdir(build);
    await run('tar', ['-xf', join(worktree, 'dist/doctorcre-app.tar'), '-C', build], worktree);
    const shardEnv = { ...localEnv, SOURCE_COMMIT: sha, BROWSER_PROOF_ROOT: build };
    // Run sequentially to avoid contending for the subscription and browser.
    for (const shard of [1, 2]) await runShard({ shard, root: worktree, env: shardEnv,
      execute: args => command(process.execPath, ['node_modules/e2e/dist/cli/bin.js', ...args], {
        cwd: worktree, env: { ...shardEnv, CI: '1' }, capture: args[0] === 'list',
      }),
    });
    const bundles = [];
    for (const shard of [1, 2]) {
      const path = join(worktree, `.e2e/ci/shard-${shard}`);
      bundles.push({ receipt: await json(join(path, 'receipt.json')),
        first: await json(join(path, 'first.json')).catch(() => undefined),
        final: await json(join(path, 'report.json')).catch(() => undefined) });
      await cp(path, join(directory, `shard-${shard}`), { recursive: true });
    }
    aggregate = aggregateShards(bundles, sha);
  } catch (cause) { error = cause.message; }
  const state = !error && aggregate?.exitCode === 0 ? 'success' : 'failure';
  await save(reportPath, aggregate?.report ?? { schema: 'doctorcre-agent-local-error.v1', sha, startedAt, error });
  const status = { context: 'agent-journeys', state, description: `${state}; ${reportPath}`, target_url: pull.html_url };
  assert.ok(status.description.length <= 140, `report path exceeds the commit status description limit: ${reportPath}`);
  const result = { pr, sha, state, startedAt, finishedAt: new Date().toISOString(), reportPath, worktree, error, status };
  await save(join(directory, 'status.json'), result);
  const posted = JSON.parse(await run('gh', ['api', '--method', 'POST', `repos/${repository}/statuses/${sha}`, '--input', '-'], root,
    { capture: true, input: JSON.stringify(status) }));
  assert.equal(posted.context, status.context, 'GitHub status context differs');
  assert.equal(posted.state, state, 'GitHub status state differs');
  result.statusId = posted.id;
  await save(join(directory, 'status.json'), result);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runLocalAgent(Number(process.argv[2])).then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.state === 'success' ? 0 : 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
