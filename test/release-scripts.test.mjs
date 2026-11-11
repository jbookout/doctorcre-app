import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8");

test("the production release script refuses off-main and dirty checkouts, like staging", () => {
  const source = read("release-production.mjs");
  assert.match(source, /sourceCommit !== mainCommit/);
  assert.match(source, /untracked-files=all/);
  assert.match(source, /production releases require a clean checkout/);
});

test("the production release tags production-<sha12> and stamps the full SHA", () => {
  const source = read("release-production.mjs");
  assert.match(source, /`production-\$\{sourceCommit\.slice\(0, 12\)\}`/);
  assert.match(source, /`GIT_SHA:\$\{sourceCommit\}`/);
});

test("the production release has no first-use deploy fallback and targets the root environment", () => {
  const source = read("release-production.mjs");
  assert.doesNotMatch(source, /"wrangler", "deploy"/);
  assert.doesNotMatch(source, /10007/);
  assert.match(source, /"versions", "upload", "--env", ""/);
  assert.match(source, /"versions", "deploy", `\$\{providerVersionId\}@100%`, "--env", ""/);
});

test("the production rollback deploys one exact prior version at 100% on the root environment", () => {
  const source = read("rollback-production.mjs");
  assert.match(source, /"versions", "deploy", `\$\{versionId\}@100%`, "--env", ""/);
  assert.match(source, /rollback:production -- <exact-version-id>/);
});


test("provider scripts never install, build or run tests with a deployment credential", () => {
  for (const name of ["release-production.mjs", "release-staging.py"]) {
    const source = read(name);
    assert.doesNotMatch(source, /run\("npm", \["test"\]\)|run\("npm", \["run", "(?:check|build)"\]/);
    assert.match(source, /prepare-deployment/);
    if (name.endsWith(".mjs")) assert.match(source, /credentialFreeEnv/);
  }
});

// Exercise the real entrypoints with harmless executable shims. Their persisted
// trace records environment *presence*, never canary values.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { credentialFreeEnv } from '../scripts/release-environment.mjs';

const canary = 'synthetic-deploy-canary-fix19';
test('credential-free environment stays closed when an unrelated secret is added', () => {
  assert.deepEqual(credentialFreeEnv({ PATH: '/fixture', CLOUDFLARE_API_TOKEN: canary, GH_TOKEN: canary, NEW_SECRET: canary }), { PATH: '/fixture' });
});

function releaseFixture(t, { mainCommit = '1'.repeat(40), dirty = '', failure = null, uploadOutput = 'Worker Version ID: 0f1e2d3c-4b5a-4968-8776-655443322110' } = {}) {
  const root = temporaryDirectory('release-env-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/package.json'), '{"type":"commonjs"}');
  for (const file of ['prepare-release.mjs', 'release-production.mjs', 'release-staging.mjs', 'release-staging.py', 'release-command.mjs', 'release-environment.mjs', 'provider-release.mjs', 'provider-version.mjs']) copyFileSync(new URL(`../scripts/${file}`, import.meta.url), join(root, 'scripts', file));
  const trace = join(root, 'trace.jsonl');
  writeFileSync(trace, '');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  copyFileSync(new URL('../package.json', import.meta.url), join(root, 'package.json'));
  copyFileSync(new URL('../package-lock.json', import.meta.url), join(root, 'package-lock.json'));
  const provider = join(root, 'node_modules/wrangler');
  mkdirSync(join(provider, 'bin'), { recursive: true });
  writeFileSync(join(provider, 'package.json'), JSON.stringify({ name: 'wrangler', version: pkg.devDependencies.wrangler, bin: { wrangler: './bin/wrangler.js' } }));
  for (const tool of ['git', 'npm', 'node', 'wrangler']) {
    const path = tool === 'wrangler' ? join(provider, 'bin/wrangler.js') : join(root, 'bin', tool);
    writeFileSync(path, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ tool: '${tool}', args, deploy: !!process.env.CLOUDFLARE_API_TOKEN, unrelated: !!process.env.NEW_SECRET })+'\\n');
