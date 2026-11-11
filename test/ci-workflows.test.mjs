import { checkProductionWorkflow } from '../scripts/check-production-workflow.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { checkActionPins } from "../scripts/check-action-pins.mjs";

const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const checks = await readFile(new URL("../.github/workflows/checks.yml", import.meta.url), "utf8");
const release = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const root = fileURLToPath(new URL("../", import.meta.url));
execFileSync(process.execPath, ["scripts/strict-projects.ts"], { cwd: root });

const workflowDocument = source => parseYaml(source);
const eventCondition = (expression = 'true', github = {}) => runInNewContext(
  expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''),
  { github, always: () => true, cancelled: () => false },
);

test('merge groups run every required CI job on the group SHA and emit exactly test', async () => {
  const document = workflowDocument(ci);
  const events = document.on ?? document.true;
  assert.deepEqual(events.merge_group, { types: ['checks_requested'] });
  assert.ok(events.pull_request);
  assert.deepEqual(events.push, { branches: ['main'] });
  const github = { event_name: 'merge_group', sha: 'a'.repeat(40), event: {
    merge_group: { head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40) },
  } };
  const jobs = document.jobs;
  assert.ok(eventCondition(jobs.test.if, github), 'test must run on merge groups');
  assert.equal(jobs.test.name ?? 'test', 'test');
  assert.equal(jobs.test.strategy, undefined, 'required check must not gain a matrix suffix');
  assert.deepEqual(jobs.test.needs, ['checks', 'shards', 'performance', 'live']);
  assert.deepEqual(jobs.shards.strategy.matrix.shard, [1, 2, 3, 4]);
  assert.equal(jobs.checks.uses, './.github/workflows/checks.yml');
  const reusable = workflowDocument(checks);
  assert.ok(Object.hasOwn(reusable.on ?? reusable.true, 'workflow_call'));
  assert.equal((reusable.on ?? reusable.true).merge_group, undefined);
  for (const [name, job] of [
    ...jobs.test.needs.map(name => [name, jobs[name]]),
    ['reusable checks', reusable.jobs.checks],
  ]) {
    assert.ok(eventCondition(job.if, github), `${name} must run on merge groups`);
    if (!job.steps) continue;
    const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    assert.ok(checkout, `${name} needs app source`);
    assert.equal(checkout.with?.ref ?? '${{ github.sha }}', '${{ github.sha }}', name);
    for (const step of job.steps.filter(step => step.run && !step.name?.includes('typed surfaces'))) {
      if (step.if?.includes("github.event_name == 'push'") || step.if?.includes("github.event_name == 'pull_request'")) continue;
      assert.ok(eventCondition(step.if, github), `${name}: ${step.name ?? step.run}`);
    }
  }
  const aggregate = jobs.test.steps.find(step => step.env?.CHECKS);
  assert.ok(eventCondition(aggregate.if, github), 'test must enforce dependency results on merge groups');
  for (const name of jobs.test.needs) {
    assert.equal(aggregate.env[name.toUpperCase()], `\${{ needs.${name}.result }}`);
    const env = Object.fromEntries(jobs.test.needs.map(job => [job.toUpperCase(), 'success']));
    const invoke = overrides => spawnSync('bash', ['-e', '-c', aggregate.run], {
      encoding: 'utf8', env: { ...env, EVENT: 'merge_group', ...overrides },
    });
    assert.equal(invoke({}).status, 0);
    for (const result of ['failure', 'cancelled', 'skipped']) {
      assert.notEqual(invoke({ [name.toUpperCase()]: result }).status, 0, `${name} ${result}`);
    }
  }
  assert.equal(eventCondition(jobs.preview.if, github), false);
  const deploy = workflowDocument(await readFile(new URL('../.github/workflows/deploy-production.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(deploy.on ?? deploy.true), ['workflow_run']);
  for (const event of ['merge_group', 'pull_request', 'push']) {
    const context = { repository: 'synthetic/app', event: { workflow_run: {
      status: 'completed', conclusion: 'success', event, head_branch: event === 'merge_group' ? 'gh-readonly-queue/main/pr-1-base' : 'main',
      head_repository: { full_name: 'synthetic/app' },
    } } };
    assert.equal(eventCondition(deploy.jobs.production.if, context), event === 'push');
  }
});

test('typed surfaces check the merge group against its base and reject new JavaScript UI', async t => {
  const step = workflowDocument(checks).jobs.checks.steps.find(step => step.name === 'Require typed surfaces');
  const directory = await temporaryDirectory('queue-typed-surfaces-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = () => {
    git('add', 'src');
    git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  await mkdir(join(directory, 'src/ui'), { recursive: true });
  await writeFile(join(directory, 'src/ui/existing.js'), 'export {};');
  const base = commit();
  await writeFile(join(directory, 'src/ui/new.tsx'), 'export {};');
  commit();
  for (const event_name of ['pull_request', 'merge_group']) {
    const github = { event_name, event: event_name === 'merge_group'
      ? { pull_request: { base: { sha: '' } }, merge_group: { base_sha: base } }
      : { pull_request: { base: { sha: base } }, merge_group: { base_sha: '' } } };
    assert.ok(eventCondition(step.if, github), event_name);
    const baseSha = eventCondition(step.env.BASE_SHA, github);
    assert.equal(baseSha, base);
    const invoke = () => spawnSync('bash', ['-e', '-c', step.run.replace('scripts/check-typed-surfaces.mjs', join(root, 'scripts/check-typed-surfaces.mjs'))], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, BASE_SHA: baseSha },
    });
    assert.equal(invoke().status, 0);
    await writeFile(join(directory, 'src/ui/forbidden.js'), 'export {};');
    commit();
    const rejected = invoke();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /src\/ui\/forbidden.js/);
    git('reset', '--hard', 'HEAD~1');
  }
  for (const event_name of ['push', 'schedule', 'workflow_dispatch']) {
    assert.equal(eventCondition(step.if, { event_name }), false);
  }
});

