import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { chromium } from "playwright";
import { startFixture } from "../scripts/fixture-http.mjs";
import { parseEvidence, prove } from "../scripts/prove-client-links.ts";

const commit = "1".repeat(40);
const pdf = Buffer.from("%PDF-1.4 synthetic reviewed packet");
const row = {
  propertyRef: "property:public:synthetic_property_01",
  label: "A",
  name: "Synthetic clinic",
  detail: "6 years",
};

async function fixture(t: test.TestContext, nearMiss = false) {
  const bundle = await build({
    entryPoints: ["reports/share.js"],
    bundle: true,
    write: false,
    format: "esm",
    external: ["/vendor/*"],
  });
  assert.ok(bundle.outputFiles[0]);
  const html = await readFile("reports/share.html", "utf8");
  const server = await startFixture({
    routes: new Map([
      [
        "/app-release",
        {
          contentType: "application/json",
          body: JSON.stringify({ service: "doctorcre-app", environment: "production", source_commit: commit }),
        },
      ],
      ["/share", { contentType: "text/html", body: html }],
      ["/share.js", { contentType: "text/javascript", body: bundle.outputFiles[0].text }],
      [
        "/share-bootstrap.js",
        { contentType: "text/javascript", body: await readFile("reports/share-bootstrap.js", "utf8") },
      ],
      [
        "/api/share/download",
        {
          sequence: Array.from({ length: 4 }, () => [
            { contentType: "application/pdf", body: pdf },
            { status: 403, body: "" },
            { status: 403, body: "" },
          ]).flat(),
        },
      ],
    ]),
  });
  t.after(() => server.close());
  const evidence = parseEvidence(
    {
      active: `${server.origin}/share#${"a".repeat(43)}`,
      revoked: `${server.origin}/share#${"r".repeat(43)}`,
      viewOnly: `${server.origin}/share#${"v".repeat(43)}`,
      rows: [row],
      pdfSha256: createHash("sha256").update(pdf).digest("hex"),
    },
    server.origin,
  );
  const engine = {
    async launch(options: Parameters<typeof chromium.launch>[0]) {
      const browser = await chromium.launch(options);
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (options) => {
        const context = await newContext(options);
        let token = "";
        await context.route("**/api/share/**", async (route) => {
          const path = new URL(route.request().url()).pathname;
          if (path === "/api/share/exchange") {
            const input: unknown = route.request().postDataJSON();
            assert.ok(input && typeof input === "object" && "token" in input && typeof input.token === "string");
            token = input.token;
            return route.fulfill({ status: token.startsWith("r") ? 403 : 200, json: { data: {} } });
          }
          if (path === "/api/share/download")
            return route.fulfill(
              token.startsWith("a") ? { contentType: "application/pdf", body: pdf } : { status: 403, body: "" },
            );
          if (path === "/api/share/report")
            return route.fulfill({
              json: {
                data: {
                  stops: [
                    {
                      property_ref: row.propertyRef,
                      route_label: row.label,
                      name: row.name,
                      summary: nearMiss ? "16 years" : row.detail,
                    },
                  ],
                },
              },
            });
          if (path === "/api/share/map") return route.fulfill({ status: 404, json: { error: "not_found" } });
          return route.fulfill({
            json: {
              data: {
                projection_ref: "projection:public:synthetic_projection_01",
                permission_scopes: ["view", ...(token.startsWith("a") ? ["download"] : [])],
                items: [],
              },
            },
          });
        });
        return context;
      };
      return browser;
    },
  };
  return { origin: server.origin, commit, evidence, engine, timeoutMs: 30000 };
}

test("client proof opens real report and enforces revoked and download scopes in all layouts", async (t) => {
  assert.equal((await prove(await fixture(t))).status, "passed");
});

test("client proof rejects the near-miss displayed 16 years for expected 6 years", async (t) => {
  await assert.rejects(prove(await fixture(t, true)), assert.AssertionError);
});

test("client proof classifies unavailable browser as insufficient evidence", async (t) => {
  const options = await fixture(t);
  await assert.rejects(
    prove({
      ...options,
      engine: {
        async launch() {
          throw Error("unreachable");
        },
      },
    }),
    { exitCode: 78 },
  );
});

