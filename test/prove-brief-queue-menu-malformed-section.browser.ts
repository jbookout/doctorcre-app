import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { startFixture } from "../scripts/fixture-http.mjs";
import { uiAssets } from "../scripts/ui-bundle.mjs";

const assets = await uiAssets((path) => readFile(new URL(`../${path}`, import.meta.url), "utf8"));
const runner = new URL("../scripts/prove-brief-queue-menu-malformed-section.ts", import.meta.url);
type Report = {
  release: { source_commit: string };
  assertions: { id: string; passed: boolean }[];
  assets: { url: string; sha256: string }[];
};
function cli(origin: string, timeout = "30000") {
  return new Promise<{ code: number | null; report: Report; error: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      runner.pathname,
      "--origin",
      origin,
      "--timeout-ms",
      timeout,
      "--commit",
      "a".repeat(40),
    ]);
    let output = "",
      error = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      error += data;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve({ code, report: JSON.parse(output), error });
      } catch {
        reject(new Error(output + error));
      }
    });
  });
}

test("proof CLI uses declared flags, fetched bytes, bounded failures and timeout", async (t) => {
  for (const [scenario, expected] of [
    ["valid", 0],
    ["unrelated-release", 78],
    ["failed", 1],
    ["missing", 78],
    ["release-missing", 78],
    ["chunk-missing", 78],
    ["foreign", 78],
    ["cap", 78],
    ["timeout", 78],
  ] as const) {
    const routes: NonNullable<Parameters<typeof startFixture>[0]>["routes"] = new Map();
    routes.set("/app-release", {
      contentType: "application/json",
      body: JSON.stringify({
        service: "doctorcre-app",
        source_commit: scenario === "unrelated-release" ? "b".repeat(40) : "a".repeat(40),
        environment: "production",
      }),
      ...(scenario === "release-missing" ? { status: 404 } : {}),
      ...(scenario === "timeout" ? { hold: "deadline" } : {}),
    });
    for (const [path, body] of assets) {
      if (scenario === "missing" || (scenario === "chunk-missing" && path.includes("ui-shared-"))) continue;
      routes.set(`/${path}`, { contentType: "text/javascript", body });
    }
    if (scenario === "failed")
      routes.set("/js/ui-queue.generated.js", {
        body: "export function createBriefQueueView(){return {renderMenu(){},dispose(){}}}",
        contentType: "text/javascript",
      });
    if (scenario === "foreign")
      routes.set("/js/ui-queue.generated.js", {
        body: 'import "https://example.invalid/evil.js"',
        contentType: "text/javascript",
      });
    if (scenario === "cap")
      for (let index = 0; index < 21; index++)
        routes.set(index === 0 ? "/js/ui-queue.generated.js" : `/js/ui-shared-${index}.generated.js`, {
          body: `import './ui-shared-${index + 1}.generated.js'`,
          contentType: "text/javascript",
        });
    const server = await startFixture({ routes });
    t.after(() => server.close());
    const origin = server.origin;
    const { code, report } = await cli(origin);
    assert.equal(code, expected, JSON.stringify(report));
    const fetched = server.requests.map((request) => request.path);
    await server.close();
    assert.ok(fetched.length <= 20);
    assert.equal(new Set(fetched).size, fetched.length, "no retry");
    if (scenario === "valid") {
      assert.equal(report.release.source_commit, "a".repeat(40));
      assert.ok(report.assertions.length > 50);
      assert.ok(report.assertions.every((result) => result.passed));
      for (const counts of ["0-0", "1-3"])
        for (const assertion of ["accurate-mounted", "accurate-menu-teardown", "accurate-content-teardown"]) {
          assert.ok(report.assertions.some((result) => result.id === `${assertion}-${counts}` && result.passed));
        }
      assert.deepEqual(
        report.assets.map((asset) => new URL(asset.url).pathname),
        fetched,
      );
      assert.ok(report.assets.every((asset) => /^[0-9a-f]{64}$/.test(asset.sha256)));
      assert.ok(fetched.some((path) => /ui-shared-/.test(path)));
      for (const asset of report.assets.slice(1)) {
        const bytes = assets.get(new URL(asset.url).pathname.slice(1));
        assert.ok(bytes);
        assert.equal(asset.sha256, createHash("sha256").update(bytes).digest("hex"));
      }
    }
  }
});