if ('${tool}' === 'git' && args[0] === 'rev-parse') console.log(args[1] === 'origin/main' ? ${JSON.stringify(mainCommit)} : '${'1'.repeat(40)}');
if ('${tool}' === 'git' && args[0] === 'status') console.log(${JSON.stringify(dirty)});
for (const failure of [${JSON.stringify(failure)}].flat().filter(Boolean)) {
const matchingCalls = failure ? fs.readFileSync(${JSON.stringify(trace)}, 'utf8').trim().split('\\n').map(JSON.parse).filter(row => row.tool === failure.tool && row.args.slice(0, failure.prefix.length).join(' ') === failure.prefix.join(' ')).length : 0;
if (failure && failure.tool === '${tool}' && args.slice(0, failure.prefix.length).join(' ') === failure.prefix.join(' ') && matchingCalls === (failure.onCall || 1)) { console.error(failure.stderr || 'synthetic failure'); process.exit(failure.status || 1); }
}
if ('${tool}' === 'wrangler' && args[0] === 'deployments') console.log(JSON.stringify(fs.existsSync(${JSON.stringify(join(root, 'published.json'))}) ? JSON.parse(fs.readFileSync(${JSON.stringify(join(root, 'published.json'))}, 'utf8')) : { versions: [] }));
if ('${tool}' === 'wrangler' && args[0] === 'versions' && args[1] === 'view') console.log(fs.existsSync(${JSON.stringify(join(root, 'version.json'))}) ? fs.readFileSync(${JSON.stringify(join(root, 'version.json'))}, 'utf8') : JSON.stringify({ id: args[2], resources: { bindings: [{ name: 'GIT_SHA', type: 'plain_text', text: '1'.repeat(40) }] } }));
if ('${tool}' === 'wrangler' && args[0] === 'versions' && args[1] === 'deploy') fs.writeFileSync(${JSON.stringify(join(root, 'published.json'))}, JSON.stringify({ versions: [{ version_id: args[2].split('@')[0], percentage: 100 }] }));
if ('${tool}' === 'wrangler' && args.includes('upload')) console.log(${JSON.stringify(uploadOutput)});
if (fs.existsSync(${JSON.stringify(join(root, 'fail'))}) && ('${tool}' === 'node' || '${tool}' === 'npm')) { console.error('synthetic failure'); process.exit(1); }
`);
    chmodSync(path, 0o755);
  }
  return { root, trace, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, CLOUDFLARE_API_TOKEN: canary, NEW_SECRET: canary } };
}

test('staging accepts one exact clean candidate without weakening default main or production gates', t => {
  const { root, trace, env } = releaseFixture(t, { mainCommit: '2'.repeat(40) });
  for (const entry of ['release-staging.mjs', 'release-production.mjs']) {
    const refused = spawnSync(process.execPath, [`scripts/${entry}`], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
  }
  assert.equal(readFileSync(trace, 'utf8').includes('"tool":"wrangler"'), false);
  const candidate = spawnSync(process.execPath, ['scripts/release-staging.mjs', '--source-sha', '1'.repeat(40)], { cwd: root, env, encoding: 'utf8' });
  assert.equal(candidate.status, 0, candidate.stderr);
  const rows = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
  const provider = rows.filter(row => row.tool === 'wrangler');
  assert.ok(provider.length > 0);
  assert.ok(provider.every(row => row.args[row.args.indexOf('--env') + 1] === 'staging'));
  assert.ok(rows.filter(row => row.tool !== 'wrangler').every(row => !row.deploy && !row.unrelated));
});

test('staging rejects malformed, mismatched, unknown and dirty candidate requests before publication', t => {
  for (const args of [['--source-sha'], ['--source-sha', 'short'], ['--source-sha', '2'.repeat(40)],
    ['--unknown'], ['--source-sha', '1'.repeat(40), '--extra']]) {
    const { root, trace, env } = releaseFixture(t);
    const result = spawnSync(process.execPath, ['scripts/release-staging.mjs', ...args], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.equal(readFileSync(trace, 'utf8').includes('"tool":"wrangler"'), false);
  }
  const { root, trace, env } = releaseFixture(t, { dirty: ' M js/app-layout.js' });
  const dirty = spawnSync(process.execPath, ['scripts/release-staging.mjs', '--source-sha', '1'.repeat(40)], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /clean checkout/);
  assert.equal(readFileSync(trace, 'utf8').includes('"tool":"wrangler"'), false);
});

test('tests cannot see deploy credentials; only provider commands can', t => {
  const {root, trace, env} = releaseFixture(t);
  execFileSync(process.execPath, ['scripts/prepare-release.mjs'], {cwd:root, env, stdio:'pipe'});
  execFileSync(process.execPath, ['scripts/release-production.mjs'], {cwd:root, env, stdio:'pipe'});
  const raw = readFileSync(trace, 'utf8');
  const rows = raw.trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(r => r.tool === 'npm' && r.args[0] === 'test'));
  assert.ok(rows.some(r => r.tool === 'wrangler' && r.args.includes('upload') && r.deploy));
  assert.ok(rows.filter(r => r.tool !== 'wrangler').every(r => !r.deploy && !r.unrelated));
  assert.ok(rows.every(r => !r.unrelated));
  assert.equal(raw.includes(canary), false);
});

test('failed preparation/verification and missing provider credentials never upload', t => {
  for (const entry of ['prepare-release.mjs','release-production.mjs','release-staging.mjs']) {
    const {root, trace, env} = releaseFixture(t);
    writeFileSync(join(root, 'fail'), 'fixture');
    const result = spawnSync(process.execPath, [`scripts/${entry}`], {cwd:root, env, encoding:'utf8'});
    assert.notEqual(result.status, 0);
    assert.equal(`${result.stdout}${result.stderr}`.includes(canary), false);
    assert.equal(readFileSync(trace, 'utf8').includes('"tool":"wrangler"'), false);
  }
  const {root, trace, env} = releaseFixture(t);
  delete env.CLOUDFLARE_API_TOKEN;
  const missing = spawnSync(process.execPath, ['scripts/release-production.mjs'], {cwd:root, env, encoding:'utf8'});
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /publication requires CLOUDFLARE_API_TOKEN/);
  assert.equal(readFileSync(trace, 'utf8').includes('"tool":"wrangler"'), false);
});

test('release source gate accepts canonical ancestry and refuses fork-only commit', t => {
  const root = temporaryDirectory('release-source-');
  t.after(() => rmSync(root, {recursive:true, force:true}));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(new URL('../scripts/check-release-source.mjs', import.meta.url), join(root,'scripts/check-release-source.mjs'));
  const git = args => execFileSync('git', args, {cwd:root, encoding:'utf8', stdio:'pipe'}).trim();
  git(['init','-q']);
  git(['add','scripts/check-release-source.mjs']);
  git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Synthetic source']);
  const main = git(['rev-parse','HEAD']);
  git(['update-ref','refs/remotes/origin/main',main]);
  const run = sha => spawnSync(process.execPath, ['scripts/check-release-source.mjs'], {cwd:root, env:{...process.env,GITHUB_SHA:sha},encoding:'utf8'});
  assert.equal(run(main).status,0);
  git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','Synthetic fork']);
  assert.notEqual(run(git(['rev-parse','HEAD'])).status,0);
  assert.notEqual(run('$(touch marker)').status,0);
  assert.throws(()=>readFileSync(join(root,'marker')), /ENOENT/);
});


test('npm publication entrypoints have no lifecycle build or test hooks',()=>{
  const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  for(const lane of ['staging','production']) for(const phase of ['pre','post']) assert.equal(pkg.scripts[`${phase}release:${lane}`],undefined);
});

test('staging artifact failure names its step and recovery without publishing or exposing credentials', t => {
  const { root, trace, env } = releaseFixture(t);
  writeFileSync(join(root, 'fail'), 'fixture');
  const result = spawnSync(process.execPath, ['scripts/release-staging.mjs'], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release:staging failed at artifact-verification/);
  assert.match(result.stderr, /Recovery:.*npm run release:prepare/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(canary), false);
  assert.equal(readFileSync(trace, 'utf8').includes('"tool":"wrangler"'), false);
});


test('each staging command failure names its step and tells the operator how to recover', t => {
  const cases = [
    ['git', ['rev-parse', 'HEAD'], 'source-head', /Git checkout/],
    ['git', ['rev-parse', 'origin/main'], 'source-main', /origin\/main/],
    ['git', ['status'], 'source-cleanliness', /git status/],
    ['wrangler', ['deployments', 'status'], 'deployment-status', /before retrying/],
    ['wrangler', ['versions', 'upload'], 'version-upload', /before retrying/],
    ['wrangler', ['versions', 'deploy'], 'version-promotion', /rollback:staging/],
  ];
  for (const [tool, prefix, step, recovery] of cases) {
    const { root, trace, env } = releaseFixture(t, { failure: { tool, prefix, stderr: canary } });
    const result = spawnSync(process.execPath, ['scripts/release-staging.mjs'], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0, step);
    assert.ok(result.stderr.includes(`release:staging failed at ${step}`), result.stderr);
    assert.match(result.stderr, /Recovery:/);
    assert.match(result.stderr, recovery);
    assert.equal(`${result.stdout}${result.stderr}`.includes(canary), false);
    const rows = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.at(-1).tool, tool);
    assert.deepEqual(rows.at(-1).args.slice(0, prefix.length), prefix, 'failure stops the release without retry');
  }
});


test('staging preserves the exact immutable release command sequence', t => {
  const { root, trace, env } = releaseFixture(t);
  const result = spawnSync(process.execPath, ['scripts/release-staging.mjs'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const rows = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
  const sha = '1'.repeat(40);
  assert.deepEqual(rows.map(row => [row.tool, ...row.args]), [
    ['git', 'rev-parse', 'HEAD'],
    ['git', 'rev-parse', 'origin/main'],
    ['git', 'status', '--porcelain', '--untracked-files=all'],
    ['node', 'scripts/build-artifact.mjs', 'prepare-deployment'],
    ['wrangler', 'deployments', 'status', '--env', 'staging', '--json'],
    ['wrangler', 'versions', 'upload', '--env', 'staging', '--strict', '--tag', 'staging-111111111111', '--message', `DoctorCRE staging ${sha}`, '--var', `GIT_SHA:${sha}`],
    ['wrangler', 'versions', 'deploy', '0f1e2d3c-4b5a-4968-8776-655443322110@100%', '--env', 'staging', '--message', `DoctorCRE staging ${sha}`, '--yes'],
    ['wrangler', 'deployments', 'status', '--env', 'staging', '--json'],
  ]);
  assert.ok(rows.filter(row => row.tool !== 'wrangler').every(row => !row.deploy && !row.unrelated));
  assert.ok(rows.filter(row => row.tool === 'wrangler').every(row => row.deploy && !row.unrelated));
});

test('staging bootstrap is limited to provider code 10007', t => {
  const { root, trace, env } = releaseFixture(t, {
    failure: { tool: 'wrangler', prefix: ['deployments', 'status'], stderr: 'code: 10007' },
  });
  const result = spawnSync(process.execPath, ['scripts/release-staging.mjs'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const rows = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.tool === 'wrangler');
  assert.deepEqual(rows.map(row => row.args[0]), ['deployments', 'deploy', 'deployments']);
  assert.deepEqual(rows[1].args, ['deploy', '--env', 'staging', '--strict', '--tag', 'staging-111111111111', '--message', `DoctorCRE staging ${'1'.repeat(40)}`, '--var', `GIT_SHA:${'1'.repeat(40)}`]);
});

test('staging readback failure reports that publication may have succeeded without replaying it', t => {
  const { root, trace, env } = releaseFixture(t, {
    failure: { tool: 'wrangler', prefix: ['deployments', 'status'], onCall: 2, stderr: canary },
  });
  const result = spawnSync(process.execPath, ['scripts/release-staging.mjs'], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release:staging failed at deployment-readback/);
  assert.match(result.stderr, /Recovery:.*publication may have succeeded.*verify before retrying/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(canary), false);
  const rows = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.tool === 'wrangler');
  assert.equal(rows.length, 4);
});


test('staging refuses missing or ambiguous upload identity and names the recovery', t => {
  const id = 'Worker Version ID: 0f1e2d3c-4b5a-4968-8776-655443322110';
  for (const uploadOutput of ['no version ID', `${id}\n${id}`]) {
    const { root, trace, env } = releaseFixture(t, { uploadOutput });
    const result = spawnSync(process.execPath, ['scripts/release-staging.mjs'], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release:staging failed at uploaded-version-identity/);
    assert.match(result.stderr, /Cloudflare returned no unique Worker Version ID/);
    assert.match(result.stderr, /Recovery:.*do not promote an ambiguous upload/);
    const rows = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.tool === 'wrangler');
    assert.deepEqual(rows.map(row => row.args.slice(0, 2)), [['deployments', 'status'], ['versions', 'upload']]);
  }
});

test('staging bootstrap failure names the uncertain publication and never retries', t => {
  const { root, trace, env } = releaseFixture(t, { failure: [
    { tool: 'wrangler', prefix: ['deployments', 'status'], stderr: 'code: 10007' },
    { tool: 'wrangler', prefix: ['deploy'], stderr: canary },
  ] });
  const result = spawnSync(process.execPath, ['scripts/release-staging.mjs'], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release:staging failed at staging-bootstrap/);
  assert.match(result.stderr, /Recovery:.*before retrying.*may have succeeded/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(canary), false);
  const rows = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.tool === 'wrangler');
  assert.deepEqual(rows.map(row => row.args[0]), ['deployments', 'deploy']);
});

test('staging reports the Python runtime dependency before executing release commands', t => {
  const { root, trace, env } = releaseFixture(t);
  env.PATH = join(root, 'bin');
  const result = spawnSync(process.execPath, ['scripts/release-staging.mjs'], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release:staging failed at python-launch/);
  assert.match(result.stderr, /Recovery: install Python 3/);
  assert.equal(readFileSync(trace, 'utf8'), '');
});

test('staging reports Python initialization failure without printing the runtime dump', t => {
  const { root, trace, env } = releaseFixture(t);
  const brokenHome = join(root, canary);
  mkdirSync(brokenHome);
  const result = spawnSync(process.execPath, ['scripts/release-staging.mjs'], {
    cwd: root, env: { ...env, PYTHONHOME: brokenHome }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release:staging failed at python-launch/);
  assert.match(result.stderr, /Recovery:.*Python 3/);
  assert.doesNotMatch(result.stdout + result.stderr, /Fatal Python error/);
  assert.equal((result.stdout + result.stderr).includes(canary), false);
  assert.equal(readFileSync(trace, 'utf8'), '');
});


test('duplicate exact-SHA wakes promote once and emit already-live receipts', t => {
  const { root, trace, env } = releaseFixture(t);
  for (let attempt = 0; attempt < 3; attempt++) {
    const output = join(root, 'output');
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, ['scripts/release-production.mjs'], {
      cwd: root, env: { ...env, GITHUB_OUTPUT: output }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(output, 'utf8'), attempt === 0 ? /disposition=published/ : /disposition=already-live/);
    assert.match(readFileSync(output, 'utf8'), /publication_observed_at=\d{4}-/);
    assert.match(readFileSync(output, 'utf8'), /provider_version_id=0f1e2d3c-4b5a-4968-8776-655443322110/);
  }
  const rows = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.tool === 'wrangler' && row.args[1] === 'deploy').length, 1);
  assert.equal(rows.filter(row => row.tool === 'wrangler' && row.args[1] === 'upload').length, 1);
});

const deployedVersion = '0f1e2d3c-4b5a-4968-8776-655443322110';
test('a different source, missing source binding or split traffic still publishes the exact candidate', t => {
  for (const [versions, bindings] of [
    [[{ version_id: deployedVersion, percentage: 100 }], [{ name: 'GIT_SHA', type: 'plain_text', text: '2'.repeat(40) }]],
    [[{ version_id: deployedVersion, percentage: 100 }], []],
    [[{ version_id: deployedVersion, percentage: 50 }, { version_id: 'another-version', percentage: 50 }], []],
  ]) {
    const { root, trace, env } = releaseFixture(t);
    writeFileSync(join(root, 'published.json'), JSON.stringify({ versions }));
    writeFileSync(join(root, 'version.json'), JSON.stringify({ id: deployedVersion, resources: { bindings } }));
    const result = spawnSync(process.execPath, ['scripts/release-production.mjs'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const rows = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
    const upload = rows.find(row => row.tool === 'wrangler' && row.args[1] === 'upload');
    assert.ok(upload?.args.includes(`GIT_SHA:${'1'.repeat(40)}`));
    assert.equal(rows.filter(row => row.tool === 'wrangler' && row.args[1] === 'deploy').length, 1);
  }
});

test('malformed deployment identity or failed version reads refuse all publication', t => {
  for (const [deployment, version, failure] of [
    [{}, {}, null],
    [{ versions: [{ version_id: 'invalid', percentage: 100 }] }, {}, null],
    [{ versions: [{ version_id: deployedVersion, percentage: 100 }] }, { id: 'wrong', resources: { bindings: [] } }, null],
    [{ versions: [{ version_id: deployedVersion, percentage: 100 }] }, {}, null],
    [{ versions: [{ version_id: deployedVersion, percentage: 100 }] }, {}, { tool: 'wrangler', prefix: ['versions', 'view'] }],
  ]) {
    const { root, trace, env } = releaseFixture(t, { failure });
    writeFileSync(join(root, 'published.json'), JSON.stringify(deployment));
    writeFileSync(join(root, 'version.json'), JSON.stringify(version));
    const result = spawnSync(process.execPath, ['scripts/release-production.mjs'], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    const rows = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.some(row => row.tool === 'wrangler' && ['upload', 'deploy'].includes(row.args[1])), false);
  }
});

test('a retry after successful promotion and failed readback skips another promotion', t => {
  const { root, trace, env } = releaseFixture(t, { failure: { tool: 'wrangler', prefix: ['deployments', 'status'], onCall: 2 } });
  const run = () => spawnSync(process.execPath, ['scripts/release-production.mjs'], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(run().status, 0);
  const retry = run();
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /already serves source/);
  const rows = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.tool === 'wrangler' && row.args[1] === 'deploy').length, 1);
});
