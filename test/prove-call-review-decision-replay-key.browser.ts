import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { checkResolverFixture, resolverFixture } from "../scripts/prove-call-review-decision-replay-key.ts";

const script = "scripts/prove-call-review-decision-replay-key.ts";
function cli(origin: string, timeout = 30000, commit = "a".repeat(40)) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, [
      script,
      "--origin",
      origin,
      "--timeout-ms",
      String(timeout),
      "--commit",
      commit,
    ]);
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}
test("exact proof CLI executes manifest-selected bytes and rejects invalid evidence", async () => {
  const snapshot = await appAssetSnapshot();
  const assets = new Map([...snapshot].map(([path, asset]) => [path.slice(1), asset.body]));
  const release = { service: "doctorcre-app", environment: "production", source_commit: "a".repeat(40) };
  async function run(mode: string, timeout = 30000, commit = release.source_commit) {
    const selected = new Map(assets);
    if (mode === "near-miss") {
      const original = selected.get("js/ui-call.generated.js");
      assert.ok(original);
      const body = original.toString();
      assert.ok(body.includes("No longer pending"));
      selected.set(
        "js/ui-call.generated.js",
        Buffer.from(body.replaceAll("No longer pending", "Still pending. No longer pending is false")),
      );
    }
    if (mode === "assertion")
      selected.set(
        "js/ui-call.generated.js",
        Buffer.from("export function mountCallReview() { return { refresh: async () => {}, dispose() {} }; }"),
      );
    const routes = new Map<
      string,
      { body: string | Uint8Array; contentType: string; status?: number; hold?: string }
    >();
    for (const [path, bytes] of selected)
      routes.set("/" + path, {
        body: mode === "hash" || (mode === "adapter-hash" && path === "js/live-client.js") ? "wrong asset" : bytes,
        contentType: "text/javascript",
        status: mode === "missing" ? 404 : 200,
      });
    routes.set("/app-release", {
      body: JSON.stringify(mode === "release" ? {} : release),
      contentType: "application/json",
      ...(mode === "timeout" ? { hold: "deadline" } : {}),
    });
    routes.set("/artifact-manifest.json", {
      body: JSON.stringify(
        mode === "manifest"
          ? {}
          : {
              schema: "doctorcre-static-artifact.v1",
              source_commit: release.source_commit,
              files: [...selected].map(([path, bytes]) => ({
                path,
                bytes: bytes.length,
                sha256: createHash("sha256").update(bytes).digest("hex"),
              })),
            },
      ),
      contentType: "application/json",
    });
    const server = await startWorkerFixture({ routes });
    try {
      const result = await cli(server.origin, timeout, commit);
      assert.ok(server.requests.length <= 64);
      for (const request of server.requests) {
        assert.equal(request.method, "GET");
        assert.equal(request.headers["x-doctorcre-release-reader"], "1");
      }
      assert.deepEqual(server.rejectedRequests, []);
      return result;
    } finally {
      server.release("deadline");
      await server.close();
    }
  }
  const result = await run("valid");
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.release.source_commit, release.source_commit);
  assert.equal(receipt.assertions.length, 8);
  for (const resolver of ["resolve-candidate", "resolve-post-call-candidate"]) {
    assert.ok(receipt.assertions.includes(resolver + ":http-uncertainty-blocks-new-decisions"));
    assert.ok(receipt.assertions.includes(resolver + ":exact-original-decision-replay"));
    assert.ok(receipt.assertions.includes(resolver + ":authoritative-resolution"));
  }
  assert.ok(receipt.assets["/js/ui-call.generated.js"]);
  const adapter = assets.get("js/live-client.js");
  assert.ok(adapter);
  assert.equal(receipt.assets["/js/live-client.js"], createHash("sha256").update(adapter).digest("hex"));
  assert.equal(receipt.max_requests, 64);
  for (const [failure, code] of [
    ["near-miss", 1],
    ["manifest", 1],
    ["adapter-hash", 1],
    ["hash", 1],
    ["assertion", 1],
    ["missing", 78],
    ["release", 78],
    ["timeout", 78],
  ] as const) {
    const failed = await run(failure, failure === "timeout" ? 100 : 30000);
    assert.equal(failed.code, code, failure + ": " + failed.stderr);
    if (failure === "near-miss")
      assert.match(failed.stderr, /Authoritative readback resolves item: "Still pending\. No longer pending is false"/);
  }
  const wrongRelease = await run("valid", 30000, "f".repeat(40));
  assert.equal(wrongRelease.code, 78, wrongRelease.stderr);
});

test("recorded resolver receipts reject fabricated or incompatible payloads", () => {
  const id = "10000000-0000-4000-8000-000000000001";
  for (const accept of [true, false]) {
    assert.deepEqual(checkResolverFixture(resolverFixture(id, accept), id, accept), resolverFixture(id, accept));
    for (const payload of [
      { ok: true },
      {},
      { ...resolverFixture(id, accept), candidate_id: "wrong" },
      resolverFixture(id, !accept),
    ]) {
      assert.throws(() => checkResolverFixture(payload, id, accept), /Incompatible/);
    }
  }
});
