import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { buildArtifact } from "../scripts/artifact.mjs";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { type Descriptor, startFixture, startWorkerFixture } from "../scripts/fixture-http.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = "scripts/prove-reply-draft-recipient-race.ts";
let output: string, fixture: { url: string; stop(): Promise<void> };
before(async () => {
  output = await temporaryDirectory("reply-recipient-proof-");
  await buildArtifact({ root, outDir: output });
  const routes = await appAssetSnapshot(join(output, "site"));
  const server = await startWorkerFixture({ routes, env: { APP_ENV: "production", GIT_SHA: "a".repeat(40) } });
  fixture = { url: server.origin, stop: () => server.close() };
});
after(async () => {
  await fixture?.stop();
  if (output) await rm(output, { recursive: true, force: true });
});
function run(args: string[], commit = "a".repeat(40)) {
  if (args.includes("--origin")) args = [...args, "--commit", commit];
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error("CLI did not terminate"));
    }, 35000);
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
test("help and malformed CLI fail without a proof", async () => {
  assert.match((await run(["--help"])).stdout, /--origin URL --timeout-ms 30000/);
  for (const args of [
    [],
    ["--origin", "bad", "--timeout-ms", "30000"],
    ["--origin", "http://127.0.0.1/path", "--timeout-ms", "30000"],
    ["--origin", "http://127.0.0.1", "--timeout-ms", "30001"],
  ]) {
    assert.notEqual((await run(args)).code, 0);
  }
});
test("declaration command parses and proves the actual built fixture module", async () => {
  const declaration = JSON.parse(
    await readFile(new URL("../proofs/requirements/reply-draft-recipient-race.json", import.meta.url), "utf8"),
  );
  const command = declaration.assertions[0].predicate.match(
    /node (scripts\/[^ ]+) --origin (https:\/\/[^ ]+) --timeout-ms (\d+)/,
  );
  assert.ok(command);
  assert.equal(command[1], script);
  const result = await run(["--origin", fixture.url, "--timeout-ms", command[3] || ""]);
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.fixture, true);
  assert.equal(receipt.release.service, "doctorcre-app");
  assert.ok(receipt.loaded_module_urls.includes(fixture.url + "/js/ui-email-actions.generated.js"));
  assert.deepEqual(receipt.assertions, [
    "to-only edit retained",
    "cc-only edit retained",
    "matching snapshot removed",
    "actor and proposal isolated",
  ]);
  assert.ok(receipt.requests <= declaration.safety.max_requests);
});
for (const mode of [
  "missing export",
  "failed assertion",
  "missing release",
  "protected asset",
  "timeout",
  "mutation",
  "changed release",
  "request cap",
  "oversized asset",
]) {
  test(`proof refuses ${mode}`, async (t) => {
    const release = (commit: string): Descriptor => ({
      contentType: "application/json",
      body: JSON.stringify({ service: "doctorcre-app", environment: "production", source_commit: commit.repeat(40) }),
    });
    const routes = new Map<string, Descriptor | { sequence: Descriptor[] }>(
      mode === "changed release" ? await appAssetSnapshot(join(output, "site")) : [],
    );
    routes.set(
      "/app-release",
      mode === "timeout"
        ? { ...release("a"), hold: "release" }
        : mode === "missing release"
          ? { contentType: "application/json", body: "{}" }
          : mode === "changed release"
            ? { sequence: [release("a"), release("b")] }
            : release("a"),
    );
    if (mode !== "changed release") {
      const body =
        mode === "missing export"
          ? "export const absent = true;"
          : mode === "request cap"
            ? "for (let i = 0; i < 65; i++) await fetch('/js/read.js');"
            : mode === "oversized asset"
              ? " ".repeat(1048577)
              : mode === "mutation"
                ? "await fetch('/business-write', { method: 'POST' });"
                : "export const createReplyDeviceDrafts = () => ({ save: () => true, remove() {}, restore: () => null });";
      const descriptor = { contentType: "text/javascript", body, status: mode === "protected asset" ? 401 : 200 };
      routes.set("/js/ui-email-actions.generated.js", descriptor);
      routes.set("/js/read.js", descriptor);
    }
    const server = await startFixture({ routes });
    t.after(() => server.close());
    const result = await run(["--origin", server.origin, "--timeout-ms", mode === "timeout" ? "1000" : "30000"]);
    assert.notEqual(result.code, 0, result.stdout);
    assert.equal(result.stdout, "");
    assert.ok([...server.requests, ...server.rejectedRequests].every((request) => request.method === "GET"));
    assert.match(
      result.stderr,
      mode === "missing export"
        ? /Missing createReplyDeviceDrafts/
        : mode === "failed assertion"
          ? /edit lost/
          : mode === "missing release"
            ? /Missing app release identity/
            : mode === "changed release"
              ? /Release changed/
              : /timeout|HTTP|fetch|import/i,
    );
  });
}

test("proof refuses an unproven containing release", async () => {
  const result = await run(["--origin", fixture.url, "--timeout-ms", "30000"], "b".repeat(40));
  assert.equal(result.code, 78, result.stderr);
  assert.equal(result.stdout, "");
});
