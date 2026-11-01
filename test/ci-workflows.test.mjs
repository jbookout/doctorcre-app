import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkActionPins } from "../scripts/check-action-pins.mjs";

const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const release = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const root = fileURLToPath(new URL("../", import.meta.url));

test('signed-in Calendar CI installs the producer PostgreSQL binaries before its real journey', () => {
  const checks = ci.split(/^  checks:/m)[1].split(/^  shards:/m)[0];
  assert.match(checks, /run: bash \.\.\/carr-producer\/ops\/ci-postgres\.sh/);
  const journey = checks.split('name: Verify signed-in Calendar')[1];
  assert.match(journey, /CARR_LOCAL_PG_BIN_DIR: \/usr\/lib\/postgresql\/17\/bin/);
});

test("PR jobs build the merge candidate when the branch predates a required npm script", async t => {
  const directory = await temporaryDirectory("doctorcre-old-pr-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: "pipe" }).trim();
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, scripts: {} }));
  const head = commit();
  await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, scripts: { build: 'node -e "console.log(\'MERGE-BUILD-PASSED\')"' } }));
  const merge = commit();
  const contexts = { "github.sha": merge, "github.event.pull_request.head.sha": head };
  const workflows = [ci, await readFile(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8")];
  for (const workflow of workflows) {
    for (const [, name, job] of workflow.matchAll(/^  (\w+):\n([\s\S]*?)(?=^  \w+:|$(?![\s\S]))/gm)) {
      const checkout = job.split(/^      - /m).find(step => /^uses: actions\/checkout@/m.test(step));
      if (!checkout) continue;
      const ref = checkout.match(/ref: \$\{\{ (.*?) \}\}/)?.[1] ?? "github.sha";
      git("checkout", "--detach", contexts[ref]);
      const result = spawnSync("npm", ["run", "build"], { cwd: directory, encoding: "utf8" });
      assert.equal(result.status, 0, `${name} must build the merge candidate: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /MERGE-BUILD-PASSED/);
      assert.equal(git("rev-parse", "HEAD"), merge);
    }
  }
  const preview = ci.split(/^  preview:/m)[1];
  assert.match(preview, /DOCTORCRE_SOURCE_COMMIT: \$\{\{ github.sha \}\}/);
  assert.match(preview, /name: pr-preview-\$\{\{ github.event.pull_request.number \}\}-\$\{\{ github.event.pull_request.head.sha \}\}/);
});

test("the CI checkout layout keeps producer-owned content out of app repository checks", async (t) => {
  const workspace = await temporaryDirectory("doctorcre-checkout-layout-");
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const steps = ci.split(/^      - /m).slice(1);
  const appCheckout = steps.find(step => /^uses: actions\/checkout@/m.test(step));
  const producerCheckout = steps.find(step => /repository: jbookout\/carr-system/.test(step));
  const app = resolve(workspace, appCheckout.match(/path: (\S+)/)?.[1] ?? ".");
  const producer = resolve(workspace, producerCheckout.match(/path: (\S+)/)[1]);
  await mkdir(app, { recursive: true });
  const archive = join(workspace, "app.tar");
  execFileSync("git", ["archive", "-o", archive, "HEAD"], { cwd: root });
  execFileSync("tar", ["-xf", archive, "-C", app]);
  await symlink(join(root, "node_modules"), join(app, "node_modules"), "dir");
  await mkdir(join(producer, ".github/workflows"), { recursive: true });
  // Synthetic external source reproduces the scanner refusal without reading
  // credentials or requiring the producer checkout for this offline test.
  const externalSource = `connection: ${"post" + "gresql"}://synthetic.invalid/example\n`;
  await writeFile(join(producer, ".github/workflows/producer.yml"), externalSource);
  const result = execFileSync(process.execPath, ["scripts/check-repository.mjs"], { cwd: app, encoding: "utf8" });
  assert.match(result, /repository check passed/);
  assert.equal(ci.match(/working-directory: (\S+)/)?.[1], appCheckout.match(/path: (\S+)/)?.[1]);
  assert.match(ci, new RegExp(`cache-dependency-path: ${appCheckout.match(/path: (\S+)/)?.[1]}/package-lock\\.json`));
  await writeFile(join(app, "app-owned.yml"), externalSource);
  assert.throws(() => execFileSync(process.execPath, ["scripts/check-repository.mjs"], { cwd: app, stdio: "pipe" }),
    /app-owned\.yml contains a database connection string/, "app-owned content must remain guarded");
});

test('source CI keeps the full required suite and checks privacy before browser downloads', () => {
  const steps = ci.split(/^      - /m).slice(1);
  assert.match(ci, /^  test:/m);
  assert.doesNotMatch(ci, /edited|continue-on-error:/);
  assert.match(ci, /--test-shard=\$\{\{ matrix\.shard \}\}\/4/);
  assert.match(ci, /needs: \[checks, shards, performance\]/);
  const privacy = steps.findIndex(step => /^run: npm run privacy:check$/m.test(step));
  const browser = steps.findIndex(step => /^run: npx playwright install/m.test(step));
  assert.ok(privacy >= 0 && privacy < browser);
});

test('browser dependencies use official Ubuntu mirrors after privacy checks', async t => {
  const steps = ci.split(/^      - /m).slice(1);
  const mirror = steps.findIndex(step => /^name: Prefer Ubuntu archives for browser dependencies$/m.test(step));
  const privacy = steps.findIndex(step => /^run: npm run privacy:check$/m.test(step));
  const browser = steps.findIndex(step => /^run: npx playwright install --with-deps chromium webkit$/m.test(step));
  assert.ok(privacy >= 0 && privacy < mirror && mirror < browser,
    'configure apt mirrors after privacy checks and before installing browser dependencies');
  const shell = steps[mirror].match(/        run: \|\n([\s\S]*)/)[1].replace(/^          /gm, '');
  const directory = await temporaryDirectory('doctorcre-apt-mirrors-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'apt-mirrors.txt');
  await writeFile(path, 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n');
  const fixtureShell = shell.replaceAll('/etc/apt/apt-mirrors.txt', path).replace(/\bsudo /g, '');
  assert.doesNotMatch(fixtureShell, /\/etc\//);
  const expected = 'https://archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://security.ubuntu.com/ubuntu/\tpriority:2\n';
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', fixtureShell], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(await readFile(path, 'utf8'), expected);
  }
});

test("release build is read-only and publisher receives only this run's digest-bound artifact", () => {
  assert.match(release, /permissions:\n  contents: read/);
  const [build, publisher] = release.split(/^  publish:/m);
  assert.doesNotMatch(build, /contents: write|GH_TOKEN|secrets\./);
  assert.match(publisher, /needs: build/);
  assert.match(publisher, /contents: write/);
  assert.doesNotMatch(publisher, /npm ci|npm test|npm run build|actions\/checkout|cache:/);
  assert.match(publisher, /artifact-ids: \$\{\{ needs.build.outputs.artifact_id \}\}/);
  assert.match(publisher, /sha256sum -c/);
});

test("checkout never persists credentials", async () => {
  for (const file of ["ci.yml", "e2e.yml", "release.yml"]) {
    const workflow = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    for (const step of workflow.split(/^      - /m).slice(1).filter(s => s.includes("actions/checkout@"))) assert.match(step, /persist-credentials: false/);
  }
});

test('publisher handoff rejects tampering, missing digests, fork identity and symlinks; malicious ref stays inert', async t => {
  const verify = release.match(/      - name: Verify handoff[\s\S]*?        run: \|\n([\s\S]*?)      - name: Publish/)[1].replace(/^          /gm, '');
  const publish = release.match(/      - name: Publish[\s\S]*?        run: \|\n([\s\S]*)/)[1].replace(/^          /gm, '');
  assert.ok(publish.includes('gh release create'));
  const directory=await temporaryDirectory('release-handoff-');
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const {mkdir,symlink}=await import('node:fs/promises');
  await mkdir(join(directory,'dist')); await mkdir(join(directory,'bin'));
  const sha='1'.repeat(40);
  const files={
    'doctorcre-app.tar':'synthetic archive data; $(touch marker)',
    'doctorcre-app.manifest.json':JSON.stringify({schema:'doctorcre-static-artifact.v1',repository:'jbookout/doctorcre-app',source_commit:sha}),
    'doctorcre-app.tar.sha256':'synthetic digest sidecar',
  };
  const hashes=Object.values(files).map(bytes=>createHash('sha256').update(bytes).digest('hex'));
  const gh=join(directory,'bin','gh');
  await writeFile(gh,`#!${process.execPath}\nif (process.argv[2] === 'api') console.log(JSON.stringify({type:'commit',sha:process.env.FIXTURE_TAG_SHA || process.env.GITHUB_SHA})); else if (process.env.FIXTURE_WRITE_DENIED) process.exit(1); else require('node:fs').writeFileSync('published.json',JSON.stringify(process.argv.slice(2)));\n`); await chmod(gh,0o755);
  const env={...process.env,PATH:`${join(directory,'bin')}:${process.env.PATH}`,GITHUB_SHA:sha,GITHUB_REPOSITORY:'jbookout/doctorcre-app',GITHUB_REF_NAME:'app-v$(touch marker)',TAR_SHA:hashes[0],MANIFEST_SHA:hashes[1],SIDECAR_SHA:hashes[2]};
  const reset=async()=>{
    await rm(join(directory,'published.json'),{force:true});
    for(const [file,bytes] of Object.entries(files)) {await rm(join(directory,'dist',file),{force:true});await writeFile(join(directory,'dist',file),bytes);}
  };
  const run=(overrides={})=>spawnSync('bash',['-e','-c',verify+'\n'+publish],{cwd:directory,env:{...env,...overrides},encoding:'utf8'});
  await reset(); const healthy=run(); assert.equal(healthy.status,0, healthy.stderr+healthy.stdout);
  const args=JSON.parse(await readFile(join(directory,'published.json'),'utf8'));
  assert.equal(args[2],env.GITHUB_REF_NAME);
  await assert.rejects(readFile(join(directory,'marker')),/ENOENT/);
  for(const file of Object.keys(files)) {
    await reset(); await writeFile(join(directory,'dist',file),'synthetic tampering');
    assert.notEqual(run().status,0,file);
    await assert.rejects(readFile(join(directory,'published.json')),/ENOENT/);
  }
  for(const overrides of [{TAR_SHA:''},{MANIFEST_SHA:'$(touch marker)'},{GITHUB_SHA:'f'.repeat(40)},{FIXTURE_TAG_SHA:'f'.repeat(40)},{FIXTURE_WRITE_DENIED:'1'}]) {
    await reset(); assert.notEqual(run(overrides).status,0);
    await assert.rejects(readFile(join(directory,'published.json')),/ENOENT/);
  }
  await reset(); await rm(join(directory,'dist','doctorcre-app.tar'));
  await symlink(join(directory,'dist','doctorcre-app.tar.sha256'),join(directory,'dist','doctorcre-app.tar'));
  assert.notEqual(run().status,0);
  await assert.rejects(readFile(join(directory,'published.json')),/ENOENT/);
});

test('action pins agree with authenticated canonical release evidence', async () => {
  await checkActionPins(root);
});

{
const source = await readFile(new URL('../.githooks/pre-push', import.meta.url), 'utf8');
async function fixture(t, { slow = false, budgetMs = slow ? 100 : 170_000 } = {}) {
  const root = await temporaryDirectory('pre-push-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.githooks'));
  await mkdir(join(root, 'test'));
  await mkdir(join(root, 'bin'));
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'dir');
  await writeFile(join(root, '.gitignore'), 'node_modules\n');
  await writeFile(join(root, '.githooks/pre-push'), source.replace('170_000', String(budgetMs)));
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
    { cwd: root, input, encoding: 'utf8', env: { ...process.env, npm_config_cache: join(root, '.git', 'npm-cache') }, timeout: 20_000 });
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

test('an exhausted pre-push budget names the deadline before starting checks', async t => {
  const f = await fixture(t, { budgetMs: 0 });
  const result = f.push();
  assert.equal(result.status, 124, result.stdout + result.stderr);
  assert.match(result.stderr, /exceeded 170 seconds/);
  assert.doesNotMatch(result.stdout, /CHECK-RAN|TOUCHED-RAN/);
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

}

test('required CI runs the strict no-emit UI typecheck', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const config = JSON.parse(await readFile(new URL('../tsconfig.json', import.meta.url), 'utf8'));
  const checks = ci.split(/^  checks:\n/m)[1].split(/^  \w+:/m)[0];
  assert.equal(config.compilerOptions.strict, true);
  assert.equal(config.compilerOptions.noEmit, true);
  assert.ok(config.include.includes('src/ui'));
  assert.equal(pkg.scripts.typecheck, 'tsc --noEmit -p tsconfig.json');
  assert.match(pkg.scripts.check, /npm run typecheck/);
  assert.match(checks, /run: npm run check/);
});
