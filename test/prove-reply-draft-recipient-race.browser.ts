import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join, resolve, sep } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { buildArtifact } from "../scripts/artifact.mjs";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
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
  assert.ok(receipt.loaded_module_urls.includes(fixture.url + "/js/ui-email-actions.js"));
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
    let releaseReads = 0,
      mutations = 0;
    const server = createServer(async (req, res) => {
      if (req.method !== "GET") mutations++;
      if (mode === "timeout") return;
      if (req.url === "/app-release") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            mode === "missing release"
              ? {}
              : {
                  service: "doctorcre-app",
                  environment: "production",
                  source_commit: (mode === "changed release" && releaseReads++ ? "b" : "a").repeat(40),
                },
          ),
        );
      } else {
        res.setHeader("content-type", "text/javascript");
        if (mode === "protected asset") {
          res.statusCode = 401;
          res.end("Sign in");
        } else if (mode === "missing export") res.end("export const absent = true;");
        else if (mode === "request cap") res.end("for (let i = 0; i < 65; i++) await fetch('/js/read.js');");
        else if (mode === "oversized asset") res.end(" ".repeat(1048577));
        else if (mode === "mutation") res.end("await fetch('/business-write', { method: 'POST' });");
        else if (mode === "changed release") {
          const root = resolve(output, "site");
          let path: string;
          try {
            path = resolve(root, "." + decodeURIComponent((req.url || "/").split("?")[0] || "/").replaceAll("\\", "/"));
          } catch {
            res.statusCode = 403;
            return res.end();
          }
          if (!path.startsWith(root + sep)) {
            res.statusCode = 403;
            return res.end();
          }
          res.end(await readFile(path));
        } else
          res.end(
            "export const createReplyDeviceDrafts = () => ({ save: () => true, remove() {}, restore: () => null });",
          );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    });
    if (mode === "changed release") {
      await writeFile(join(output, "artifact.json"), "{}");
      await writeFile(join(output, "site", "artifact.json"), "{}");
      for (const path of ["/../artifact.json", "/%2e%2e%2fartifact.json", "/%2e%2e%5cartifact.json"]) {
        const status = await new Promise((resolve, reject) => {
          const req = request({ host: "127.0.0.1", port: port(server), path }, (res) => {
            res.resume();
            resolve(res.statusCode);
          });
          req.on("error", reject);
          req.end();
        });
        assert.equal(status, 403, `Fixture must refuse ${path}`);
      }
    }
    const result = await run([
      "--origin",
      `http://127.0.0.1:${port(server)}`,
      "--timeout-ms",
      mode === "timeout" ? "1000" : "30000",
    ]);
    assert.notEqual(result.code, 0, result.stdout);
    assert.equal(result.stdout, "");
    assert.equal(mutations, 0);
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

function port(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}
