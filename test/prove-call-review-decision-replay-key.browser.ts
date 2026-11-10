import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import test from "node:test";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { checkResolverFixture, resolverFixture } from "../scripts/prove-call-review-decision-replay-key.ts";
import { uiAssets } from "../scripts/ui-bundle.mjs";

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
  const root = resolve(".");
  const assets = await uiAssets((path) => {
    const file = resolve(root, path);
    if (!file.startsWith(root + sep)) throw new Error("Outside fixture root");
    return readFile(file, "utf8");
  });
  for (const dir of ["js"])
    for (const name of await readdir(resolve(root, dir))) {
      if (/\.(js|mjs)$/.test(name) && !assets.has(dir + "/" + name))
        assets.set(dir + "/" + name, await readFile(resolve(root, dir, name)));
    }
  const release = { service: "doctorcre-app", environment: "production", source_commit: "a".repeat(40) };
  async function run(mode: string, timeout = 30000, commit = release.source_commit) {
    const selected = new Map(assets);
    if (mode === "adapter-hash")
      selected.set("js/live-client.js", Buffer.from("export function createLiveClient() {}"));
    if (mode === "assertion")
      selected.set(
        "js/ui-call.js",
        Buffer.from("export function mountCallReview() { return { refresh: async () => {}, dispose() {} }; }"),
      );
    const routes = new Map<
      string,
      { body: string | Uint8Array; contentType: string; status?: number; hold?: string }
    >();
    for (const [path, bytes] of selected)
      routes.set("/" + path, {
        body: mode === "hash" ? "wrong asset" : bytes,
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
      assert.ok(server.requests.length <= 10);
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
  }
  assert.ok(receipt.assets["/js/ui-call.js"]);
  for (const [failure, code] of [
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
