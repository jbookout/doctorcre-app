import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";

const initial = JSON.parse(readFileSync("contracts/fixtures/portal-proposals.v1.json", "utf8"));
const publication = JSON.parse(readFileSync("test/fixtures/portal/example-health.market-study.json", "utf8"));
publication.properties = [{ ...publication.properties[0], id: initial.selection.selected[0], role: "candidate" }];
const css = ["css/tokens.css", "portal/styles.css", "portal/tour-list.css"]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
test("portal HTTP save and reload preserve exact membership and notes at both widths and themes", async (t) => {
  const assets = await appAssetSnapshot();
  assets.set("/portal-http.html", {
    contentType: "text/html",
    body: Buffer.from(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`,
    ),
  });
  const server = await startWorkerFixture({ assets, env: { APP_ENV: "fixture" } });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  mkdirSync("/tmp/WR586.S5.J19-shots", { recursive: true });
  for (const width of [390, 1440])
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width, height: 950 } });
      try {
        let receipt = structuredClone(initial);
        let failure = false;
        let savedKey = "";
        const bodies: string[] = [];
        await page.route("**/portal-http.html", (route) => route.fulfill(assets.get("/portal-http.html")));
        await page.route("**/example-health/status", async (route) =>
          route.fulfill({ json: { authenticated: true, csrf: "fixture-csrf" } }),
        );
        await page.route(`**/example-health/proposals/${initial.publication_id}`, async (route) => {
          const request = route.request();
          if (request.method() === "POST") {
            assert.equal(request.headers()["x-portal-csrf"], "fixture-csrf");
            assert.equal(request.headers().origin, server.origin);
            const body = request.postDataJSON();
            assert.deepEqual(Object.keys(body).sort(), ["publication_version", "request"]);
            assert.deepEqual(Object.keys(body.request).sort(), ["idempotency_key", "notes", "selected", "version"]);
            assert.equal(body.publication_version, 1);
            bodies.push(request.postData() ?? "");
            if (savedKey !== body.request.idempotency_key)
              receipt = {
                ...receipt,
                selection: {
                  version: body.request.version + 1,
                  selected: body.request.selected,
                  notes: body.request.notes,
                },
              };
            savedKey = body.request.idempotency_key;
            if (failure) return route.fulfill({ status: 503, json: { error: "portal_unavailable" } });
          }
          return route.fulfill({ json: receipt });
        });
        await page.goto(`${server.origin}/portal-http.html#tour-list`);
        await page.evaluate(
          async ({ publication, initial, theme }) => {
            document.documentElement.dataset.theme = theme;
            const modulePath = "/js/ui-portal.generated.js";
            const { mountMarketStudy } = await import(modulePath);
            const root = document.getElementById("root");
            if (!root) throw Error("Missing fixture root");
            mountMarketStudy(root, {
              package: publication,
              proposals: {
                scope: { publication_id: initial.publication_id, publication_version: 1 },
                slug: "example-health",
                signOut: async () => {},
                clearPrivateState() {},
                returnToGate() {
                  root.replaceChildren();
                },
              },
            });
          },
          { publication, initial, theme },
        );
        await page.locator('[data-state="ready"]').waitFor();
        assert.equal(await page.getByRole("textbox").inputValue(), "Client note");
        const note = `Exact HTTP note ${width} ${theme}`;
        await page.getByRole("textbox").fill(note);
        failure = true;
        await page.getByRole("button", { name: "Save Selections", exact: true }).click();
        await page.locator('[data-state="uncertain"]').waitFor();
        failure = false;
        await page.getByRole("button", { name: "Retry same save", exact: true }).click();
        await page.locator('[data-state="ready"]').waitFor();
        assert.equal(bodies[0], bodies[1]);
        await page.getByRole("button", { name: "Reload Shared List", exact: true }).click();
        await page.locator('[data-state="ready"]').waitFor();
        assert.equal(await page.getByRole("textbox").inputValue(), note);
        assert.deepEqual(receipt.selection.selected, initial.selection.selected);
        assert.deepEqual(receipt.selection.notes, { [initial.selection.selected[0]]: note });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: `/tmp/WR586.S5.J19-shots/ready-${width}-${theme}.png`, fullPage: true });
      } finally {
        await page.close();
      }
    }
});
