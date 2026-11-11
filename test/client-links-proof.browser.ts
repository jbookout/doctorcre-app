import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { buildArtifact } from "../scripts/artifact.mjs";
import { CHROMIUM_SAFETY_ARGS } from "../scripts/chromium-safety-args.mjs";
import { startFixture } from "../scripts/fixture-http.mjs";
import { parseEvidence, prove } from "../scripts/prove-client-links.ts";

const commit = "1".repeat(40);
const recorded = JSON.parse(await readFile(new URL("./fixtures/client-links/producer.json", import.meta.url), "utf8"));
const pdf = Buffer.from("%PDF-1.4 synthetic reviewed packet");
const row = {
  propertyRef: "property:public:synthetic_property_01",
  label: "Stop A",
  name: "Synthetic clinic",
  detail: "6 Medical Drive",
};

const outDir = temporaryDirectory("client-links-proof-");
after(() => rm(outDir, { recursive: true, force: true }));
await buildArtifact({ root: new URL("../", import.meta.url).pathname, outDir, commit });

async function fixture(t: test.TestContext, nearMiss = false, badSummary = false) {
  const html = await readFile(outDir + "/site/reports/share.html", "utf8");
  const share = await readFile(outDir + "/site/reports/share.js", "utf8");
  const css = await readFile(outDir + "/site/reports/share.css", "utf8");
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
      ["/share.css", { contentType: "text/css", body: css }],
      ["/share.js", { contentType: "text/javascript", body: share }],
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
      const { args = [], ...launchOptions } = options || {};
      const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS, ...args], ...launchOptions });
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
            return route.fulfill({
              status: token.startsWith("r") ? 403 : 200,
              json: token.startsWith("r") ? recorded.responses.exchangeRefused : recorded.responses.exchange,
            });
          }
          if (path === "/api/share/download")
            return route.fulfill(
              token.startsWith("a") ? { contentType: "application/pdf", body: pdf } : { status: 403, body: "" },
            );
          if (path === "/api/share/report")
            return route.fulfill({
              json: {
                data: badSummary
                  ? {
                      ...recorded.responses.packet,
                      presentation: {
                        ...recorded.responses.packet.presentation,
                        summary: "2 properties in tour order.",
                      },
                    }
                  : nearMiss
                    ? recorded.responses.nearMiss
                    : recorded.responses.packet,
              },
            });
          if (path === "/api/share/map") return route.fulfill({ status: 404, json: recorded.responses.mapUnavailable });
          return route.fulfill({
            json: {
              data: token.startsWith("a") ? recorded.responses.active : recorded.responses.viewOnly,
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

test("client download controls follow projected capability before open and after refusal in every layout", async (t) => {
  const options = await fixture(t);
  const browser = await options.engine.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    for (const width of [1440, 390])
      for (const colorScheme of ["light", "dark"] as const) {
        for (const kind of ["active", "viewOnly", "revoked"] as const) {
          const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
          try {
            const page = await context.newPage();
            await page.goto(options.evidence[kind]);
            const control = page.getByRole("button", { name: "Download PDF", exact: true });
            assert.equal(await control.count(), 0, "no action before verified permission");
            await page.getByRole("button", { name: "Open tour", exact: true }).click();
            await page.waitForFunction(() =>
              ["Report loaded.", "This shared report is unavailable."].includes(
                document.querySelector("#status")?.textContent || "",
              ),
            );
            assert.equal(
              await control.count(),
              kind === "active" && recorded.responses.active.can_download === true ? 1 : 0,
            );
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            if (process.env.CLIENT_LINKS_SCREENSHOTS) {
              await mkdir(process.env.CLIENT_LINKS_SCREENSHOTS, { recursive: true });
              await page.screenshot({
                path: `${process.env.CLIENT_LINKS_SCREENSHOTS}/${kind}-${width}-${colorScheme}.png`,
                fullPage: true,
              });
            }
          } finally {
            await context.close();
          }
        }
      }
  } finally {
    await browser.close();
  }
});

test("client proof rejects the near-miss displayed 16 Medical Drive for expected 6 Medical Drive", async (t) => {
  await assert.rejects(prove(await fixture(t, true)), (error: unknown) => {
    assert.ok(error instanceof assert.AssertionError);
    assert.deepEqual(error.actual, [{ ...row, detail: "16 Medical Drive" }]);
    assert.deepEqual(error.expected, [row]);
    return true;
  });
});

test("client proof rejects a packet summary that disagrees with its own stop count", async (t) => {
  await assert.rejects(prove(await fixture(t, false, true)), (error: unknown) => {
    assert.ok(error instanceof assert.AssertionError);
    assert.equal(error.actual, "2 properties");
    assert.equal(error.expected, "1 property");
    return true;
  });
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

for (const mode of ["pass", "near miss", "summary mismatch", "late launch", "stalled evaluation"])
  test(`client proof CLI ${mode}`, async (t) => {
    const nearMiss = mode === "near miss";
    const timeout = mode === "late launch" || mode === "stalled evaluation";
    const badSummary = mode === "summary mismatch";
    const options = await fixture(t, nearMiss, badSummary);
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
import { CHROMIUM_SAFETY_ARGS } from ${JSON.stringify(new URL("../scripts/chromium-safety-args.mjs", import.meta.url).href)};
const chromiumDriver = { launch: chromium.launch.bind(chromium) };
const recorded = ${JSON.stringify(recorded)};
const pdf = Buffer.from(${JSON.stringify(pdf.toString())});
const nearMiss = ${nearMiss};
const badSummary = ${badSummary};
const engine = { ${options.engine.launch.toString().replaceAll("chromium.launch", "chromiumDriver.launch")} };
chromium.launch = async options => {
  const browser = await engine.launch({ args: [...CHROMIUM_SAFETY_ARGS, ...(options?.args || [])], ...options });
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
    if (nearMiss || badSummary || timeout)
      await assert.rejects(execution, (error: unknown) => {
        assert.ok(error && typeof error === "object" && "code" in error && "stdout" in error);
        assert.equal(error.code, timeout ? 78 : 1, "stderr" in error ? String(error.stderr) : "no stderr");
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