test('signed-in Calendar CI installs the producer PostgreSQL binaries before its real journey', () => {
  assert.match(ci, /uses: \.\/\.github\/workflows\/checks\.yml/);
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
  const workflows = [ci, checks, await readFile(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8")];
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
  const steps = checks.split(/^      - /m).slice(1);
  const appCheckout = steps.find(step => /^uses: actions\/checkout@/m.test(step));
  const producerCheckout = steps.find(step => /repository: DoctorCRE\/carr-system/.test(step));
  const app = resolve(workspace, appCheckout.match(/path: (\S+)/)?.[1] ?? ".");
  const producer = resolve(workspace, producerCheckout.match(/path: (\S+)/)[1]);
  await mkdir(app, { recursive: true });
  const archive = join(workspace, "app.tar");
  execFileSync("git", ["archive", "-o", archive, "HEAD"], { cwd: root });
  execFileSync("tar", ["-xf", archive, "-C", app]);
  execFileSync("git", ["init", "-q"], { cwd: app });
  await symlink(join(root, "node_modules"), join(app, "node_modules"), "dir");
  await mkdir(join(producer, ".github/workflows"), { recursive: true });
  // Synthetic external source reproduces the scanner refusal without reading
  // credentials or requiring the producer checkout for this offline test.
  const externalSource = `connection: ${"post" + "gresql"}://synthetic.invalid/example\n`;
  await writeFile(join(producer, ".github/workflows/producer.yml"), externalSource);
  const result = execFileSync(process.execPath, ["scripts/check-repository.mjs"], { cwd: app, encoding: "utf8" });
  assert.match(result, /repository check passed/);
  assert.equal(checks.match(/working-directory: (\S+)/)?.[1], appCheckout.match(/path: (\S+)/)?.[1]);
  assert.match(checks, new RegExp(`cache-dependency-path: ${appCheckout.match(/path: (\S+)/)?.[1]}/package-lock\\.json`));
  await writeFile(join(app, "app-owned.yml"), externalSource);
  assert.throws(() => execFileSync(process.execPath, ["scripts/check-repository.mjs"], { cwd: app, stdio: "pipe" }),
    /app-owned\.yml contains a database connection string/, "app-owned content must remain guarded");
});

test('source CI keeps the full required suite and checks privacy before browser downloads', async t => {
  const steps = checks.split(/^      - /m).slice(1);
  assert.match(ci, /^  test:/m);
  assert.match(ci, /^  checks:\n.*\n    uses: \.\/\.github\/workflows\/checks\.yml\n    secrets: inherit$/m);
  // The live job runs producer code, so CI never runs on a schedule or dispatch;
  // the nightly backstop runs the checks workflow on its own.
  assert.doesNotMatch(ci.split(/^jobs:/m)[0], /schedule|workflow_dispatch/);
  assert.match(checks, /^  workflow_call:\n  schedule:\n    - cron: "17 3 \* \* \*"\n  workflow_dispatch:$/m);
  assert.match(ci, /types: \[opened, synchronize, reopened, ready_for_review, edited\]/);
  const performance = ci.split(/^  performance:\n/m)[1].split(/^  live:/m)[0];
  const measurement = performance.split(/^      - /m).find(step => /^run: npm run performance:check$/m.test(step));
  assert.match(measurement, /^        continue-on-error: true$/m);
  assert.equal(ci.match(/continue-on-error:/g)?.length, 1,
    'only the performance measurement is report-only; setup and all other checks still block');
  assert.match(performance, /path: \|\n            doctorcre-app\/test-artifacts\/performance\/report\.json\n            doctorcre-app\/test-artifacts\/performance\/summary\.md/);
  const publication = workflowDocument(ci).jobs.performance.steps.find(step => step.name === 'Publish performance summary');
  assert.equal(publication.if, '${{ !cancelled() }}');
  const directory = temporaryDirectory('ci-performance-summary-', t);
  const output = join(directory, 'published summary.md');
  const existing = 'Previous step summary.\n';
  const summary = '### Mobile performance budget\n\nSynthetic measurement results.\n';
  for (const present of [false, true]) {
    if (present) {
      await mkdir(join(directory, 'test-artifacts/performance'), { recursive: true });
      await writeFile(join(directory, 'test-artifacts/performance/summary.md'), summary);
    }
    await writeFile(output, existing);
    const run = spawnSync('bash', ['-e', '-c', publication.run], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: output },
    });
    assert.equal(run.status, 0, run.stderr);
    const published = await readFile(output, 'utf8');
    if (present) {
      assert.equal(published, existing + summary, 'publish the complete measurement summary without replacing previous steps');
    } else {
      assert.ok(published.startsWith(existing), 'preserve previous steps when measurement output is absent');
      assert.match(published.slice(existing.length), /Measurement failed\./);
      assert.match(published.slice(existing.length), /Screen: unavailable/);
    }
  }
  assert.match(ci, /test "\$PERFORMANCE" = success/,
    'the aggregate consumes the successful job conclusion after a tolerated measurement failure');
  assert.match(ci, /node --test --test-shard=\$\{\{ matrix.shard \}\}\/4/);
  // A hung test fails by name and file instead of stalling the shard to its job timeout.
  assert.match(ci, /browser-results.py out\/browser-results\/junit.xml/);
  assert.match(ci, /needs: \[checks, shards, performance, live\]/);
  const privacy = steps.findIndex(step => /^run: npm run privacy:check$/m.test(step));
  const browser = steps.findIndex(step => /^run: npx playwright install/m.test(step));
  assert.ok(privacy >= 0 && privacy < browser);
});

