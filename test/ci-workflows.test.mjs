import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const release = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
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
function commands(workflow, event) {
  return workflow.split(/^      - /m).slice(1).flatMap((step) => {
    const condition = step.match(/^\s*if: (.+)$/m)?.[1];
    if (condition) {
      const match = condition.match(/^github\.event_name == '(pull_request|push)'$/);
      assert.ok(match, `unhandled workflow condition: ${condition}`);
      if (match[1] !== event) return [];
    }
    const run = step.match(/^(?:run:|\s+run:) (.+)$/m)?.[1];
    if (!run) return [];
    if (run === ">-") return [step.match(/^        run: >-\n((?:          .+\n?)+)/m)[1].trim().replace(/\n\s*/g, " ")];
    assert.notEqual(run, "|", "literal shell blocks need an explicit reader update");
    return [run];
  });
}

async function replay(t, workflow, event, failCommand = "") {
  const directory = await mkdtemp(join(tmpdir(), "doctorcre-workflow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trace = join(directory, "trace");
  for (const tool of ["npm", "node", "gh"]) {
    const path = join(directory, tool);
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${tool}'\" $*\" >> \"$TRACE\"\n[ '${tool}'\" $*\" != \"$FAIL_COMMAND\" ]\n`);
    await chmod(path, 0o755);
  }
  let failed = false;
  for (const command of commands(workflow, event)) {
    try {
      execFileSync("bash", ["-e", "-c", command], { env: {
        ...process.env, PATH: `${directory}:${process.env.PATH}`, TRACE: trace,
        FAIL_COMMAND: failCommand, GITHUB_REF_NAME: "app-v-fixture", GITHUB_SHA: "1".repeat(40),
      }, stdio: "pipe" });
    } catch {
      failed = true;
      break;
    }
  }
  return { failed, trace: (await readFile(trace, "utf8")).trim().split("\n") };
}

test("PRs retain the unconditional required test job and full suite", async (t) => {
  assert.match(ci, /^  pull_request:\s*$/m);
  assert.match(ci, /^  test:\n    runs-on:/m);
  assert.doesNotMatch(ci, /^\s+(?:paths|paths-ignore|branches-ignore):/m);
  const result = await replay(t, ci, "pull_request", "npm test");
  assert.equal(result.failed, true);
  assert.ok(result.trace.includes("npm test"));
  assert.equal(result.trace.includes("npm run build"), false, "failed tests cannot yield a green job");
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
