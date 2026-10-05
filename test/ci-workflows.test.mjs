import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { context, policy } from "./workflow-policy.mjs";

const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const release = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const e2e = await readFile(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8");
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
      const match = condition.match(/^github\.event_name == '(pull_request|push)'$/);
      assert.ok(match, `unhandled workflow condition: ${condition}`);
      if (match[1] !== event) return [];
    }
    if (run === ">-") return [step.match(/^        run: >-\n((?:          .+\n?)+)/m)[1].trim().replace(/\n\s*/g, " ")];
    assert.notEqual(run, "|", "literal shell blocks need an explicit reader update");
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
    const testCommands = name === "CI" ? ["node --test test/property-producer.test.mjs", "npm test"] : ["node --test test/e2e-suite.test.mjs", suite];
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
  assert.doesNotMatch(verification, /(?:continue-on-error|if):/);
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
    const result = await replay(t, release, "push", failure);
    assert.equal(result.failed, true, failure);
    assert.equal(result.trace.some((command) => command.startsWith("gh release create ")), false);
  }
  const success = await replay(t, release, "push");
  assert.equal(success.failed, false);
  const publish = success.trace.findIndex((command) => command.startsWith("gh release create "));
  for (const command of ["npm test", "npm run build", "npm run artifact:verify"]) {
    assert.ok(success.trace.indexOf(command) >= 0 && success.trace.indexOf(command) < publish);
  }
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
