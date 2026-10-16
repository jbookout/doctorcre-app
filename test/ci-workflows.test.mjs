import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { context, policy, expression } from "./workflow-policy.mjs";

const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const release = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const harnessSource = await readFile(new URL("./browser-harness.mjs", import.meta.url), "utf8");
const nodeEngines = [...harnessSource.matchAll(/export const (\w+) = browserEngine\(/g)].map(match => match[1]).sort();
const root = fileURLToPath(new URL("../", import.meta.url));

test("the CI checkout layout keeps producer-owned content out of app repository checks", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "doctorcre-checkout-layout-"));
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

// Execute the workflow's shell steps with instrumented tools. This small reader
// supports the workflows' run/if forms and refuses unfamiliar conditions.
function commands(workflow, event, action = "opened") {
  if (workflow !== release && !policy(workflow, context(event, action)).runnable.length) return [];
  return workflow.split(/^      - /m).slice(1).flatMap((step) => {
    const run = step.match(/^(?:run:|\s+run:) (.+)$/m)?.[1];
    if (!run) return [];
    const condition = step.match(/^\s*if: (.+)$/m)?.[1];
    if (condition) {
      if (!expression(condition, context(event, action))) return [];
    }
    if (run === ">-") return [step.match(/^        run: >-\n((?:          .+\n?)+)/m)[1].trim().replace(/\n\s*/g, " ")];
    if (run === "|") return [step.match(/^        run: \|\n((?:          .+\n?)+)/m)[1].replace(/^          /gm, "")];
    return [run];
  });
}

