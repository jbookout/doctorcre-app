import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { previewRepository, downloadPreview, checkedSiteFiles, cleanTargets, liveComment, parseArgs, previewConfig, prNumber, workerName } from '../scripts/pr-preview.mjs';
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
});

test('the generated config takes only main values and hardcodes assets', () => {
  const hostile = { ...base, account_id: 'attacker', compatibility_date: '2020-01-01', compatibility_flags: ['x'],
    main: '../../etc/passwd', assets: { directory: '/Users', binding: 'EVIL', run_worker_first: false },
    services: [{ binding: 'CARR', service: 'prod' }], routes: ['evil.example/*'], vars: { SECRET: 'x' }, workers_dev: false };
  const config = previewConfig(hostile, workerName(7), sha);
  assert.deepEqual(config.assets, { directory: './dist/site', binding: 'ASSETS', run_worker_first: true });
  assert.equal(config.main, 'src/preview-worker.js');
  assert.equal(config.workers_dev, true);
  assert.deepEqual(config.vars, { GIT_SHA: sha });
  for (const key of ['services', 'routes']) assert.equal(key in config, false);
  // main's own values flow through unchanged
  const fromMain = previewConfig(base, workerName(7), sha);
  assert.equal(fromMain.account_id, base.account_id);
  assert.equal(fromMain.compatibility_date, base.compatibility_date);
  assert.deepEqual(fromMain.compatibility_flags, base.compatibility_flags);
  assert.deepEqual(fromMain.assets, base.assets);
});

test('arguments: unknown flags and stray words are rejected, the PR number is normalized', () => {
  assert.deepEqual(parseArgs(['deploy', '280', '--dry-run']), { command: 'deploy', number: '280', dryRun: true });
  assert.deepEqual(parseArgs(['clean']), { command: 'clean', number: null, dryRun: false });
  assert.equal(parseArgs(['deploy', '0280']).number, '280');
  assert.equal(prNumber('007'), '7');
  for (const argv of [['deploy', '280', '--dryrun'], ['deploy'], ['deploy', 'abc'], ['clean', '1', '2'], ['clean', '--force'], ['ship', '1'], [], ['deploy', '0'], ['deploy', '1', '--dry-run', 'x']])
    assert.throws(() => parseArgs(argv), undefined, JSON.stringify(argv));
});

test('cleanup covers closed and merged PRs and never an open one', () => {
  const prs = [{ number: 1, state: 'OPEN' }, { number: 2, state: 'CLOSED' }, { number: 3, state: 'MERGED' }];
  assert.deepEqual(cleanTargets(prs), ['2', '3']);
  assert.deepEqual(cleanTargets(prs, '3'), ['3']);
  assert.throws(() => cleanTargets(prs, '1'), /open/);
  assert.throws(() => cleanTargets(prs, '99'), /unknown/);
});

