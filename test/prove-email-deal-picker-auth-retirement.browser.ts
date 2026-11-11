import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { uiAssets } from "../scripts/ui-bundle.mjs";

let assets: Map<string, Buffer>;
before(async () => {
  assets = await uiAssets((path) => readFile(path, "utf8"));
});
const servers: Awaited<ReturnType<typeof startWorkerFixture>>[] = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});
async function fixture(mode: string, sourceCommit = "a".repeat(40)) {
  const release = { service: "doctorcre-app", environment: "production", source_commit: sourceCommit };
  const manifest = {
    schema: "doctorcre-static-artifact.v1",
    source_commit: release.source_commit,
    files: [...assets].map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  const routes = new Map<string, { body: string | Buffer; contentType: string; status?: number; hold?: string }>();
  routes.set("/app-release", {
    body: JSON.stringify(release),
    contentType: "application/json",
    ...(mode === "timeout" ? { hold: "deadline" } : {}),
  });
  routes.set("/artifact-manifest.json", {
    body: mode === "malformed" ? "{}" : JSON.stringify(manifest),
    contentType: "application/json",
  });
  for (const [path, bytes] of assets)
    routes.set(`/${path}`, {
      body: mode === "wrong-asset" ? "wrong" : bytes,
      contentType: "text/javascript",
      ...(mode === "unavailable" ? { status: 404 } : {}),
    });
  const server = await startWorkerFixture({ routes });
  servers.push(server);
  return { origin: server.origin, calls: () => server.requests.length };
}

function cli(origin: string, timeout = 30000, commit = "a".repeat(40), cwd = process.cwd()) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/prove-email-deal-picker-auth-retirement.ts", import.meta.url)),
        "--origin",
        origin,
        "--commit",
        commit,
        "--timeout-ms",
        String(timeout),
      ],
      { cwd },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
    });
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
test("exact CLI executes manifest-bound fixture module", async () => {
  const f = await fixture("valid");
  const result = await cli(f.origin);
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.release.source_commit, "a".repeat(40));
  assert.ok(receipt.assertions.includes('board denial {"status":401}'));
  for (const error of [{ status: 401 }, { status: 403 }, { code: "session_changed" }]) {
    assert.ok(receipt.assertions.includes(`canceled board denial retires replacement ${JSON.stringify(error)}`));
  }
  assert.ok(receipt.assets.every((asset: { sha256: string }) => /^[a-f0-9]{64}$/.test(asset.sha256)));
  assert.ok(f.calls() <= 10);
});
for (const [mode, code] of [
  ["malformed", 1],
  ["wrong-asset", 1],
  ["unavailable", 78],
  ["timeout", 78],
])
  test(`CLI rejects ${mode}`, async () => {
    assert.equal(typeof mode, "string");
    if (typeof mode !== "string") throw Error("mode");
    const f = await fixture(mode);
    const result = await cli(f.origin, mode === "timeout" ? 50 : 30000);
    assert.equal(result.code, code, result.stderr);
    assert.ok(f.calls() <= 10);
  });
test("CLI rejects deployed module with failed behavioral assertions", async () => {
  const original = assets;
  const bad = Buffer.from(
    'export const actionModel=()=>({state:{kind:"idle"}}); export function mountEmailActions(){throw Error("Broken deployed mount")}',
  );
  assets = new Map([["js/ui-email-actions.generated.js", bad]]);
  const f = await fixture("valid");
  const result = await cli(f.origin);
  assets = original;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Broken deployed mount/);
});

for (const mode of ["late launch", "stalled evaluation"])
  test(`proof deadline cleans up ${mode}`, async (t) => {
    const { assertProofDeadlineCleanup } = await import("./proof-browser-harness.mjs");
    const f = await fixture("valid");
    await assertProofDeadlineCleanup(t, {
      entry: "scripts/prove-email-deal-picker-auth-retirement.ts",
      args: ["--origin", f.origin, "--commit", "a".repeat(40)],
      mode,
    });
  });

test("CLI requires the equal or containing release and refuses older unrelated and unknown revisions", async (t) => {
  const cwd = temporaryDirectory("email-retirement-ancestry-", t);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.test");
  git("commit", "--allow-empty", "-qm", "older");
  const older = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "merge");
  const merge = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "descendant");
  const descendant = git("rev-parse", "HEAD");
  git("checkout", "--orphan", "unrelated");
  git("commit", "--allow-empty", "-qm", "unrelated");
  const unrelated = git("rev-parse", "HEAD");
  for (const [observed, expected] of [
    [merge, 0],
    [descendant, 0],
    [older, 78],
    [unrelated, 78],
    ["a".repeat(40), 78],
  ] satisfies [string, number][]) {
    const f = await fixture("valid", observed);
    const result = await cli(f.origin, 30000, merge, cwd);
    assert.equal(result.code, expected, result.stderr);
  }
});
