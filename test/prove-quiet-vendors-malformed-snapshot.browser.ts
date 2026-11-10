import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { promisify } from "node:util";
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
    const requests: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url);
      if (scenario === "timeout") return;
      let bytes = request.url === "/app-release" ? release : assets.get((request.url || "").slice(1));
      if (scenario === "missing-release" && request.url === "/app-release") bytes = undefined;
      if (scenario === "missing-entry" && request.url === "/js/ui-quiet-vendors.js") bytes = undefined;
      if (scenario === "missing-chunk" && request.url?.includes("ui-shared-")) bytes = undefined;
      if (request.url === "/js/ui-quiet-vendors.js") {
        if (scenario === "contradiction")
          bytes = 'export function mountQuietVendors() { throw Error("synthetic contradiction"); }';
        if (scenario === "foreign-import") bytes = 'import "https://foreign.invalid/asset.js";';
        if (scenario === "too-many-assets")
          bytes = Array.from({ length: 20 }, (_, i) => `import "./ui-shared-A${i}.generated.js";`).join("\n");
      }
      if (!bytes) {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, { "Content-Type": request.url === "/app-release" ? "application/json" : "text/javascript" })
        .end(bytes);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    // The fixture listens on TCP, so its address has a port.
    const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
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
    assert.ok(requests.length <= 20);
    assert.equal(new Set(requests).size, requests.length);
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