test('browser dependencies use official Ubuntu mirrors after privacy checks', async t => {
  const steps = checks.split(/^      - /m).slice(1);
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
  const env={...process.env,PATH:`${join(directory,'bin')}:${process.env.PATH}`,GITHUB_SHA:sha,GITHUB_REPOSITORY:'jbookout/doctorcre-app',GITHUB_REF_NAME:'app-v$(touch marker)',MANIFEST_REPOSITORY:'jbookout/doctorcre-app',TAR_SHA:hashes[0],MANIFEST_SHA:hashes[1],SIDECAR_SHA:hashes[2]};
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
    lint: 'node -e "console.log(\'LINT-RAN\')"',
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
  assert.match(result.stdout, /LINT-RAN/);
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
  const checksJob = checks.split(/^  checks:\n/m)[1].split(/^  \w+:/m)[0];
  assert.equal(config.compilerOptions.strict, true);
  assert.equal(config.compilerOptions.noEmit, true);
  assert.ok(config.include.includes('src/ui'));
  assert.equal(pkg.scripts.typecheck, 'tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.worker.json');
  assert.match(pkg.scripts.check, /npm run typecheck/);
  assert.match(checksJob, /run: npm run check/);
});

test('main and PR synthetic shards retain first attempts and gate critical execution', () => {
  const shards = ci.split(/^  shards:\n/m)[1].split(/^  performance:/m)[0];
  assert.doesNotMatch(shards, /if: \$\{\{ github.event_name == 'pull_request' \}\}/);
  assert.match(shards, /node --test --test-shard=/);
  assert.match(shards, /--shard \$\{\{ matrix.shard \}\}/);
  assert.match(shards, /if: \$\{\{ always\(\) \}\}[\s\S]*browser-results.py out\/browser-results\/junit.xml/);
  assert.match(shards, /retention-days: 14/);
  assert.match(shards, /browser-results-\$\{\{ github.sha \}\}-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}-\$\{\{ matrix.shard \}\}/);
  const gate = ci.split(/^  test:\n/m)[1].split(/^  preview:/m)[0];
  assert.doesNotMatch(gate, /download-artifact|browser-results.py|run_attempt/);
  assert.match(shards, /annotate_only: true/);
  for (const option of ['fail_on_failure', 'fail_on_parse_error', 'require_tests', 'require_passed_tests']) {
    assert.ok(shards.includes(`${option}: true`));
  }
  assert.match(shards, /check_retries: false/);
  assert.doesNotMatch(ci, /pull_request_target/);
  const shell = gate.split('        run: |\n')[1].replace(/^          /gm, '');
  for (const event of ['push', 'pull_request']) for (const dependency of ['CHECKS', 'LIVE', 'SHARDS', 'PERFORMANCE']) for (const outcome of ['success', 'failure', 'cancelled', 'skipped']) {
    const result = spawnSync('bash', ['-e', '-c', shell], { encoding: 'utf8',
      env: { ...process.env, CHECKS:'success', LIVE:'success',
        PERFORMANCE:'success', SHARDS:'success', EVENT:event, [dependency]:outcome } });
    assert.equal(result.status === 0, outcome === 'success', `${event} ${dependency} ${outcome}`);
  }
});