for (const mode of ["pass", "near miss", "late launch", "stalled evaluation"])
  test(`client proof CLI ${mode}`, async (t) => {
    const nearMiss = mode === "near miss";
    const timeout = mode === "late launch" || mode === "stalled evaluation";
    const options = await fixture(t, nearMiss);
    const root = temporaryDirectory("client-proof-cli-", t);
    const evidenceFile = `${root}/evidence.json`;
    const preload = `${root}/browser.mjs`;
    const diagnostics = `${root}/processes.json`;
    await writeFile(evidenceFile, JSON.stringify(options.evidence));
    await writeFile(
      preload,
      `import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { ownedBrowserProcesses } from ${JSON.stringify(new URL("./proof-browser-harness.mjs", import.meta.url).href)};
import { chromium } from ${JSON.stringify(import.meta.resolve("playwright"))};
const driver = { launch: chromium.launch.bind(chromium) };
const row = ${JSON.stringify(row)};
const pdf = Buffer.from(${JSON.stringify(pdf.toString())});
const nearMiss = ${nearMiss};
const engine = { ${options.engine.launch.toString().replace("chromium.launch(options)", "driver.launch(options)")} };
chromium.launch = async options => {
  const browser = await engine.launch(options);
  writeFileSync(${JSON.stringify(diagnostics)}, JSON.stringify(ownedBrowserProcesses(${JSON.stringify(root)}, process.pid)));
  if (${JSON.stringify(mode)} === 'late launch') await new Promise(resolve => setTimeout(resolve, 5300));
  if (${JSON.stringify(mode)} === 'stalled evaluation') {
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await newContext(options);
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await newPage();
        page.evaluate = () => new Promise(() => {});
        return page;
      };
      return context;
    };
  }
  return browser;
};
`,
    );
    const execution = promisify(execFile)(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        "scripts/prove-client-links.ts",
        "--origin",
        options.origin,
        "--commit",
        commit,
        "--evidence-file",
        evidenceFile,
        "--timeout-ms",
        timeout ? "5000" : "30000",
      ],
      { timeout: 40000 },
    );
    if (nearMiss || timeout)
      await assert.rejects(execution, (error: unknown) => {
        assert.ok(error && typeof error === "object" && "code" in error && "stdout" in error);
        assert.equal(error.code, timeout ? 78 : 1);
        assert.equal(JSON.parse(String(error.stdout)).status, timeout ? "insufficient_evidence" : "failed");
        return true;
      });
    else assert.equal(JSON.parse((await execution).stdout).status, "passed");
    const pids: unknown = JSON.parse(await readFile(diagnostics, "utf8"));
    assert.ok(Array.isArray(pids) && pids.length > 1);
    const survivors = pids.filter((pid: unknown) => {
      assert.equal(typeof pid, "number");
      if (typeof pid !== "number") return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    assert.deepEqual(survivors, [], "zero surviving owned browser processes");
    t.diagnostic(JSON.stringify({ mode, survivors }));
  });

import { temporaryDirectory } from "../scripts/temp-directory.mjs";

test("client proof gates equal descendant older unrelated and unknown releases before browser work", async (t) => {
  const cwd = temporaryDirectory("client-proof-git-", t);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.test");
  git("commit", "--allow-empty", "-qm", "older");
  const older = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "merge");
  const commit = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "descendant");
  const descendant = git("rev-parse", "HEAD");
  git("checkout", "--orphan", "unrelated");
  git("commit", "--allow-empty", "-qm", "unrelated");
  const unrelated = git("rev-parse", "HEAD");
  for (const observed of [commit, descendant, older, unrelated, "a".repeat(40)]) {
    const server = await startFixture({
      routes: new Map([
        [
          "/app-release",
          {
            contentType: "application/json",
            body: JSON.stringify({ service: "doctorcre-app", environment: "production", source_commit: observed }),
          },
        ],
      ]),
    });
    try {
      await assert.rejects(prove({ origin: server.origin, commit, cwd, timeoutMs: 3000 }), (error: unknown) => {
        assert.ok(error instanceof Error && "exitCode" in error);
        assert.equal(error.exitCode, 78);
        assert.equal(
          error.message,
          [commit, descendant].includes(observed)
            ? "Client link evidence required"
            : "Containing release evidence unavailable",
        );
        return true;
      });
    } finally {
      await server.close();
    }
  }
});