test('build output must be plain regular files inside dist/site', t => {
  const dir = temporaryDirectory('site-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const site = join(dir, 'site');
  mkdirSync(join(site, 'css'), { recursive: true });
  writeFileSync(join(site, 'index.html'), 'x');
  writeFileSync(join(site, 'css/a.css'), 'x');
  assert.deepEqual(checkedSiteFiles(site).sort(), ['css/a.css', 'index.html']);
  writeFileSync(join(dir, 'secret'), 's');
  symlinkSync(join(dir, 'secret'), join(site, 'leak'));
  assert.throws(() => checkedSiteFiles(site), /symlink/);
  rmSync(join(site, 'leak'));
  writeFileSync(join(site, '.env'), 's');
  assert.throws(() => checkedSiteFiles(site), /dotfile/);
  rmSync(join(site, '.env'));
  assert.throws(() => checkedSiteFiles(site, { files: 1, bytes: 10 }), /larger/);
  const linked = join(dir, 'linked');
  symlinkSync(dir, linked);
  assert.throws(() => checkedSiteFiles(linked), /real directory/);
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

test('local previews only download the exact successful head and never install or build PR code', async () => {
  const run = { databaseId: 17, headSha: sha, status: 'completed', conclusion: 'success' };
  const calls = [];
  const gh = (...args) => { calls.push(args); return JSON.stringify([run]); };
  downloadPreview('7', sha, '/synthetic-assets', gh, 'https://github.com/DoctorCRE/doctorcre-app.git');
  assert.deepEqual(calls.map(args => args.slice(0, 2)), [['run', 'list'], ['run', 'download']]);
  assert.deepEqual(calls[1], ['run', 'download', '17', '--repo', 'DoctorCRE/doctorcre-app', '--name', `pr-preview-7-${sha}`, '--dir', '/synthetic-assets']);
  for (const change of [{ headSha: 'b'.repeat(40) }, { status: 'in_progress' }, { conclusion: 'failure' }]) {
    calls.length = 0;
    assert.throws(() => downloadPreview('7', sha, '/synthetic-assets', (...args) => {
      calls.push(args); return JSON.stringify([{ ...run, ...change }]);
    }, 'https://github.com/DoctorCRE/doctorcre-app.git'), /exact head|completed-success/);
    assert.equal(calls.length, 1, 'refuse before downloading or deploying');
  }
  const source = await readFile(new URL('../scripts/pr-preview.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /previewBuildEnv|sandbox|['"]npm['"]|['"]clone['"]|['"]build['"]/);
});

test('preview checkout admits both app remotes and refuses unrelated repositories', () => {
  for (const prefix of ['https://github.com/', 'git@github.com:', 'ssh://git@github.com/'])
    for (const suffix of ['', '.git']) {
      assert.equal(previewRepository(`${prefix}jbookout/doctorcre-app${suffix}`), 'jbookout/doctorcre-app');
      assert.equal(previewRepository(`${prefix}DoctorCRE/doctorcre-app${suffix}`), 'DoctorCRE/doctorcre-app');
      assert.throws(() => previewRepository(`${prefix}DoctorCRE/other${suffix}`), /origin/);
    }
  assert.throws(() => previewRepository('https://github.com.evil/DoctorCRE/doctorcre-app'), /origin/);
});

for (const repository of ['jbookout/doctorcre-app', 'DoctorCRE/doctorcre-app']) {
  test(`preview lookup and download use the current origin ${repository}`, () => {
    const calls = [];
    const gh = (...args) => {
      calls.push(args);
      assert.equal(args[args.indexOf('--repo') + 1], repository, 'only the current repository exists');
      return JSON.stringify([{ databaseId: 17, headSha: sha, status: 'completed', conclusion: 'success' }]);
    };
    downloadPreview('7', sha, '/synthetic-assets', gh, `https://github.com/${repository}.git`);
    assert.deepEqual(calls.map(args => args.slice(0, 2)), [['run', 'list'], ['run', 'download']]);
  });
}

test('preview lookup refuses an unrelated origin before accessing GitHub', () => {
  let calls = 0;
  assert.throws(() => downloadPreview('7', sha, '/synthetic-assets', () => { calls++; }, 'https://github.com/DoctorCRE/other.git'), /origin/);
  assert.equal(calls, 0);
});

for (const repository of ['jbookout/doctorcre-app', 'DoctorCRE/doctorcre-app']) {
  test(`preview cleanup reads PRs and comments from the current origin ${repository}`, t => {
    const bin = temporaryDirectory('preview-commands-', t);
    const log = join(bin, 'calls.jsonl');
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'config') console.log('git@github.com:${repository}.git');
else if (args[0] === 'rev-parse') console.log('${sha}');
else if (!['fetch', 'status'].includes(args[0])) process.exit(1);
`, { mode: 0o755 });
    writeFileSync(join(bin, 'gh'), String.raw`#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\n');
if (args[0] === 'pr') console.log(JSON.stringify([{ number: 7, state: 'CLOSED' }]));
else if (args[1] === 'user') console.log('fixture-user');
else console.log('17\ttrue');
`, { mode: 0o755 });
    const output = execFileSync(process.execPath, [new URL('../scripts/pr-preview.mjs', import.meta.url).pathname, 'clean', '7', '--dry-run'], {
      env: { ...process.env, PATH: bin + ':' + process.env.PATH }, encoding: 'utf8', timeout: 10000,
    });
    assert.match(output, /no live preview comment/);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls[0], ['pr', 'list', '--state', 'all', '--limit', '200', '--json', 'number,state', '-R', repository]);
    assert.equal(calls[2][2], `repos/${repository}/issues/7/comments`);
    assert.equal(calls.length, 3, 'read-only cleanup skips an already removed preview');
  });
}
