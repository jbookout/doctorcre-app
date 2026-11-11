import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { buildArtifact } from "../scripts/artifact.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { chromium, fixtureServer } from "./browser-harness.mjs";
import { detail, tourId } from "./fixtures/tour-day.synthetic.mjs";

function fixtureDetail() {
  const fixture = structuredClone(detail);
  fixture.routes[0].stops.forEach((stop) => {
    stop.locked_appointment = false;
  });
  return fixture;
}

const artifactDir = await temporaryDirectory("doctorcre-print-");
before(() => buildArtifact({ root: fileURLToPath(new URL("../", import.meta.url)), outDir: artifactDir }));
after(() => rm(artifactDir, { recursive: true, force: true }));

test("regeneration preserves notes and facts; revisions survive reload and print by property", async (t) => {
  const server = await fixtureServer({ root: join(artifactDir, "site") });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  page.on("dialog", (dialog) => dialog.accept());
  page.setDefaultTimeout(5000);
  page.on("dialog", (dialog) => dialog.accept());
  const fixture = Object.assign(fixtureDetail(), {
    route_version_id: detail.routes[0].id,
    route_version_state: "accepted",
    accepted_route_version: 1,
    cheat_sheet: { revision_number: 3, content: { notes: "Keep broker preparation" } },
  });
  const writes: { content: { notes: string; generated_itinerary?: string }; expected_revision_number: number }[] = [];
  const revisions: {
    revision_id: string;
    revision_number: number;
    content: { notes: string; generated_itinerary?: string };
  }[] = [];
  fixture.routes[0].stops.forEach((stop) => {
    stop.locked_appointment = false;
  });
  fixture.route_version_id = fixture.routes[0].id;
  fixture.route_version_state = "accepted";
  fixture.accepted_route_version = 1;
  fixture.cheat_sheet = { revision_number: 3, content: { notes: "Keep broker preparation" } };
  revisions.push({ revision_id: "88888888-8888-4888-8888-888888888888", ...structuredClone(fixture.cheat_sheet) });
  let failRead = false;
  let canonical = JSON.stringify(fixture.routes);
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let data = {};
    if (request.method() === "POST") {
      assert.equal(path, "/api/tours/cheat-sheet/autosave", "no canonical property write");
      const body = request.postDataJSON();
      writes.push(body);
      assert.equal(body.expected_revision_number, fixture.cheat_sheet.revision_number);
      fixture.cheat_sheet = {
        revision_number: body.expected_revision_number + 1,
        content: structuredClone(body.content),
      };
      revisions.unshift({
        revision_id: "99999999-9999-4999-8999-999999999999",
        ...structuredClone(fixture.cheat_sheet),
      });
      data = { cheat_sheet_revision_id: revisions[0]?.revision_id };
    } else if (path === "/api/tours/detail") {
      if (failRead) return route.fulfill({ status: 503, json: { error: "tour_unavailable" } });
      data = fixture;
    } else if (path === "/api/tours/library") data = { tours: [{ id: tourId, name: fixture.name }] };
    else if (path === "/api/tours/cheat-sheet/history/v1") data = { revisions, limit: 100 };
    await route.fulfill({ json: { data, csrf_token: "synthetic-only" } });
  });
  await page.goto(`${server.origin}/tours/route-editor.html?tour=${tourId}`);
  await page.locator("#tour-panel").waitFor({ state: "visible" });
  await page.locator("#internal-cheat-sheet > summary").click();
  fixture.routes[0].stops[0].property_name = "Updated waterfront office";
  canonical = JSON.stringify(fixture.routes);
  await page.getByRole("button", { name: "Regenerate from accepted itinerary" }).click();
  await page
    .locator("#sheet-state")
    .filter({ hasText: /save confirmed/i })
    .waitFor();
  assert.equal(await page.locator("#cheat-content").inputValue(), "Keep broker preparation");
  assert.match(writes[0]?.content.generated_itinerary ?? "", /Updated waterfront office/);
  assert.equal(JSON.stringify(fixture.routes), canonical);
  assert.deepEqual(revisions.at(-1)?.content, { notes: "Keep broker preparation" });
  await page.locator("#cheat-content").fill("Notes after regeneration");
  await page
    .locator("#sheet-state")
    .filter({ hasText: /save confirmed/i })
    .waitFor();
  await page.reload();
  await page.locator("#tour-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#cheat-content").inputValue(), "Notes after regeneration");
  await page.locator("#internal-cheat-sheet > summary").click();
  await page.getByRole("button", { name: "Read saved revisions" }).click();
  await page.locator("#sheet-history summary").first().waitFor();
  await page.locator("#sheet-history summary").last().click();
  assert.equal(await page.locator("#sheet-history pre").last().textContent(), "Keep broker preparation");
  assert.equal(await page.locator("#cheat-content").inputValue(), "Notes after regeneration");
  await mkdir("/tmp/WR12.S2.J4-shots", { recursive: true });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator("#internal-cheat-sheet").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/WR12.S2.J4-shots/sheet-${width}-${theme}.png` });
    }
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  await page.emulateMedia({ media: "print" });
  assert.equal(await page.locator("#cheat-print .sheet-property").count(), 2);
  assert.equal(
    await page
      .locator("#cheat-print .sheet-property")
      .last()
      .evaluate((node) => getComputedStyle(node).breakBefore),
    "page",
  );
  assert.match((await page.locator("#cheat-print").textContent()) ?? "", /Notes after regeneration/);
  await page.screenshot({ path: "/tmp/WR12.S2.J4-shots/print.png", fullPage: true });
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  failRead = true;
  await page.locator("#cheat-content").fill("New unsaved preparation");
  await page.getByRole("button", { name: "Regenerate from accepted itinerary" }).click();
  await page
    .locator("#status")
    .filter({ hasText: /could not be read/i })
    .waitFor();
  assert.equal(await page.locator("#cheat-content").inputValue(), "New unsaved preparation");
  failRead = false;
  await new Promise((r) => setTimeout(r, 1800));

  await page.reload();
  await page.locator("#tour-panel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#cheat-content").inputValue(), "New unsaved preparation");
  assert.equal(writes.length, 3, "draft still autosaves after regeneration fails");
  await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
  assert.equal(await page.locator("#sheet-history").textContent(), "");
  assert.equal(await page.locator("#sheet-generated").textContent(), "");
});
for (const operation of ["regeneration", "history"]) {
  for (const outcome of ["success", "failure"]) {
    test(`session retirement during ${operation} ignores late ${outcome}`, async (t) => {
      const server = await fixtureServer({ root: join(artifactDir, "site") });
      t.after(() => server.close());
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      page.on("dialog", (dialog) => dialog.accept());
      const fixture = {
        ...fixtureDetail(),
        route_version_id: detail.routes[0].id,
        route_version_state: "accepted",
        accepted_route_version: 1,
        cheat_sheet: { revision_number: 3, content: { notes: "Private broker note" } },
      };
      let hold = false;
      let release = () => {};
      let started = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const requested = new Promise<void>((resolve) => {
        started = resolve;
      });
      const writes: string[] = [];
      const target = operation === "regeneration" ? "/api/tours/detail" : "/api/tours/cheat-sheet/history/v1";
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (route.request().method() === "POST") writes.push(path);
        if (hold && path === target) {
          started();
          await pending;
          if (outcome === "failure") return route.fulfill({ status: 503, json: { error: "unavailable" } });
        }
        const data =
          path === "/api/tours/detail"
            ? fixture
            : path === "/api/tours/library"
              ? { tours: [{ id: tourId, name: fixture.name }] }
              : path === "/api/tours/cheat-sheet/history/v1"
                ? { revisions: [{ revision_id: tourId, ...fixture.cheat_sheet }] }
                : {};
        await route.fulfill({ json: { data, csrf_token: "synthetic-only" } });
      });
      await page.goto(`${server.origin}/tours/route-editor.html?tour=${tourId}`);
      await page.locator("#tour-panel").waitFor({ state: "visible" });
      await page.locator("#internal-cheat-sheet > summary").click();
      await page.locator("#cheat-content").fill("Unacknowledged private draft");
      hold = true;
      await page
        .getByRole("button", {
          name: operation === "regeneration" ? "Regenerate from accepted itinerary" : "Read saved revisions",
        })
        .click();
      await Promise.race([
        requested,
        new Promise((_, reject) => setTimeout(() => reject(new Error("request did not start")), 5000)),
      ]);
      await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
      const received = page.waitForResponse((response) => new URL(response.url()).pathname === target);
      release();
      await received;
      await page.waitForTimeout(1600);
      assert.equal(await page.locator("#sheet-history").textContent(), "");
      assert.equal(await page.locator("#sheet-generated").textContent(), "");
      assert.equal(await page.locator("#sheet-history-status").textContent(), "");
      assert.equal(await page.locator("#cheat-content").inputValue(), "");
      assert.deepEqual(writes, []);
    });
  }
}

test("history read failure recovers without replacing an edited draft", async (t) => {
  const server = await fixtureServer({ root: join(artifactDir, "site") });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  page.on("dialog", (dialog) => dialog.accept());
  let fail = true;
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/history/v1") && fail) return route.fulfill({ status: 503, json: { error: "unavailable" } });
    const data =
      path === "/api/tours/detail"
        ? {
            ...fixtureDetail(),
            route_version_id: detail.routes[0].id,
            route_version_state: "accepted",
            accepted_route_version: 1,
            cheat_sheet: { revision_number: 1, content: { notes: "Saved" } },
          }
        : path === "/api/tours/library"
          ? { tours: [{ id: tourId, name: detail.name }] }
          : path.endsWith("/history/v1")
            ? { revisions: [{ revision_id: tourId, revision_number: 1, content: { notes: "Saved" } }] }
            : {};
    return route.fulfill({ json: { data, csrf_token: "synthetic-only" } });
  });
  await page.goto(`${server.origin}/tours/route-editor.html?tour=${tourId}`);
  await page.locator("#tour-panel").waitFor({ state: "visible" });
  await page.locator("#internal-cheat-sheet > summary").click();
  await page.getByRole("button", { name: "Read saved revisions" }).click();
  await page
    .locator("#sheet-history-status")
    .filter({ hasText: /unavailable/ })
    .waitFor();
  fail = false;
  await page.locator("#cheat-content").fill("Draft kept while reading history");
  await page.getByRole("button", { name: "Read saved revisions" }).click();
  await page.locator("#sheet-history summary").first().click();
  assert.equal(await page.locator("#sheet-history pre").textContent(), "Saved");
  assert.equal(await page.locator("#cheat-content").inputValue(), "Draft kept while reading history");
  await page.getByRole("button", { name: "Read saved revisions" }).click();
  await page
    .locator("#sheet-history-status")
    .filter({ hasText: /Latest 100/ })
    .waitFor();
  assert.equal(await page.locator("#sheet-history summary").count(), 1);
});