async function replay(t, workflow, event, failCommand = "", input = {}) {
  const directory = await mkdtemp(join(tmpdir(), "doctorcre-workflow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trace = join(directory, "trace");
  const eventPath = join(directory, "event.json");
  await writeFile(eventPath, input.event ?? JSON.stringify({ pull_request: { body: input.body ?? "Workflow validation repair." } }));
  const salt = "1".repeat(32);
  const canary = "Synthetic privacy canary";
  const corpusPath = join(directory, "corpus.json");
  await writeFile(corpusPath, JSON.stringify({ schema: "doctorcre-private-name-hashes.v1", salt, maxTokens: 3,
    hashes: [createHash("sha256").update(`${salt}\0syntheticprivacycanary`).digest("hex")] }));
  await writeFile(join(directory, "fixture.txt"), input.privacyText ?? "Safe synthetic fixture");
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", ["-C", directory, "add", "fixture.txt"]);
  for (const tool of ["npm", "node", "gh", "npx"]) {
    const path = join(directory, tool);
    await writeFile(path, `#!/bin/sh
printf '%s\\n' '${tool}'\" $*\" >> \"$TRACE\"
if [ '${tool}'\" $*\" = \"$FAIL_COMMAND\" ]; then exit \"$FAIL_CODE\"; fi
case '${tool}'\" $*\" in
  'node scripts/check-pr-description.mjs') exec \"$REAL_NODE\" \"$APP_ROOT/scripts/check-pr-description.mjs\" ;;
  'npm run privacy:check') exec \"$REAL_NODE\" \"$APP_ROOT/scripts/privacy/client-data-check.mjs\" --root \"$FIXTURE_ROOT\" --corpus \"$CORPUS\" ;;
esac
`);
    await chmod(path, 0o755);
  }
  let failed = false;
  let output = "";
  for (const command of commands(workflow, event, input.action)) {
    const result = spawnSync("bash", ["-e", "-c", command], { env: {
        ...process.env, PATH: `${directory}:${process.env.PATH}`, TRACE: trace,
        FAIL_COMMAND: failCommand, GITHUB_REF_NAME: "app-v-fixture", GITHUB_SHA: "1".repeat(40),
        FAIL_CODE: String(input.failCode ?? 1), REAL_NODE: process.execPath, APP_ROOT: root,
        FIXTURE_ROOT: directory, CORPUS: corpusPath, GITHUB_EVENT_PATH: eventPath,
      }, encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error);
    output += result.stdout + result.stderr;
    if (result.status !== 0) {
      failed = true;
      break;
    }
  }
  assert.equal(output.toLowerCase().includes(canary.toLowerCase()), false, "validator output must not expose the privacy canary");
  return { failed, trace: (await readFile(trace, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; })).trim().split("\n").filter(Boolean) };
}

test("Open PRs retain the required test job and full suite", async (t) => {
  assert.match(ci, /^  pull_request:\s*$/m);
  assert.match(ci, /^  test:\n(?:    if:.*\n)?    runs-on:/m);
  assert.doesNotMatch(ci, /^\s+(?:paths|paths-ignore|branches-ignore):/m);
  const result = await replay(t, ci, "pull_request", "npm test");
  assert.equal(result.failed, true);
  assert.ok(result.trace.includes("npm test"));
  assert.equal(result.trace.includes("npm run build"), false, "failed tests cannot yield a green job");
});

for (const [name, workflow, suite] of [["CI", ci, "npm test"]]) {
  test(`${name}: invalid privacy/body/repository input starts zero browser downloads`, async (t) => {
    for (const input of [{ privacyText: "Synthetic privacy canary" }, { body: "## What changed\n<!-- empty -->" },
      { event: "{" }, { event: "{}" }]) {
      const result = await replay(t, workflow, "pull_request", "", input);
      assert.equal(result.failed, true, JSON.stringify(input));
      assert.equal(result.trace.some(command => command.startsWith("npx playwright install")), false, result.trace.join("\n"));
      assert.equal(result.trace.includes(suite), false);
    }
    const invalid = await replay(t, workflow, "pull_request", "npm run check");
    assert.equal(invalid.failed, true);
    assert.equal(invalid.trace.some(command => command.startsWith("npx playwright install")), false);
    const healthy = await replay(t, workflow, "pull_request");
    assert.equal(healthy.failed, false);
    for (const check of ["node scripts/check-pr-description.mjs", "npm run privacy:check", "npm run check"]) {
      assert.ok(healthy.trace.indexOf(check) >= 0 && healthy.trace.indexOf(check) < healthy.trace.findIndex(command => command.startsWith("npx playwright install")));
    }
    assert.equal(healthy.trace.filter(command => command === suite).length, 1);
    const testCommands = ["node --test test/property-producer.test.mjs", "npm test"];
    assert.deepEqual(healthy.trace.filter(command => command === suite || command === "npm test" || command.startsWith("node --test ")), testCommands,
      "healthy heads retain the complete test command inventory");
    const push = await replay(t, workflow, "push", "npm run privacy:check");
    assert.equal(push.failed, true);
    assert.equal(push.trace.includes("node scripts/check-pr-description.mjs"), false);
    assert.equal(push.trace.some(command => command.startsWith("npx playwright install")), false);
  });

  test(`${name}: missing or cancelled required tests cannot pass`, async (t) => {
    assert.match(workflow, new RegExp(`^  test:\\n(?:    if:.*\\n)?    runs-on:`, "m"));
    requireSuite(workflow, suite);
    for (const failCode of [1, 130]) {
      assert.equal((await replay(t, workflow, "pull_request", suite, { failCode })).failed, true);
    }
    const missing = workflow.replace(`      - run: ${suite}\n`, "");
    assert.throws(() => requireSuite(missing, suite), /strictly equal/, "missing-test control must fail the same oracle");
    assert.throws(() => requireSuite(workflow.replace(`      - run: ${suite}`, `      - if: github.event_name == 'push'\n        run: ${suite}`), suite),
      /strictly equal/, "skipped PR tests must fail the same oracle");
  });
}

function installedEngines(workflow) {
  const installs = commands(workflow, "pull_request").filter(command => command.startsWith("npx playwright install --with-deps "));
  assert.equal(installs.length, 1, "one pinned install per workflow");
  return installs[0].replace("npx playwright install --with-deps ", "").split(" ").sort();
}

function requireSuite(workflow, suite) {
  if (workflow !== release) {
    const open = policy(workflow, context());
    assert.deepEqual(open.runnable, open.jobs, "every open PR job must run");
    assert.deepEqual(policy(workflow, context("pull_request", "closed")).runnable, []);
  }
  assert.doesNotMatch(workflow, /continue-on-error:|^\s+(?:paths|paths-ignore|branches-ignore):/m);
  assert.equal(commands(workflow, "pull_request").filter(command => command === suite).length, 1);
}

test("installed engines match the actual Node selections and lockfile pin", async () => {
  assert.ok(nodeEngines.length, "engine selections must be readable");
  for (const [workflow, engines] of [[ci, nodeEngines], [release, nodeEngines]]) {
    assert.deepEqual(installedEngines(workflow), engines);
  }
  assert.throws(() => assert.deepEqual(installedEngines(ci.replace("chromium webkit", "chromium")), nodeEngines),
    /deep-equal/, "missing-WebKit replay must fail the same parity oracle");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url)));
  assert.match(pkg.devDependencies.playwright, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.packages["node_modules/playwright"].version, pkg.devDependencies.playwright);
  assert.equal(lock.packages["node_modules/playwright-core"].version, pkg.devDependencies.playwright);
  for (const workflow of [ci, release]) {
    const steps = commands(workflow, "pull_request");
    assert.ok(steps.indexOf("npm ci") >= 0 && steps.indexOf("npm ci") < steps.findIndex(command => command.startsWith("npx playwright install")));
  }
});

