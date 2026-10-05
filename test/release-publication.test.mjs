import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const canary = 'synthetic-publication-canary';
const versionId = '0f1e2d3c-4b5a-4968-8776-655443322110';

function fixture(t, { installation = 'locked', browser = false } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'release-publication-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'app');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  execFileSync('git', ['clone', '--quiet', '--shared', '--no-hardlinks', ROOT, root], { stdio: 'pipe' });
  const paths = ['scripts/prepare-release.mjs', 'scripts/release-production.mjs', 'scripts/release-staging.mjs', 'scripts/release-environment.mjs', 'scripts/provider-release.mjs', 'test/morning-brief-browser.test.mjs'];
  for (const path of paths) if (existsSync(join(ROOT, path))) copyFileSync(join(ROOT, path), join(root, path));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
  // Keep real npm, Git, artifact build/verification and (when requested) an
  // existing browser capture test. Avoid recursively running this test suite.
  pkg.scripts.test = browser ? 'node --test --test-name-pattern="live first-open brief" test/morning-brief-browser.test.mjs' : 'node -e ""';
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules/playwright'), join(root, 'node_modules/playwright'), 'dir');
  symlinkSync(join(ROOT, 'node_modules/jsdom'), join(root, 'node_modules/jsdom'), 'dir');
  git(['add', ...paths.filter(path => existsSync(join(root, path))), 'package.json']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic release source']);
  const commit = git(['rev-parse', 'HEAD']);
  git(['update-ref', 'refs/remotes/origin/main', commit]);
  const trace = join(parent, 'provider.jsonl');
  const entry = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({args, deploy: !!process.env.CLOUDFLARE_API_TOKEN, unrelated: !!process.env.NEW_SECRET, color: process.env.NO_COLOR})+'\\n');
if (args.includes('status') && fs.existsSync(${JSON.stringify(join(parent, 'bootstrap'))})) { fs.unlinkSync(${JSON.stringify(join(parent, 'bootstrap'))}); console.error('code: 10007'); process.exit(1); }
if (args.includes('upload')) console.log('Worker Version ID: ${versionId}');
`;
  if (installation === 'missing') {
    const bin = join(parent, 'node_modules/.bin'); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'wrangler'), entry); chmodSync(join(bin, 'wrangler'), 0o755);
  } else {
    const provider = join(root, 'node_modules/wrangler'); mkdirSync(join(provider, 'bin'), { recursive: true });
    writeFileSync(join(provider, 'package.json'), JSON.stringify({ name: 'wrangler', version: installation === 'mismatch' ? '0.0.0' : pkg.devDependencies.wrangler, bin: { wrangler: './bin/wrangler.js' } }));
    writeFileSync(join(provider, 'bin/wrangler.js'), entry);
    mkdirSync(join(root, 'node_modules/.bin'));
    symlinkSync('../wrangler/bin/wrangler.js', join(root, 'node_modules/.bin/wrangler'));
    chmodSync(join(provider, 'bin/wrangler.js'), 0o755);
    if (installation === 'symlink') {
      const external = join(parent, 'external.js'); writeFileSync(external, entry);
      rmSync(join(provider, 'bin/wrangler.js')); symlinkSync(external, join(provider, 'bin/wrangler.js'));
    }
  }
  const env = { ...process.env, CLOUDFLARE_API_TOKEN: canary, NEW_SECRET: canary };
  const run = entrypoint => spawnSync(process.execPath, [`scripts/${entrypoint}.mjs`], { cwd: root, env, encoding: 'utf8' });
  const rows = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { parent, root, git, run, rows, trace };
}

test('both actual publishers refuse ancestor, mismatched and external Wrangler entrypoints', t => {
  for (const lane of ['production', 'staging']) for (const installation of ['missing', 'mismatch', 'symlink']) {
    const f = fixture(t, { installation });
    const prepared = f.run('prepare-release');
    assert.equal(prepared.status, 0, prepared.stderr);
    const result = f.run(`release-${lane}`);
    assert.notEqual(result.status, 0, `${lane}: ${installation} must refuse`);
    assert.match(result.stderr, /checkout-local locked Wrangler/);
    assert.deepEqual(f.rows(), [], 'untrusted executable must never receive credentials');
    assert.equal(result.stderr.includes(canary), false);
  }
});

test('real browser preparation preserves tracked source and both publishers accept its artifact', t => {
  const f = fixture(t, { browser: true });
  const baseline = f.git(['ls-files', '-s', 'test-artifacts']);
  const prepared = f.run('prepare-release');
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  assert.equal(f.git(['status', '--porcelain', '--untracked-files=all']), '', 'preparation leaves source clean');
  assert.equal(f.git(['ls-files', '-s', 'test-artifacts']), baseline);
  assert.ok(existsSync(join(f.root, 'out/test-artifacts/w12/brief-desktop.png')), 'real browser capture was retained outside tracked paths');
  for (const lane of ['production', 'staging']) {
    const result = f.run(`release-${lane}`);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(f.rows().filter(row => row.args.includes('upload')).length, 2);
});

test('provider runner owns credential routing across status, upload, promotion and staging bootstrap', t => {
  for (const lane of ['production', 'staging']) {
    const source = readFileSync(join(ROOT, `scripts/release-${lane}.mjs`), 'utf8');
    assert.doesNotMatch(source, /env:\s*.*CLOUDFLARE_API_TOKEN|command === "npx"/);
    const f = fixture(t);
    assert.equal(f.run('prepare-release').status, 0);
    const result = f.run(`release-${lane}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.rows().length, 4);
    assert.ok(f.rows().every(row => row.deploy && !row.unrelated && row.color === '1'));
    if (lane === 'staging') {
      writeFileSync(join(f.parent, 'bootstrap'), 'synthetic missing Worker');
      const bootstrap = f.run('release-staging');
      assert.equal(bootstrap.status, 0, bootstrap.stderr);
      assert.equal(f.rows().at(-2).args[0], 'deploy');
    }
    assert.equal(readFileSync(f.trace, 'utf8').includes(canary), false);
  }
});
