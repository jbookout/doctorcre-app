import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildArtifact } from "../scripts/artifact.mjs";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startFixture, startWorkerFixture } from "../scripts/fixture-http.mjs";
import { parseArgs, prove } from "../scripts/prove-deal-tours-revoked-controls.ts";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";

const runner = "scripts/prove-deal-tours-revoked-controls.ts";
const runnerPath = fileURLToPath(new URL(`../${runner}`, import.meta.url));
function cli(args: string[], cwd?: string) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, [runnerPath, ...args], { cwd });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    child.on("close", (code) => resolve({ code, output }));
  });
}
test("proof CLI documents and rejects invalid arguments", async () => {
  assert.equal((await cli(["--help"])).code, 0);
  for (const args of [
    [],
    ["--origin", "file:///tmp"],
    ["--origin", "https://example.com/path"],
    ["--origin", "http://localhost", "--timeout-ms", "0"],
    ["--wat"],
  ])
    assert.equal((await cli(args)).code, 1);
});
test("proof CLI fails closed for unavailable identity, missing export and failed UI assertions", async (t) => {
  for (const [mode, expected] of [
    ["release", /Proof HTTP unavailable/],
    ["export", /Missing mountDealTours export/],
    ["assertion", /fixture assertion failure/],
    ["timeout", /Proof deadline exceeded/],
  ] as const) {
    const server = await startFixture({
      routes: new Map([
        [
          "/app-release",
          {
            status: mode === "release" ? 503 : 200,
            contentType: "application/json",
            body: JSON.stringify({
              service: "doctorcre-app",
              environment: "production",
              source_commit: "1".repeat(40),
            }),
          },
        ],
        [
          "/js/ui-deal-tours.js",
          {
            contentType: "text/javascript",
            body:
              mode === "export"
                ? "export {}"
                : mode === "timeout"
                  ? "await new Promise(() => {}); export function mountDealTours() {}"
                  : 'export function mountDealTours() { throw Error("fixture assertion failure"); }',
          },
        ],
      ]),
    });
    t.after(() => server.close());
    const result = await cli([
      "--origin",
      server.origin,
      "--expected-commit",
      "1".repeat(40),
      "--timeout-ms",
      mode === "timeout" ? "3000" : "30000",
    ]);
    assert.equal(result.code, mode === "release" || mode === "timeout" ? 78 : 1);
    if (mode === "timeout") assert.ok(server.requests.some((request) => request.path === "/js/ui-deal-tours.js"));
    assert.match(result.output, expected);
  }
});
test("proof command imports served artifact, refuses retired re-entry and permits fresh verified mount", async (t) => {
  const artifact = await temporaryDirectory("revoked-controls-", t);
  await buildArtifact({
    root: fileURLToPath(new URL("../", import.meta.url)),
    outDir: artifact,
    commit: "1".repeat(40),
  });
  const server = await startWorkerFixture({
    routes: await appAssetSnapshot(`${artifact}/site`),
    env: { APP_ENV: "production", GIT_SHA: "1".repeat(40) },
  });
  t.after(() => server.close());
  const screenshotDir = fileURLToPath(new URL("../out/test-artifacts/revoked-controls", import.meta.url));
  await mkdir(screenshotDir, { recursive: true });
  const receipt = await prove({
    origin: server.origin,
    expectedCommit: "1".repeat(40),
    timeoutMs: 30000,
    screenshotDir,
  });
  await writeFile(`${screenshotDir}/receipt.json`, JSON.stringify(receipt, null, 2));
  assert.equal(receipt.assertions.length, 4);
  assert.ok(receipt.loadedModuleUrls.includes(`${server.origin}/js/ui-deal-tours.js`));
  const declaration = JSON.parse(
    await readFile(new URL("../proofs/requirements/deal-tours-revoked-controls.json", import.meta.url), "utf8"),
  );
  assert.equal(
    declaration.assertions[0].predicate.match(/`([^`]+)`/)[1],
    `node ${runner} --origin https://app.doctorcre.com --expected-commit <merge-sha> --timeout-ms 30000`,
  );
  const result = await cli(["--origin", server.origin, "--expected-commit", "1".repeat(40), "--timeout-ms", "30000"]);
  assert.equal(result.code, 0, result.output);
  assert.equal(JSON.parse(result.output).origin, server.origin);
  assert.equal(
    (await cli(["--origin", server.origin, "--expected-commit", "1".repeat(40), "--timeout-ms", "1"])).code,
    78,
  );
  for (const expected of [
    [],
    ["--expected-commit", ""],
    ["--expected-commit", "bad"],
    ["--expected-commit", "0".repeat(40)],
  ]) {
    const refused = await cli(["--origin", server.origin, ...expected]);
    assert.equal(refused.code, 78, refused.output);
    assert.match(refused.output, /Expected merge commit required/);
  }
  assert.deepEqual(parseArgs(["--origin", server.origin]), {
    origin: server.origin,
    timeoutMs: 30000,
    expectedCommit: undefined,
  });
});

test("proof CLI requires equal or descendant release ancestry", async (t) => {
  const repository = await temporaryDirectory("tour-proof-ancestry-", t);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  const commit = (label: string) => {
    git("commit", "--allow-empty", "-qm", label);
    return git("rev-parse", "HEAD");
  };
  const older = commit("older");
  const expectedCommit = commit("expected merge");
  const descendant = commit("descendant");
  git("checkout", "--orphan", "unrelated");
  const unrelated = commit("unrelated");
  const routes = await appAssetSnapshot();
  for (const [name, observed, code] of [
    ["equal", expectedCommit, 0],
    ["descendant", descendant, 0],
    ["older", older, 78],
    ["unrelated", unrelated, 78],
    ["unknown", "f".repeat(40), 78],
  ] as const) {
    await t.test(name, async () => {
      const server = await startWorkerFixture({ routes, env: { APP_ENV: "production", GIT_SHA: observed } });
      try {
        const result = await cli(
          ["--origin", server.origin, "--expected-commit", expectedCommit, "--timeout-ms", "30000"],
          repository,
        );
        assert.equal(result.code, code, result.output);
        if (code === 0) {
          const receipt = JSON.parse(result.output);
          assert.equal(receipt.release.source_commit, observed);
          assert.equal(receipt.expectedCommit, expectedCommit);
          assert.equal(receipt.assertions.length, 4);
        } else {
          assert.equal(result.output, `${name} release evidence unavailable\n`);
          assert.deepEqual(
            server.requests.map((request) => request.path),
            ["/app-release"],
          );
        }
      } finally {
        await server.close();
      }
    });
  }
});
