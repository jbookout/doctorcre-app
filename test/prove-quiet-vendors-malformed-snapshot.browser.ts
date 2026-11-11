import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { startFixture } from "../scripts/fixture-http.mjs";
import { uiAssets } from "../scripts/ui-bundle.mjs";

const exec = promisify(execFile);
const assets = await uiAssets((path) => readFile(path, "utf8"));
const release = JSON.stringify({ service: "doctorcre-app", environment: "production", source_commit: "a".repeat(40) });
for (const scenario of [
  "success",
  "contradiction",
  "missing-release",
  "missing-entry",
  "missing-chunk",
  "foreign-import",
  "too-many-assets",
  "timeout",
]) {
  test(`proof CLI ${scenario} with declared flags`, { timeout: 45000 }, async (t) => {
    const routes = new Map<
      string,
      { body?: string | Uint8Array; contentType?: string; status?: number; hold?: string }
    >();
    routes.set(
      "/app-release",
      scenario === "missing-release" ? { status: 404 } : { body: release, contentType: "application/json" },
    );
    for (const [path, value] of assets) {
      if (scenario === "missing-entry" && path === "js/ui-quiet-vendors.generated.js") continue;
      if (scenario === "missing-chunk" && path.includes("ui-shared-")) continue;
      let bytes: string | Uint8Array = value;
      if (path === "js/ui-quiet-vendors.generated.js") {
        if (scenario === "contradiction")
          bytes = 'export function mountQuietVendors() { throw Error("synthetic contradiction"); }';
        if (scenario === "foreign-import") bytes = 'import "https://foreign.invalid/asset.js";';
        if (scenario === "too-many-assets")
          bytes = Array.from({ length: 20 }, (_, i) => `import "./ui-shared-A${i}.generated.js";`).join("\n");
      }
      routes.set(`/${path}`, { body: bytes, contentType: "text/javascript" });
    }
    if (scenario === "timeout") routes.set("/app-release", { hold: "release-timeout" });
    const server = await startFixture({ routes });
    t.after(() => server.close());
    const origin = server.origin;
    let result: { stdout: string; stderr: string; code?: number };
    try {
      result = await exec(
        process.execPath,
        [
          "scripts/prove-quiet-vendors-malformed-snapshot.ts",
          "--origin",
          origin,
          "--commit",
          "a".repeat(40),
          "--timeout-ms",
          "30000",
        ],
        { timeout: 40000 },
      );
    } catch (error) {
      assert.ok(error instanceof Error && "stdout" in error && "stderr" in error && "code" in error);
      assert.equal(typeof error.stdout, "string");
      assert.equal(typeof error.stderr, "string");
      assert.equal(typeof error.code, "number");
      // execFile exposes these fields on nonzero process exits.
      result = error as Error & { stdout: string; stderr: string; code: number };
    }
    const receipt = JSON.parse(result.stdout.trim());
    const expected = scenario === "success" ? 0 : scenario.startsWith("missing-") ? 78 : 1;
    assert.equal(result.code || 0, expected, result.stdout + result.stderr);
    assert.equal(receipt.exitCode, expected);
    const paths = server.requests.map((request) => request.path);
    assert.ok(paths.length <= 20);
    assert.equal(new Set(paths).size, paths.length);
    if (scenario === "success") {
      assert.equal(receipt.release.source_commit, "a".repeat(40));
      assert.ok(receipt.assertions.includes("disposed ignores late read"));
      for (const asset of receipt.assets) {
        const bytes = asset.path === "/app-release" ? release : assets.get(asset.path.slice(1));
        assert.ok(bytes);
        assert.equal(asset.sha256, createHash("sha256").update(bytes).digest("hex"));
      }
    }
  });
}