const validationWorkflow = parseYaml(ci);

function validationPolicy({ eventName = 'pull_request', action = 'opened', changes = {}, number = 7, runId = 1, workflow = validationWorkflow.name } = {}) {
  const github = { workflow, event_name: eventName, run_id: runId,
    event: { action, changes, ...(eventName === 'pull_request' ? { pull_request: { number, head: { sha: 'fixture-head' } } } : {}) } };
  const evaluate = value => {
    const expression = value.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
    assert.match(expression, /^(?:github(?:\.[a-z_]+)+|'[^']*'|null|[\s()=!&|])+$/);
    const resolved = expression.replace(/github(?:\.[a-z_]+)+/g, path =>
      JSON.stringify(path.split('.').slice(1).reduce((value, key) => value?.[key], github) ?? null));
    return runInNewContext(resolved, {}, { timeout: 1000 });
  };
  const trigger = (validationWorkflow.on ?? validationWorkflow.true)[eventName];
  return {
    triggers: Boolean(trigger && (!trigger.types || trigger.types.includes(action))),
    group: validationWorkflow.concurrency.group.replace(/\$\{\{.*?\}\}/g, evaluate),
    cancel: evaluate(validationWorkflow.concurrency['cancel-in-progress']),
  };
}

test('CI metadata edits queue fresh validation without cancelling the active run', () => {
  const active = validationPolicy();
  for (const [action, changes, triggers, cancel] of [
    ['edited', { body: { from: 'previous proof' } }, true, false],
    ['opened', {}, true, false],
    ['reopened', {}, true, false],
    ['synchronize', {}, true, true],
    ['ready_for_review', {}, true, true],
    ['edited', {}, true, false],
    ['edited', { title: { from: 'previous title' } }, true, false],
    ['edited', { base: { ref: { from: 'previous-base' } } }, true, true],
    ['edited', { body: { from: 'old' }, base: { ref: { from: 'old' } } }, true, true],
    ['labeled', {}, false, false],
    ['unlabeled', {}, false, false],
  ]) {
    const policy = validationPolicy({ action, changes });
    assert.equal(policy.triggers, triggers, action);
    assert.equal(policy.group, active.group, action);
    assert.equal(policy.cancel, cancel, action + ' ' + JSON.stringify(changes));
  }
  const sequence = ['ready_for_review', 'edited', 'edited', 'synchronize'].map(action => validationPolicy({ action }));
  assert.deepEqual(sequence.map(policy => policy.group), Array(4).fill(active.group));
  assert.deepEqual(sequence.map(policy => policy.cancel), [true, false, false, true]);
});

test('CI isolates PRs, workflows, main pushes and merge-group runs', () => {
  const active = validationPolicy();
  assert.notEqual(validationPolicy({ number: 8 }).group, active.group);
  assert.notEqual(validationPolicy({ workflow: 'Review gate' }).group, active.group);
  for (const eventName of ['push', 'merge_group']) {
    const policy = validationPolicy({ eventName });
    assert.equal(policy.triggers, eventName === 'push');
    assert.equal(policy.cancel, false);
    assert.notEqual(policy.group, active.group);
    assert.equal(policy.group, validationPolicy({ eventName, runId: 2 }).group);
  }
});


test('shard deadline admits the recorded main CI workload plus setup headroom', () => {
  const shard = ci.split(/^  shards:\n/m)[1].split(/^  performance:/m)[0];
  const deadlineMinutes = Number(shard.match(/timeout-minutes: (\d+)/)[1]);
  // Main run 42118414420 exhausted 900 seconds with a test still running.
  const exhaustedSeconds = 900;
  const setupAndVarianceSeconds = 300;
  assert.ok(deadlineMinutes * 60 > exhaustedSeconds + setupAndVarianceSeconds,
    'allow the recorded 15-minute workload plus five minutes of setup and runner variance');
  assert.ok(deadlineMinutes <= 30, 'keep the shard bounded');
});

test('release handoff admits both app identities through the source rule and refuses other repositories', async t => {
  const bind = release.match(/        name: Bind handoff bytes[\s\S]*?        run: \|\n([\s\S]*?)      - id: artifact/)[1].replace(/^          /gm, '');
  const directory = temporaryDirectory('release-repository-', t);
  const { mkdir, copyFile } = await import('node:fs/promises');
  await mkdir(join(directory, 'js')); await mkdir(join(directory, 'dist'));
  await copyFile(new URL('../js/repository-identity.mjs', import.meta.url), join(directory, 'js/repository-identity.mjs'));
  for (const repository of ['jbookout/doctorcre-app', 'DoctorCRE/doctorcre-app', 'DoctorCRE/other']) {
    await writeFile(join(directory, 'dist/doctorcre-app.manifest.json'), JSON.stringify({ repository }));
    for (const file of ['doctorcre-app.tar', 'doctorcre-app.tar.sha256']) await writeFile(join(directory, 'dist', file), 'fixture');
    const output = join(directory, 'output'); await writeFile(output, '');
    const result = spawnSync('bash', ['-e', '-c', bind], { cwd: directory, env: { ...process.env, GITHUB_OUTPUT: output }, encoding: 'utf8' });
    assert.equal(result.status === 0, repository !== 'DoctorCRE/other', result.stderr);
    const text = await readFile(output, 'utf8');
    assert.equal(text.includes(`manifest_repository=${repository}\n`), repository !== 'DoctorCRE/other');
  }
});

 test('typed watch journeys belong to browser collection and remain typechecked', async () => {
 const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
 const config = JSON.parse(await readFile(new URL('../tsconfig.node.generated.json', import.meta.url), 'utf8'));
 assert.ok(config.files.includes('test/watch-controls.browser.ts'));
 assert.match(pkg.scripts.test, /test\/\*\.browser\.ts/);
 assert.match(ci, /test\/\*\.test\.mjs test\/\*\.browser\.ts/);
 assert.match(checks, /node --test test\/\*\.browser\.ts/);
 });


test('reply proof browser journeys run after browser installation and remain typechecked', async () => {
  const config = JSON.parse(await readFile(new URL('../tsconfig.node.generated.json', import.meta.url), 'utf8'));
  assert.ok(config.files.includes('test/prove-reply-action-link.browser.ts'));
  assert.ok(!config.files.includes('test/prove-reply-action-link.test.ts'));
  const steps = workflowDocument(checks).jobs.checks.steps;
  const install = steps.findIndex(step => step.run === 'npx playwright install --with-deps chromium webkit');
  const journeys = steps.findIndex(step => step.run === 'node --test test/*.browser.ts');
  assert.ok(install >= 0 && install < journeys);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.test, /test\/\*\.browser\.ts/);
  assert.match(ci, /test\/\*\.test\.mjs test\/\*\.browser\.ts/);
});


