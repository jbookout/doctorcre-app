import assert from "node:assert/strict";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";
import { detail } from "./fixtures/tour-day.synthetic.mjs";

test("Tour editor boots under the production Worker CSP at desktop and phone widths", async (t) => {
  const tour = structuredClone(detail);
  Object.assign(tour, {
    route_version_id: tour.routes[0].id,
    route_version_state: "accepted",
    accepted_route_version: 1,
    projection_id: "aa000000-0000-4000-8000-000000000003",
    projection_status: "approved",
    share_grants: [],
  });
  tour.routes[0].stops.forEach((stop) => {
    stop.locked_appointment = false;
  });
  Object.assign(tour.routes[0], { acceptance_digest: "sha256:" + "a".repeat(64) });
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: {
      APP_ENV: "staging",
      CARR: {
        fetch: async (request: Request) => {
          const path = new URL(request.url).pathname;
          if (path === "/api/tours/library")
            return Response.json({
              data: { tours: [{ id: tour.id, name: tour.name, status: "active" }] },
              csrf_token: "synthetic",
            });
          if (path === "/api/tours/detail") return Response.json({ data: tour, csrf_token: "synthetic" });
          if (path === "/auth/session" || path === "/api/system-work/session")
            return Response.json({ actor: { slug: "joe" }, csrf_token: "synthetic" });
          return Response.json({});
        },
      },
    },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const width of [1440, 390])
    for (const colorScheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
      try {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const response = await page.goto(`${server.origin}/tours/route-editor.html?tour=${detail.id}`);
        assert.match(response?.headers()["content-security-policy"] ?? "", /script-src 'self'/);
        assert.doesNotMatch(response?.headers()["content-security-policy"] ?? "", /unsafe-eval/);
        try {
          await page.waitForFunction(() => document.querySelector("#tour-name")?.textContent !== "Tour", undefined, {
            timeout: 5000,
          });
        } catch (error) {
          assert.deepEqual(errors, [], "Tour editor startup must not violate CSP");
          throw error;
        }
        assert.equal(await page.locator("#tour-name").textContent(), detail.name);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    }
});
