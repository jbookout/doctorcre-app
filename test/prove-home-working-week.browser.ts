import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { prove } from "../scripts/prove-home-working-week.ts";
import { workingWeekAssets } from "./fixtures/home-working-week.ts";

const exec = promisify(execFile);
const commit = "1".repeat(40);
test("working week proof passes current-source fixture and rejects near-miss labels and old releases", async () => {
  const assets = await workingWeekAssets();
  for (const mode of ["pass", "near-miss", "older", "unreachable"] as const) {
    const changed = new Map(
      [...assets].map(([path, value]) => [
        path,
        {
          ...value,
          body:
            mode === "near-miss" && path.startsWith("/js/ui-")
              ? Buffer.from(
                  value.body.toString().replace(/children:([a-zA-Z_$][\w$]*)\.label/g, 'children:"Incorrect label"'),
                )
              : value.body,
        },
      ]),
    );
    const server = await startWorkerFixture({
      assets: changed,
      routes: new Map([
        [
          "/app-release",
          {
            contentType: "application/json",
            body: JSON.stringify({
              service: "doctorcre-app",
              environment: "production",
              source_commit: mode === "older" ? "2".repeat(40) : commit,
            }),
          },
        ],
      ]),
      env: {
        APP_ENV: "fixture",
        GIT_SHA: mode === "older" ? "2".repeat(40) : commit,
        CARR: { fetch: async () => new Response("synthetic") },
      },
    });
    try {
      if (mode === "pass") {
        const result = await exec(process.execPath, [
          "scripts/prove-home-working-week.ts",
          "--origin",
          server.origin,
          "--expected-commit",
          commit,
          "--fixture",
        ]);
        assert.equal(JSON.parse(result.stdout).status, "passed");
      } else if (mode === "near-miss") {
        await assert.rejects(
          exec(process.execPath, [
            "scripts/prove-home-working-week.ts",
            "--origin",
            server.origin,
            "--expected-commit",
            commit,
            "--fixture",
          ]),
          (error) => error instanceof Error && "code" in error && error.code === 1,
        );
      } else {
        await assert.rejects(
          prove({
            origin: server.origin,
            expectedCommit: commit,
            fixture: mode !== "unreachable",
            ...(mode === "unreachable" ? { cdpUrl: "http://127.0.0.1:1" } : {}),
          }),
          (error) => error instanceof Error && "exitCode" in error && error.exitCode === 78,
        );
      }
    } finally {
      await server.close();
    }
  }
});