test("every selected Node engine launches with the installed pinned Playwright", async (t) => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  for (const name of ["playwright", "playwright-core"]) {
    const installed = JSON.parse(await readFile(new URL(`../node_modules/${name}/package.json`, import.meta.url)));
    assert.equal(installed.version, pkg.devDependencies.playwright);
  }
  const harness = await import("./browser-harness.mjs");
  for (const name of nodeEngines) {
    await t.test(name, async () => {
      const browser = await harness[name].launch();
      try {
        const page = await browser.newPage();
        await page.setContent("<title>Pinned engine ready</title>");
        assert.equal(await page.title(), "Pinned engine ready");
      } finally { await browser.close(); }
    });
  }
});

test("the job budget covers the observed full suite plus setup and artifact verification", () => {
  // PR 128 run 37174053422 passed its tests in 543.6 s, but the ten-minute
  // job deadline cancelled it before build/verify. By 2026-10-12 hosted PR
  // suites took up to 736 s (run 38240720800), and CI also runs the ~118 s
  // mobile performance stage (run 37382765030). Leave room for both and
  // runner variation while keeping a finite bound on hung jobs.
  const suiteMs = 736_000;
  const setupMs = 120_000;
  const artifactMs = 60_000;
  const performanceMs = 120_000;
  for (const [name, workflow, extraMs] of [["CI", ci, performanceMs], ["release", release, 0]]) {
    const requiredMs = (setupMs + suiteMs + artifactMs + extraMs) * 1.25;
    const minutes = Number(workflow.match(/^    timeout-minutes: (\d+)$/m)?.[1]);
    assert.ok(Number.isFinite(minutes) && minutes > 0, `${name} needs a finite deadline`);
    assert.ok(minutes * 60_000 >= requiredMs, `${name}: the full check sequence must fit with 25% runner headroom`);
  }
});

test("description check runs for PRs and stays out of main pushes", () => {
  const check = "node scripts/check-pr-description.mjs";
  assert.equal(commands(ci, "pull_request").filter(command => command === check).length, 1);
  assert.equal(commands(ci, "push").includes(check), false);
});