test('every production writer obeys successful exact-SHA completion admission', () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  checkProductionWorkflow(Object.fromEntries(readdirSync(directory).filter(name => /\.ya?ml$/.test(name))
    .map(name => [name, readFileSync(new URL(name, directory), 'utf8')])));
});


test('live restores and saves verified zsh archives before installing the producer', () => {
  const steps = workflowDocument(ci).jobs.live.steps;
  const cacheIndex = steps.findIndex(step => step.name === 'Restore zsh package archives');
  const installIndex = steps.findIndex(step => step.env?.ZSH_ARCHIVE_DIR);
  assert.ok(cacheIndex >= 0 && cacheIndex < installIndex);
  const cache = steps[cacheIndex];
  assert.equal(cache.uses, 'actions/cache@5a3ec84eff668545956fd18022155c47e93e2684');
  assert.equal(cache.with.path, steps[installIndex].env.ZSH_ARCHIVE_DIR + '/*.deb');
  assert.equal(cache.with.key, "zsh-ubuntu24-${{ runner.arch }}-${{ steps.zsh-image.outputs.version }}-${{ hashFiles('carr-producer/ops/ci-zsh.sh', 'carr-producer/ops/ci_zsh.py') }}");
  assert.equal(cache.with['restore-keys'], undefined);
  const imageIndex = steps.findIndex(step => step.id === 'zsh-image');
  assert.ok(imageIndex >= 0 && imageIndex < cacheIndex);
  assert.match(steps[imageIndex].run, /version=\$ImageVersion/);
});
