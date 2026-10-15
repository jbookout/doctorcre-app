import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = await readFile(new URL('../.githooks/pre-push', import.meta.url), 'utf8');
async function fixture(t, { slow = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pre-push-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.githooks'));
  await mkdir(join(root, 'test'));
  await mkdir(join(root, 'bin'));
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'dir');
  await writeFile(join(root, '.gitignore'), 'node_modules\n');
  await writeFile(join(root, '.githooks/pre-push'), slow ? source.replace('170_000', '100') : source);
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: {
    check: slow ? 'node -e "setInterval(()=>{},1000)"' : 'node -e "console.log(\'CHECK-RAN\')"',
    test: 'node .githooks/pre-push --test',
  } }));
  await writeFile(join(root, 'test/touched.test.mjs'), "import test from 'node:test'; test('touched',()=>console.log('TOUCHED-RAN'));\n");
  // This fixture represents an engine adapter. It writes a marker if imported.
  await writeFile(join(root, 'test/browser-harness.mjs'), "import fs from 'node:fs'; fs.writeFileSync('engine-started','unexpected');\n");
  await writeFile(join(root, 'test/engine.test.mjs'), "import './browser-harness.mjs'; import test from 'node:test'; test('engine',()=>{});\n");
  await writeFile(join(root, 'test/unrelated.test.mjs'), "import test from 'node:test'; test('unrelated',()=>console.log('UNRELATED-RAN'));\n");
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  const commit = () => { git('add', '.'); git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','fixture'); return git('rev-parse','HEAD'); };
  const baseline = commit();
  git('update-ref', 'refs/remotes/origin/main', baseline);
  const invoke = (input, args = []) => spawnSync(process.execPath, [join(root, '.githooks/pre-push'), ...args],
    { cwd: root, input, encoding: 'utf8', env: { ...process.env, npm_config_cache: join(tmpdir(),'pr240-npm-cache') }, timeout: 20_000 });
  return { root, git, commit, baseline, invoke,
    push: (remote = baseline) => invoke(`refs/heads/feature ${git('rev-parse','HEAD')} refs/heads/feature ${remote}\n`) };
}

test('pre-push checks outgoing source and runs touched tests without starting an engine', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root,'test/touched.test.mjs'), "import test from 'node:test'; test('touched',()=>console.log('TOUCHED-RAN')); // changed\n");
  f.commit();
  const result = f.push();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /CHECK-RAN/);
  assert.match(result.stdout, /TOUCHED-RAN/);
  assert.doesNotMatch(result.stdout, /UNRELATED-RAN/);
  await assert.rejects(readFile(join(f.root,'engine-started')), { code: 'ENOENT' });
});

test('source-only and new-branch pushes run the browser-free suite', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root,'source.txt'), 'synthetic source change'); f.commit();
  for (const remote of [f.baseline, '0'.repeat(40)]) {
    const result = f.push(remote);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    
    assert.match(result.stdout, /TOUCHED-RAN/);
    assert.match(result.stdout, /UNRELATED-RAN/);
    await assert.rejects(readFile(join(f.root,'engine-started')), { code: 'ENOENT' });
  }

});

test('fast selection traverses neutral helpers through every supported import form', async t => {
  const forms = [
    "import './setup.mjs';",
    "import value from './setup.mjs';",
    "import { value } from './setup.mjs';",
    "import * as setup from './setup.mjs';",
    "await import('./setup.mjs');",
    "export { value } from './setup.mjs';",
    "export * from './setup.mjs';",
    "export * as setup from './setup.mjs';",
  ];
  const f = await fixture(t);
  for (const form of forms) {
    await writeFile(join(f.root, 'test/neutral.test.mjs'), `${form}\nimport test from 'node:test'; test('neutral', () => console.log('NEUTRAL-RAN'));\n`);
    await writeFile(join(f.root, 'test/setup.mjs'), "import fs from 'node:fs'; // Playwright adapter fixture, no engine launch\nfs.writeFileSync('neutral-started', 'unexpected'); export const value = 1; export default value;\n");
    const blocked = f.invoke('', ['--test', '--fast']);
    assert.equal(blocked.status, 0, blocked.stdout + blocked.stderr);
    assert.doesNotMatch(blocked.stdout, /NEUTRAL-RAN/, form);
    await assert.rejects(readFile(join(f.root, 'neutral-started')), { code: 'ENOENT' });
    await writeFile(join(f.root, 'test/setup.mjs'), 'export const value = 1; export default value;\n');
    const safe = f.invoke('', ['--test', '--fast']);
    assert.equal(safe.status, 0, safe.stdout + safe.stderr);
    assert.match(safe.stdout, /NEUTRAL-RAN/, form);
  }
});

test('suite filenames cannot bypass dependency classification', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'test/setup.mjs'), "import fs from 'node:fs'; // Playwright fixture\nfs.writeFileSync('neutral-started', 'unexpected');\n");
  for (const name of ['ci-workflows', 'full-main']) {
    await writeFile(join(f.root, `test/${name}.test.mjs`), "import './setup.mjs';\n");
  }
  const result = f.invoke('', ['--test', '--fast']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await assert.rejects(readFile(join(f.root, 'neutral-started')), { code: 'ENOENT' });
});

test('fast selection fails closed for dependencies it cannot classify', async t => {
  const f = await fixture(t);
  for (const form of [
    "await import('./' + 'setup.mjs');",
    "import './missing.mjs';",
    "import 'neutral-package';",
    "import './data.json' with { type: 'json' };",
    "import './setup.cjs';",
    "import 'file:///unclassified.mjs';",
    "import './invalid.mjs';",
  ]) {
    await writeFile(join(f.root, 'test/setup.mjs'), "throw Error('must not execute');\n");
    await writeFile(join(f.root, 'test/invalid.mjs'), 'import { broken;');
    await writeFile(join(f.root, 'test/neutral.test.mjs'), `${form}\nconsole.log('UNCLASSIFIED-RAN');\n`);
    const result = f.invoke('', ['--test', '--fast']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /UNCLASSIFIED-RAN/, form);
  }
});

test('failing touched tests and repository checks prevent the push', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root,'test/touched.test.mjs'), "import test from 'node:test'; test('seeded failure',()=>{throw Error('seeded');});\n");
  f.commit();
  assert.notEqual(f.push().status, 0);
  await writeFile(join(f.root,'package.json'), JSON.stringify({ type:'module', scripts:{ check:'node -e "process.exit(7)"' } }));
  f.commit();
  const checkFailure=f.push();
  assert.notEqual(checkFailure.status,0);
  assert.doesNotMatch(checkFailure.stdout,/seeded failure/);
});

test('deletion does no checks, invalid or unchecked source refuses, and deadline is enforced', async t => {
  const f = await fixture(t);
  assert.equal(f.invoke(`(delete) ${'0'.repeat(40)} refs/heads/feature ${f.baseline}\n`).status,0);
  assert.notEqual(f.invoke('malformed\n').status,0);
  await writeFile(join(f.root,'source.txt'),'uncommitted input');
  assert.notEqual(f.push().status,0);
  const slow=await fixture(t,{slow:true});
  const result=slow.push();
  assert.equal(result.status,124,result.stdout+result.stderr);
  assert.match(result.stderr,/exceeded 170 seconds/);
});