test("CI verifies the contract's exact CARR producer without opt-in skips", async (t) => {
  const steps = ci.split(/^      - /m).slice(1);
  const pin = steps.find(step => /^id: producer$/m.test(step));
  assert.ok(pin, "CI must obtain the runtime pin from the consumer contract");
  assert.match(pin, /contracts\/carr-interface\.v1\.json/);
  assert.match(pin, /producer\.source_commit/);
  assert.match(pin, /GITHUB_OUTPUT/);
  const checkout = steps.find(step => /repository: jbookout\/carr-system/.test(step));
  assert.ok(checkout, "CI must fetch committed producer source");
  assert.match(checkout, /ref: \$\{\{ steps\.producer\.outputs\.commit \}\}/);
  assert.match(checkout, /fetch-depth: 0/, "ancestor checks require producer history");
  assert.match(checkout, /persist-credentials: false/);
  const directory = checkout.match(/path: (\S+)/)?.[1];
  assert.ok(directory);
  const verification = steps.find(step => /^run: node --test test\/property-producer\.test\.mjs$/m.test(step));
  assert.ok(verification, "producer compatibility must be executed explicitly");
  assert.ok(verification.includes(`CARR_PRODUCER_CHECKOUT: \${{ github.workspace }}/${directory}`));
  assert.doesNotMatch(verification, /continue-on-error:/);
  const condition = verification.match(/^        if: (.+)$/m)?.[1];
  for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review']) {
    assert.equal(expression(condition, context('pull_request', action)), true);
  }
  assert.equal(expression(condition, context('pull_request', 'edited')), false);
  assert.ok(steps.indexOf(checkout) < steps.indexOf(verification));
  const failure = "node --test test/property-producer.test.mjs";
  for (const event of ["pull_request", "push"]) {
    const run = commands(ci, event);
    const generate = run.indexOf("npm run slices:check");
    assert.ok(generate >= 0 && generate < run.indexOf(failure),
      "generate the Worker route contracts before importing the producer tests");
    const result = await replay(t, ci, event, failure);
    assert.equal(result.failed, true, event);
    assert.ok(result.trace.includes(failure));
    assert.equal(result.trace.includes("npm run build"), false, "incompatible pins cannot reach a green build");
  }
});

test("main keeps artifact checks while avoiding a repeated full suite", async (t) => {
  const pr = await replay(t, ci, "pull_request");
  const main = await replay(t, ci, "push");
  assert.equal(main.failed, false);
  assert.equal(pr.trace.filter((command) => command === "npm test").length, 1);
  assert.equal(main.trace.filter((command) => command === "npm test").length, 0);
  assert.ok(main.trace.some((command) => command.startsWith("node --test ") && command.includes("test/artifact.test.mjs")));
  for (const command of ["npm run check", "npm run build", "npm run artifact:verify"]) assert.ok(main.trace.includes(command));
});

