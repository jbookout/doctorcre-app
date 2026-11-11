import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";

const run = promisify(execFile);
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const cli = new URL("../scripts/prove-queued-asks-corrupt-entry-isolation.ts", import.meta.url).pathname;

const snapshot = appAssetSnapshot();
async function origin(t: TestContext, mode = "valid") {
  const assets = new Map(await snapshot);
  assets.delete("/app-release");
  const routes = new Map([
    [
      "/app-release",
      {
        contentType: "application/json",
        status: mode === "signin" ? 401 : 200,
        body: JSON.stringify({
          service: "doctorcre-app",
          environment: "production",
          source_commit: mode === "stale" ? "0".repeat(40) : revision,
        }),
      },
    ],
  ]);
  if (mode !== "valid" && mode !== "stale" && mode !== "signin")
    assets.set("/js/ui-host.generated.js", {
      contentType: "text/javascript",
      body: Buffer.from(
        mode === "missing"
          ? "export const absent=true;"
          : mode === "timeout"
            ? "export async function mountAskComposer(){await new Promise(()=>{});}"
            : 'export async function mountAskComposer(){throw Error("Wrong result");}',
      ),
    });
  if (mode === "protected") {
    assets.delete("/js/ui-host.generated.js");
    routes.set("/js/ui-host.generated.js", { contentType: "text/plain", status: 403, body: "protected" });
  }
  const server = await startWorkerFixture({ assets, routes });
  t.after(() => server.close());
  return server.origin;
}

test("proof CLI imports served modules and proves isolated composer at both widths and themes", async (t) => {
  const base = await origin(t);
  const { stdout } = await run(process.execPath, [
    cli,
    "--origin",
    base,
    "--revision",
    revision,
    "--timeout-ms",
    "30000",
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.assertions.length, 4);
  assert.ok(result.modules.includes(`${base}/js/ui-host.generated.js`));
  assert.ok(result.modules.length > 1);
  assert.equal(result.release.source_commit, revision);
});
for (const mode of ["signin", "stale", "protected", "missing", "timeout", "assertion"])
  test(`proof CLI fails closed for ${mode}`, async (t) => {
    const base = await origin(t, mode);
    await assert.rejects(
      run(process.execPath, [cli, "--origin", base, "--revision", revision, "--timeout-ms", "1500"]),
      (error) =>
        error instanceof Error &&
        "code" in error &&
        error.code === (["signin", "stale", "timeout"].includes(mode) ? 78 : 1) &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        /queued-asks proof failed/.test(error.stderr),
    );
  });
test("proof CLI rejects unknown arguments and invalid timeout", async () => {
  for (const args of [
    ["--unknown", "value"],
    ["--origin", "http://localhost", "--timeout-ms", "0"],
  ])
    await assert.rejects(
      run(process.execPath, [cli, ...args]),
      (error) => error instanceof Error && "code" in error && error.code === 1,
    );
});
test("proof CLI help describes its arguments without requiring an origin", async () => {
  const { stdout } = await run(process.execPath, [cli, "--help"]);
  for (const flag of ["--origin", "--timeout-ms", "--revision"]) assert.ok(stdout.includes(flag));
});
