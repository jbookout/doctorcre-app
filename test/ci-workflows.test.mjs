import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { context, policy } from "./workflow-policy.mjs";

const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const release = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const e2e = await readFile(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8");
const root = fileURLToPath(new URL("../", import.meta.url));
const harnessSource = await readFile(new URL("./browser-harness.mjs", import.meta.url), "utf8");
const nodeEngines = [...harnessSource.matchAll(/export const (\w+) = browserEngine\(/g)].map(match => match[1]).sort();

// Execute the workflow's shell steps with instrumented tools. This small reader
// supports the workflows' run/if forms and refuses unfamiliar conditions.
function commands(workflow, event, action = "opened") {
  if (workflow !== release && !policy(workflow, context(event, action)).runnable.length) return [];
  return workflow.split(/^      - /m).slice(1).flatMap((step) => {
    const run = step.match(/^(?:run:|\s+run:) (.+)$/m)?.[1];
    if (!run) return [];
    const condition = step.match(/^\s*if: (.+)$/m)?.[1];
    if (condition) {
      const match = condition.match(/^github\.event_name == '(pull_request|push)'$/);
      assert.ok(match, `unhandled workflow condition: ${condition}`);
      if (match[1] !== event) return [];
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

for (const [name, workflow, suite] of [["CI", ci, "npm test"], ["e2e", e2e, "node scripts/browser-product-proof.mjs"]]) {
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
    const testCommands = name === "CI" ? ["npm test"] : ["node --test test/e2e-suite.test.mjs", suite];
    assert.deepEqual(healthy.trace.filter(command => command === suite || command === "npm test" || command.startsWith("node --test ") || command.startsWith("npx e2e run ")), testCommands,
      "healthy heads retain the complete test command inventory");
    const push = await replay(t, workflow, "push", "npm run privacy:check");
    assert.equal(push.failed, true);
    assert.equal(push.trace.includes("node scripts/check-pr-description.mjs"), false);
    assert.equal(push.trace.some(command => command.startsWith("npx playwright install")), false);
  });

  test(`${name}: missing or cancelled required tests cannot pass`, async (t) => {
    assert.match(workflow, new RegExp(`^  ${name === "CI" ? "test" : "journeys"}:\\n(?:    if:.*\\n)?    runs-on:`, "m"));
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

test("installed engines match the actual Node and e2e selections and lockfile pin", async () => {
  const config = await readFile(new URL("../e2e.config.ts", import.meta.url), "utf8");
  const journeyEngines = [...new Set([...config.matchAll(/browser: ['"](\w+)['"]/g)].map(match => match[1]))].sort();
  assert.ok(nodeEngines.length && journeyEngines.length, "engine selections must be readable");
  for (const [workflow, engines] of [[ci, nodeEngines], [release, nodeEngines], [e2e, journeyEngines]]) {
    assert.deepEqual(installedEngines(workflow), engines);
  }
  assert.throws(() => assert.deepEqual(installedEngines(ci.replace("chromium webkit", "chromium")), nodeEngines),
    /deep-equal/, "missing-WebKit replay must fail the same parity oracle");
  assert.throws(() => assert.deepEqual(installedEngines(e2e), [...journeyEngines, "webkit"].sort()),
    /deep-equal/, "a newly selected e2e engine needs installation too");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url)));
  assert.match(pkg.devDependencies.playwright, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.packages["node_modules/playwright"].version, pkg.devDependencies.playwright);
  assert.equal(lock.packages["node_modules/playwright-core"].version, pkg.devDependencies.playwright);
  for (const workflow of [ci, release, e2e]) {
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
  // job deadline cancelled it before build/verify. Leave room for both those
  // steps and runner variation while keeping a finite bound on hung jobs.
  const suiteMs = 543_606;
  const setupMs = 120_000;
  const artifactMs = 60_000;
  const requiredMs = (setupMs + suiteMs + artifactMs) * 1.25;
  for (const [name, workflow] of [["CI", ci], ["release", release]]) {
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
  const publish = commands(release.split('      - name: Publish')[1] ? '      - name: Publish'+release.split('      - name: Publish')[1] : '', 'push')[0];
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
  const check=(action,sha)=>{
    const pin=pins.actions[action];
    assert.equal(pin.sha,sha); assert.equal(pin.canonical_tag_sha,sha);
    assert.equal(pin.release_url,`https://github.com/${action}/releases/tag/${pin.tag}`);
    assert.match(pin.metadata_blob,/^[a-f0-9]{40}$/); assert.equal(pin.runtime,'node20');
  };
  for(const workflow of [ci,e2e,release]) for(const match of workflow.matchAll(/uses: ([\w-]+\/[\w-]+)@([a-f0-9]{40})/g)) check(match[1],match[2]);
  assert.throws(()=>check('actions/checkout','f'.repeat(40)),/strictly equal/);
});
for (const [name, workflow] of [["CI", ci], ["e2e", e2e]]) {
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