test("release retains full tests and source verification before publication", async (t) => {
  for (const failure of ["npm test", "npm run artifact:verify"]) {
    const result = await replay(t, release.split("      - id: digests")[0], "push", failure);
    assert.equal(result.failed, true, failure);
    assert.equal(result.trace.some((command) => command.startsWith("gh release create ")), false);
  }
  const success = await replay(t, release.split("      - id: digests")[0], "push");
  assert.equal(success.failed, false);
  const publish = success.trace.length;
  assert.match(release, /publish:\n    needs: build/);
  for (const command of ["npm test", "npm run build", "npm run artifact:verify"]) {
    assert.ok(success.trace.indexOf(command) >= 0 && success.trace.indexOf(command) < publish);
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

test("every external action is immutable, and checkout never persists credentials", async () => {
  for (const file of ["ci.yml", "e2e.yml", "release.yml"]) {
    const workflow = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    for (const ref of workflow.matchAll(/uses: ([^\s#]+)/g)) assert.match(ref[1], /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
    for (const step of workflow.split(/^      - /m).slice(1).filter(s => s.includes("actions/checkout@"))) assert.match(step, /persist-credentials: false/);
  }
});

test('publisher handoff rejects tampering, missing digests, fork identity and symlinks; malicious ref stays inert', async t => {
  const verify = release.match(/      - name: Verify handoff[\s\S]*?        run: \|\n([\s\S]*?)      - name: Publish/)[1].replace(/^          /gm, '');
  const publish = commands(release, 'push').find(command => command.includes('gh release create'));
  assert.ok(publish.includes('gh release create'));
  const directory=await mkdtemp(join(tmpdir(),'release-handoff-'));
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

test('action pins agree with authenticated canonical release evidence',async()=>{
  const pins=JSON.parse(await readFile(new URL('../.github/action-pins.json',import.meta.url)));
  const runtimes={
    'actions/checkout':'node24',
    'actions/setup-node':'node24',
    'actions/upload-artifact':'node24',
    'actions/download-artifact':'node24',
    'actions/setup-python':'node20',
  };
  const check=(action,sha,pin=pins.actions[action])=>{
    assert.ok(Object.hasOwn(runtimes,action),`unverified action: ${action}`);
    assert.equal(pin.sha,sha); assert.equal(pin.canonical_tag_sha,sha);
    assert.match(pin.tag,/^v\d+\.\d+\.\d+$/);
    assert.equal(pin.release_url,`https://github.com/${action}/releases/tag/${pin.tag}`);
    assert.equal(pin.tag_url,`https://api.github.com/repos/${action}/git/refs/tags/${pin.tag}`);
    assert.match(pin.metadata_blob,/^[a-f0-9]{40}$/); assert.equal(pin.runtime,runtimes[action]);
  };
  // Every workflow, so a newly added one cannot keep an unverified or stale pin.
  const workflows=new URL('../.github/workflows/',import.meta.url);
  for(const file of await readdir(workflows)) {
    const workflow=await readFile(new URL(file,workflows),'utf8');
    for(const match of workflow.matchAll(/uses: ([\w-]+\/[\w-]+)@([a-f0-9]{40})/g)) check(match[1],match[2]);
  }
  for(const [action,pin] of Object.entries(pins.actions)) {
    check(action,pin.sha);
    for(const bad of [{runtime:pin.runtime==='node24'?'node20':'node24'},
      {canonical_tag_sha:'f'.repeat(40)},{release_url:'https://example.invalid/release'},
      {tag_url:'https://example.invalid/tag'},{metadata_blob:'invalid'}]) {
      assert.throws(()=>check(action,pin.sha,{...pin,...bad}),assert.AssertionError);
    }
  }
  assert.throws(()=>check('actions/checkout','f'.repeat(40)),/strictly equal/);
});
for (const [name, workflow] of [["CI", ci]]) {
  test(`${name}: close runs zero shell commands; invalid edited body still blocks`, async t => {
    const closed = await replay(t, workflow, "pull_request", "", { action: "closed" });
    assert.deepEqual(closed.trace, []);
    for (const action of ["edited", "ready_for_review", "synchronize", "reopened"]) {
      const bad = await replay(t, workflow, "pull_request", "", { action, body: "<!-- no description -->" });
      assert.equal(bad.failed, true);
      assert.ok(bad.trace.includes("node scripts/check-pr-description.mjs"));
      assert.equal(bad.trace.includes("npm test"), false);
      const good = await replay(t, workflow, "pull_request", "", { action });
      assert.equal(good.failed, false);
    }
  });
}
test('clearing a description after green tests fails the required test job without heavy work', async t => {
  const green = await replay(t, ci, 'pull_request');
  assert.equal(green.failed, false);
  assert.ok(green.trace.includes('npm test'));
  const edited = policy(ci, context('pull_request', 'edited'));
  assert.deepEqual(edited.runnable, ['test'], 'body validation must report under the enforced check name');
  for (const body of ['', '<!-- empty -->', '## What changed']) {
    const result = await replay(t, ci, 'pull_request', '', { action: 'edited', body });
    assert.equal(result.failed, true);
    assert.deepEqual(result.trace, ['node scripts/check-pr-description.mjs']);
  }
  const restored = await replay(t, ci, 'pull_request', '', { action: 'edited', body: 'Description restored.' });
  assert.equal(restored.failed, false);
  assert.deepEqual(restored.trace, ['node scripts/check-pr-description.mjs']);
  const withoutEdits = ci.replace('reopened, edited,', 'reopened,');
  assert.deepEqual(policy(withoutEdits, context('pull_request', 'edited')).runnable, [], 'control reproduces the unenforced edit');
});

{
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


}
