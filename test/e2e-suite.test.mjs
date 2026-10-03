import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const list = async (path) => (await readdir(new URL(path, root))).filter((name) => name.endsWith(".e2e.ts")).sort();

// The merged V1 journeys the deterministic e2e suite must cover, one file each.
const JOURNEYS = ["w01-shell", "w02-home-attention", "w04-local-deals", "w05-vendors", "w06-tours-drafts",
  "w09-deal-timeline", "w14-relationships", "w15-invoices"];

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
