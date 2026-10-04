import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WAIT_MS } from "./browser-harness.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const list = async (path) => (await readdir(new URL(path, root))).filter((name) => name.endsWith(".e2e.ts")).sort();

// The merged V1 journeys the deterministic e2e suite must cover, one file each.
const JOURNEYS = ["w01-shell", "w02-home-attention", "w04-local-deals", "w05-vendors", "w06-tours-drafts",
  "w09-deal-timeline", "w14-relationships", "w15-invoices"];

test("the declared Node minimum supports the runner and is exercised in CI", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const lock = JSON.parse(await read("package-lock.json"));
  const runner = JSON.parse(await read("node_modules/e2e/package.json"));
  assert.equal(pkg.engines.node, runner.engines.node, "the app must declare the runner's Node floor");
  assert.equal(lock.packages[""].engines.node, pkg.engines.node, "the lockfile must declare the same floor");
  const minimum = pkg.engines.node.match(/^>=(\d+\.\d+\.\d+)$/)?.[1];
  assert.ok(minimum, "declare an exact minimum Node version");
  const workflow = await read(".github/workflows/e2e.yml");
  assert.equal(workflow.match(/^\s+node-version: (\S+)$/m)?.[1], minimum, "journeys must run on the declared minimum");
  assert.match(await read("README.md"), new RegExp(`Node\\.js ${minimum.replaceAll(".", "\\.")} or newer`));
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("node_modules/e2e/dist/cli/bin.js", root)), "run", "--help"], {
    cwd: fileURLToPath(root), env: { ...process.env, E2E_TELEMETRY_DISABLED: "1" }, encoding: "utf8", timeout: WAIT_MS,
  });
  assert.match(output, /Usage: e2e run/, "the runner must reach test discovery options on this runtime");
});

test("e2e is pinned exactly and starts the fixture app itself", async () => {
  const pkg = JSON.parse(await read("package.json"));
  for (const name of ["e2e", "@e2e-dev/web"]) assert.match(pkg.devDependencies[name] ?? "", /^\d+\.\d+\.\d+$/, `${name} must be pinned exactly`);
  const config = await read("e2e.config.ts");
  assert.match(config, /executable: 'npm', args: \['run', 'serve'\]/, "the runner starts the fixture server");
  assert.match(config, /PORT: '\{port\}'/, "the runner picks a free port");
  assert.match(config, /E2E_TELEMETRY_DISABLED/, "the config turns telemetry off");
});

test("the deterministic suite covers every merged V1 journey without a model", async () => {
  assert.deepEqual(await list("tests/journeys/"), JOURNEYS.map((name) => `${name}.e2e.ts`));
  for (const name of JOURNEYS) {
    const source = await read(`tests/journeys/${name}.e2e.ts`);
    assert.doesNotMatch(source, /\bagent\b/, `${name} must not call a model`);
  }
  assert.equal((await list("tests/agent/")).length, 3, "three journeys keep a local agent variant");
});

test("CI runs only the deterministic suite, with no model and no telemetry", async () => {
  const workflow = await read(".github/workflows/e2e.yml");
  assert.match(workflow, /^\s+- run: npx e2e run tests\/journeys\b/m);
  assert.match(workflow, /E2E_TELEMETRY_DISABLED: "1"/);
  assert.doesNotMatch(workflow, /tests\/agent|secrets\.|API_KEY|e2e login/);
  assert.doesNotMatch(await read(".github/workflows/ci.yml"), /e2e run/, "e2e stays out of the required test job");
});
