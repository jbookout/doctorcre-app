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
  for (const name of ["release-production.mjs", "release-staging.mjs"]) {
    const source = read(name);
    assert.doesNotMatch(source, /run\("npm", \["test"\]\)|run\("npm", \["run", "(?:check|build)"\]/);
    assert.match(source, /prepare-deployment/);
    assert.match(source, /credentialFreeEnv/);
  }
});

// Exercise the real entrypoints with harmless executable shims. Their persisted
// trace records environment *presence*, never canary values.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialFreeEnv } from '../scripts/release-environment.mjs';

const canary = 'synthetic-deploy-canary-fix19';
test('credential-free environment stays closed when an unrelated secret is added', () => {
  assert.deepEqual(credentialFreeEnv({ PATH: '/fixture', CLOUDFLARE_API_TOKEN: canary, GH_TOKEN: canary, NEW_SECRET: canary }), { PATH: '/fixture' });
});

function releaseFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'release-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/package.json'), '{"type":"commonjs"}');
  for (const file of ['prepare-release.mjs', 'release-production.mjs', 'release-staging.mjs', 'release-environment.mjs', 'provider-release.mjs', 'provider-version.mjs']) copyFileSync(new URL(`../scripts/${file}`, import.meta.url), join(root, 'scripts', file));
  const trace = join(root, 'trace.jsonl');
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
if ('${tool}' === 'git' && args[0] === 'rev-parse') console.log('${'1'.repeat(40)}');
if ('${tool}' === 'wrangler' && args.includes('upload')) console.log('Worker Version ID: 0f1e2d3c-4b5a-4968-8776-655443322110');
if (fs.existsSync(${JSON.stringify(join(root, 'fail'))}) && ('${tool}' === 'node' || '${tool}' === 'npm')) { console.error('synthetic failure'); process.exit(1); }
`);
    chmodSync(path, 0o755);
  }
  return { root, trace, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, CLOUDFLARE_API_TOKEN: canary, NEW_SECRET: canary } };
}

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
  const root = mkdtempSync(join(tmpdir(), 'release-source-'));
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
