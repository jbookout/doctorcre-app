import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import {
  chromium,
  fixtureServer,
  settles,
  animationsSettled,
} from "./browser-harness.mjs";
import { workspace } from "./leads-workspace-fixture.mjs";
let server;
before(async () => {
  server = await fixtureServer(
    process.env.V1_REGRESSION_ROOT
      ? { root: process.env.V1_REGRESSION_ROOT }
      : {},
  );
});
after(() => server?.close());
async function open(t, path = "/", width = 1440) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width, height: width === 390 ? 844 : 960 },
    reducedMotion: "reduce",
  });
  await page.route("**/api/system-work/session", (r) =>
    r.fulfill({
      json: { actor: { slug: "joe" }, csrf_token: "synthetic-regression" },
    }),
  );
  await page.route("**/mcp", (r) => {
    const name = r.request().postDataJSON().params.name;
    if (path.includes("mode=live"))
      return r.fulfill({
        status: path.startsWith("/leads") ? 401 : 503,
        json: { error: "unavailable" },
      });
    const value =
      name === "lead-board"
        ? workspace()
        : name === "deal-room-board"
          ? { actor: "joe", deals: [] }
          : { ok: false, error: "fixture_tool_unavailable" };
    return r.fulfill({
      json: {
        result: { content: [{ type: "text", text: JSON.stringify(value) }] },
      },
    });
  });
  await page.goto(server.origin + path);
  await animationsSettled(page);
  return page;
}
async function search(t, width, kinds = "") {
  const page = await open(
    t,
    "/search?q=Demo" + (kinds ? "&kinds=" + kinds : ""),
    width,
  );
  await page.waitForFunction(
    (count) =>
      document
        .querySelector("#searchCount")
        .textContent.startsWith(count + " "),
    kinds ? "7" : "19",
  );
  return page;
}
async function contrast(page, selector) {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const rgb = (value) =>
        (value.match(/[\d.]+/g) || [])
          .slice(0, 3)
          .map((n) => Number(n) * (value.startsWith("color(srgb") ? 255 : 1));
      let bg = el;
      while (
        bg.parentElement &&
        getComputedStyle(bg).backgroundColor === "rgba(0, 0, 0, 0)"
      )
        bg = bg.parentElement;
      const luminance = (values) =>
        values
          .map((x) => {
            const n = x / 255;
            return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
          })
          .reduce((a, n, i) => a + n * [0.2126, 0.7152, 0.0722][i], 0);
      const a = luminance(rgb(getComputedStyle(el).color)),
        b = luminance(rgb(getComputedStyle(bg).backgroundColor));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
}
test("QA-001 account controls paint outside the rail and remain keyboard reachable", async (t) => {
  for (const width of [1440, 390]) {
    const page = await open(t, "/", width);
    await page.locator("#selfAvatar").click();
    await page.keyboard.press("Tab");
    const visible = await page.locator("#accountMenu").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 25);
      return r.left >= 0 && r.right <= innerWidth && !!hit && el.contains(hit);
    });
    assert.ok(visible);
    assert.equal(
      await page
        .locator("#accountProfile")
        .evaluate((el) => document.activeElement === el),
      true,
    );
  }
});
test("QA-002 Home titles contrast with light cards", async (t) => {
  const page = await open(t);
  await page.getByLabel("Dark mode", { exact: true }).click();
  await page.locator("#homeInvoices .home-flag strong").first().waitFor();
  assert.ok((await contrast(page, ".home-flag strong")) >= 4.5);
  assert.ok((await contrast(page, "#homeInvoices .home-flag strong")) >= 4.5);
});
test("QA-003 failed Deals board has a visible explanation", async (t) => {
  const page = await open(t, "/deals?mode=live");
  await page.waitForFunction(() =>
    document.querySelector("#boardLive").textContent.includes("could not"),
  );
  const b = await page.locator("#boardLive").boundingBox();
  assert.ok(b.width > 100 && b.height > 10);
});
test("QA-005 last phone lead can scroll clear of Doc", async (t) => {
  const page = await open(t, "/leads", 390);
  await page.locator("[data-lead-id]").first().waitFor();
  await page.evaluate(() =>
    window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }),
  );
  const card = page.locator(".lead-card").last();
  const score = await card.locator(".score").boundingBox();
  const doc = await page
    .getByRole("button", { name: "Open Doc", exact: true })
    .boundingBox();
  assert.ok(score.y + score.height <= doc.y || score.x + score.width <= doc.x);
});
test("QA-006 scope keyboard focus survives render on desktop and phone", async (t) => {
  for (const width of [1440, 390]) {
    const page = await search(t, width);
    const org = page.locator('[data-chip="organizations"]');
    await org.focus();
    await page.keyboard.press("Space");
    assert.equal(
      await org.evaluate((el) => document.activeElement === el),
      true,
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await page
        .locator('[data-chip="deals"]')
        .evaluate((el) => document.activeElement === el),
      true,
    );
  }
});
test("QA-007 scopes toggle independently and can all be disabled", async (t) => {
  const page = await search(t);
  await page.locator('[data-chip="leads"]').click();
  assert.equal(
    await page.locator('[data-chip="leads"]').getAttribute("aria-pressed"),
    "false",
  );
  assert.match(await page.locator("#searchCount").textContent(), /^17 /);
  const selected = await page
    .locator("#searchChips button[aria-pressed=true]")
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.chip));
  for (const id of selected) await page.locator(`[data-chip="${id}"]`).click();
  assert.match(await page.locator("#searchCount").textContent(), /^0 /);
  await page.reload();
  await settles(async () =>
    assert.match(await page.locator("#searchCount").textContent(), /^0 /),
  );
});
test("QA-008 failed requests settle Leads Tours and Deals freshness after retry", async (t) => {
  for (const [path, time, refresh] of [
    ["/tours?mode=live", "#planner-updated", "#planner-refresh"],
    ["/leads?mode=live", "#boardUpdated", "#refreshBoard"],
    ["/deals?mode=live", "#boardAsOf", null],
  ]) {
    const page = await open(t, path);
    await settles(async () =>
      assert.match(
        await page.locator(time).textContent(),
        /unavailable|required|error/i,
        path,
      ),
    );
    if (refresh && (await page.locator(refresh).count())) {
      await page.locator(refresh).focus();
      await page.keyboard.press("Enter");
      await settles(async () =>
        assert.match(
          await page.locator(time).textContent(),
          /unavailable|required|error/i,
          path,
        ),
      );
    }
  }
});
test("QA-009 Back to Doc Chats shows selection state and disables thread controls", async (t) => {
  const page = await open(t, "/doc-chats");
  await page.locator("[data-open]").nth(1).click();
  await page.goBack();
  await settles(async () =>
    assert.match(
      await page.locator("#turnsStateTitle").textContent(),
      /select|choose|open/i,
    ),
  );
  for (const id of ["renameSave", "pinToggle", "archiveToggle"])
    assert.equal(await page.locator("#" + id).isDisabled(), true);
});
test("QA-010 notification preferences anchor lands on the async form", async (t) => {
  const page = await open(t, "/updates#prefForm");
  await page.locator("#prefForm").waitFor({ state: "visible" });
  await settles(async () => {
    const r = await page.locator("#prefForm").boundingBox();
    assert.ok(r.y >= 0 && r.y < 700);
  });
});
test("QA-011 multiple matches give interface guidance", async (t) => {
  const page = await search(t);
  assert.doesNotMatch(
    await page.locator("#searchCandidates").textContent(),
    /catch-me-up|verb/,
  );
  assert.match(await page.locator("#searchCandidates").textContent(), /Open/);
});
test("QA-012 search total and unfiltered candidates explain their scopes", async (t) => {
  const page = await search(t, 1440, "leads,organizations");
  assert.match(
    await page.locator("#searchCount").textContent(),
    /^7 grouped results shown$/,
  );
  assert.match(
    await page.locator("#searchCandidates").textContent(),
    /all scopes|not filtered/i,
  );
});
test("QA-013 vendor search opens a Vendors workspace", async (t) => {
  const page = await search(t);
  await page.locator('[data-group="vendors"] a').first().click();
  await settles(async () =>
    assert.equal(await page.locator("#pageTitle").textContent(), "Vendors"),
  );
  assert.match(await page.title(), /^Vendors/);
  assert.equal(
    await page.locator("#appSidebar .app-layout-sidebar-head h2").textContent(),
    "Vendors",
  );
});
test("QA-014 suggested introduction descriptions contrast in dark mode", async (t) => {
  const page = await open(t);
  await page.getByRole("button", { name: "Just Me", exact: true }).click();
  await page.locator("#homeIntroductions button").first().waitFor();
  assert.ok((await contrast(page, "#homeIntroductions button strong")) >= 4.5);
});
test("QA-015 Search hover and focus label stays legible", async (t) => {
  const page = await search(t);
  const button = page.locator("#searchForm button");
  await button.click();
  assert.ok((await contrast(page, "#searchForm button")) >= 4.5);
  await button.hover();
  assert.ok((await contrast(page, "#searchForm button")) >= 4.5);
});
test("QA-016 live Leads sign-in refusal includes accessible recovery", async (t) => {
  const page = await open(t, "/leads?mode=live");
  await page.waitForFunction(() =>
    document.querySelector("#leadBoardError").textContent.includes("Sign-in"),
  );
  const link = page.locator("#leadBoardError a");
  assert.equal(await link.textContent(), "Sign in");
  assert.match(await link.getAttribute("href"), /^\/auth\/login\?return_to=/);
  await link.focus();
  assert.equal(
    await link.evaluate((el) => document.activeElement === el),
    true,
  );
});
test("QA-017 Vendors load refusal is announced", async (t) => {
  const page = await open(t, "/vendors?mode=live");
  await page.getByText("This did not load", { exact: true }).waitFor();
  assert.ok(
    await page
      .locator('[role="alert"]')
      .filter({ hasText: "This did not load" })
      .count(),
  );
});
test("QA-018 Ask Doc failure says delivery status and recovery and preserves input", async (t) => {
  const page = await open(t);
  await page.getByRole("button", { name: "Open Doc", exact: true }).click();
  const input = page.locator("#docCommandInput");
  await input.fill("Ask about a fictional lease");
  await input.press("Enter");
  const status = await page.locator("#docCommandStatus").textContent();
  assert.match(status, /not submitted|not sent/i);
  assert.match(status, /try again|search|retry/i);
  assert.equal(await input.inputValue(), "Ask about a fictional lease");
});
test("QA-019 packet review retains client load failure and draft", async (t) => {
  const page = await open(t, "/tours");
  await page
    .getByText("Clients temporarily unavailable.", { exact: true })
    .first()
    .waitFor();
  await page.locator("#plan-name").fill("Demo tour");
  await page.locator("#plan-notes").fill("Synthetic draft");
  await page.locator("#review-packet").click();
  assert.match(
    await page.locator("#plan-message").textContent(),
    /Clients temporarily unavailable.*Refresh tours/i,
  );
  assert.equal(await page.locator("#plan-name").inputValue(), "Demo tour");
});
test("QA-020 cleared submitted search removes the previous URL query", async (t) => {
  const page = await search(t);
  await page.locator("#searchQuery").fill("");
  await page.locator("#searchForm button").click();
  assert.equal(new URL(page.url()).searchParams.has("q"), false);
  await page.reload();
  assert.equal(await page.locator("#searchQuery").inputValue(), "");
});
test("QA-021 single lead count uses singular", async (t) => {
  const page = await open(t, "/leads");
  await page
    .locator('#stageFilter option[value="qualified"]')
    .waitFor({ state: "attached" });
  await page
    .getByRole("button", { name: "Workspace sidebar", exact: true })
    .click();
  await page.locator("#stageFilter").selectOption("qualified");
  assert.equal(await page.locator("#filterSummary").textContent(), "1 lead");
});
