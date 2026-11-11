import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";
import { workingWeekAssets } from "./fixtures/home-working-week.ts";

test("Home working week preserves day, exact details, coverage and retirement", async (t) => {
  const server = await startWorkerFixture({
    assets: await workingWeekAssets(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir("/tmp/WR591.S7.J1-shots", { recursive: true });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      try {
        await page.goto(`${server.origin}/?fixture=1`);
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await page.locator('[aria-label="Working week"]').waitFor({ timeout: 10000 });
        const week = page.getByRole("region", { name: "Working week", exact: true });
        const days = week.getByRole("button", { name: /\d{4}/ });
        assert.equal(await days.count(), 7);
        for (const day of await days.all()) {
          const weekday = await day.locator("span").first().textContent();
          const date = await day.locator("strong").textContent();
          assert.equal(
            await week.getByRole("button", { name: new RegExp(`^${weekday}\\s*${date}\\b.*\\d{4}$`) }).count(),
            1,
            "Each day name starts with its visible label and retains the full date",
          );
        }
        assert.equal(
          await page.locator("#appMainSlot #homeRoot").count(),
          1,
          "Home inbox remains inside its workspace beside the week",
        );
        await days.nth(1).click();
        assert.equal(await days.nth(1).getAttribute("aria-pressed"), "true");
        await days.first().click();
        const item = week.locator("[data-week-entry]").first();
        await item.click();
        await page.getByRole("dialog").waitFor();
        await page.keyboard.press("Escape");
        assert.equal(await item.evaluate((node) => node === document.activeElement), true);
        await page.reload();
        await item.waitFor();
        assert.equal(await item.evaluate((node) => node === document.activeElement), true);
        await days.nth(1).click();
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await days.first().click();
        await page.screenshot({ path: `/tmp/WR591.S7.J1-shots/${width}-${theme}.png`, fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
        await week.getByText("Session ended. Sign in again to see your week.").waitFor();
        assert.equal(await week.locator("[data-week-entry]").count(), 0);
      } finally {
        await page.close();
      }
    }
});

test("working day strip stays compact with full dates only in accessible names", async (t) => {
  const server = await startWorkerFixture({
    assets: await workingWeekAssets("2026-11-11"),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      await t.test(`${width} ${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
        try {
          await page.goto(`${server.origin}/?fixture=1`);
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          const days = page.locator(".working-week-days button");
          await days.last().waitFor();
          for (const day of await days.all()) {
            const height = await day.evaluate((button) => button.getBoundingClientRect().height);
            assert.ok(height <= (width === 390 ? 60 : 72), `${width} ${theme}: compact day height, got ${height}px`);
            assert.match(
              await day.innerText(),
              /^[A-Z][a-z]{2}\s*\d{1,2}$/,
              "Only weekday and number render in the strip",
            );
          }
        } finally {
          await page.close();
        }
      });
});

test("working week refreshes, replaces selected sources and refuses retired late reads", async (t) => {
  const server = await startWorkerFixture({
    assets: await workingWeekAssets("2026-11-11"),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.clock.setFixedTime(new Date("2026-11-11T15:00:00Z"));
  await page.route("**/week-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div id="left"></div><div id="right"></div><main id="week"></main>',
    }),
  );
  await page.goto(`${server.origin}/week-test`);
  await page.evaluate(async () => {
    const { mountCalendarPanels } = await import("/js/" + "ui-calendar-panels.generated.js");
    const { createClient } = await import("/js/" + "client.js");
    const { readHomeAgenda, agendaSnapshot } = await import("/js/" + "home-dashboard-model.js");
    const client = await createClient("fixture", {});
    const source = await readHomeAgenda(client);
    const calendar = await client.calendarMeetingPrep();
    const panel = await mountCalendarPanels(
      document.querySelector("#left"),
      document.querySelector("#right"),
      document.querySelector("#week"),
    );
    Reflect.set(window, "weekTest", { panel, source, calendar, agenda: agendaSnapshot(source.board, source.details) });
    panel.render(calendar, source);
  });
  const week = page.getByRole("region", { name: "Working week", exact: true });
  const days = week.getByRole("button", { name: /\d{4}/ });
  await week.getByText("Calendar coverage is incomplete. Check Outlook for changes.", { exact: true }).waitFor();
  await week.getByRole("button", { name: /Demo practice planning/ }).click();
  assert.equal(
    await page.getByRole("dialog").getByRole("link").count(),
    0,
    "Never turn possible_deals or a title into a meeting destination",
  );
  await page.evaluate(() => {
    const s = Reflect.get(window, "weekTest");
    s.panel.render(s.calendar, s.source);
  });
  assert.equal(await page.getByRole("dialog").isVisible(), true, "unchanged refresh keeps detail");
  await page.evaluate(() => {
    const s = Reflect.get(window, "weekTest");
    s.calendar.items[0].location = "Changed office";
    s.panel.render(s.calendar, s.source);
  });
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.matches('#week [aria-pressed="true"]'));
  assert.equal(await days.first().evaluate((node) => node === document.activeElement), true);
  await page.evaluate(() => {
    const s = Reflect.get(window, "weekTest");
    s.panel.render(null, s.source);
  });
  await week.getByText("Calendar unavailable. Check Outlook for meetings.", { exact: true }).waitFor();
  await page.evaluate(() => {
    const s = Reflect.get(window, "weekTest");
    s.calendar.state = "ready";
    s.panel.render(s.calendar, s.source);
  });
  const expected = await page.evaluate(() => {
    const s = Reflect.get(window, "weekTest");
    return s.agenda.entries
      .filter((e: { day: string }) => e.day >= "2026-11-11" && e.day <= "2026-11-17")
      .map((e: { day: string; key: string; deal_id: string }) => ({ day: e.day, key: e.key, deal: e.deal_id }));
  });
  assert.ok(expected.length, "populated dated deal work");
  for (const entry of expected) {
    await days.nth(Number(entry.day.slice(-2)) - 11).click();
    const exact = week.locator(`[data-week-entry=${JSON.stringify(entry.key)}]`);
    await exact.click();
    assert.equal(
      await page.getByRole("dialog").getByRole("link", { name: "Open deal", exact: true }).getAttribute("href"),
      `/deals?deal=${encodeURIComponent(entry.deal)}`,
    );
    await page.getByRole("button", { name: "Return to day" }).click();
    assert.equal(await exact.evaluate((node) => node === document.activeElement), true);
  }
  await days.nth(1).click();
  await page.evaluate(() => {
    const s = Reflect.get(window, "weekTest");
    s.panel.render(s.calendar, s.source);
  });
  assert.equal(await days.nth(1).getAttribute("aria-pressed"), "true");
  await days.first().click();
  await page.evaluate(() => {
    const s = Reflect.get(window, "weekTest");
    Object.assign(s.calendar.items[0], { all_day: true, start: "2026-11-11", end: "2026-11-12" });
    s.panel.render(s.calendar, s.source);
  });
  await week.getByRole("button", { name: /All day.*Demo practice planning/ }).click();
  assert.deepEqual(
    await page
      .getByRole("dialog")
      .locator("time")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("datetime"))),
    ["2026-11-11", "2026-11-12"],
  );
  await page.getByRole("dialog").getByText("2026-11-12 (exclusive)", { exact: true }).waitFor();
  await page.evaluate(() => {
    const s = Reflect.get(window, "weekTest");
    s.panel.retire();
    s.panel.render(s.calendar, s.source);
  });
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await week.locator("[data-week-entry]").count(), 0);
});

for (const scenario of ["partial detail", "ready day"] as const) {
  test(`working week retires ${scenario} and refuses a late refresh`, async (t) => {
    const server = await startWorkerFixture({ assets: await workingWeekAssets("2026-11-11") });
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.clock.setFixedTime(new Date("2026-11-11T15:00:00Z"));
    await page.route("**/week-test", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<div id="left"></div><div id="right"></div><main id="week"></main>',
      }),
    );
    await page.goto(`${server.origin}/week-test`);
    await page.evaluate(async (scenario) => {
      const { mountCalendarPanels } = await import("/js/" + "ui-calendar-panels.generated.js");
      const { createClient } = await import("/js/" + "client.js");
      const { readHomeAgenda } = await import("/js/" + "home-dashboard-model.js");
      const client = await createClient("fixture", {});
      const source = await readHomeAgenda(client);
      const calendar = await client.calendarMeetingPrep();
      if (scenario === "ready day") calendar.state = "ready";
      const panel = await mountCalendarPanels(
        document.querySelector("#left"),
        document.querySelector("#right"),
        document.querySelector("#week"),
      );
      Reflect.set(window, "weekTest", { panel, source, calendar });
      panel.render(calendar, source);
    }, scenario);
    const week = page.getByRole("region", { name: "Working week", exact: true });
    if (scenario === "partial detail") {
      await week.getByText("Calendar coverage is incomplete. Check Outlook for changes.", { exact: true }).waitFor();
      await week.getByRole("button", { name: /Demo practice planning/ }).click();
      await page.getByRole("dialog").waitFor();
    } else {
      await week.locator("[data-week-entry]").first().waitFor();
      assert.equal(await page.getByRole("dialog").count(), 0);
    }
    await page.evaluate(() => {
      const s = Reflect.get(window, "weekTest");
      s.panel.retire();
      s.panel.render(s.calendar, s.source);
    });
    assert.equal(await page.getByRole("dialog").isVisible(), false, `${scenario} must retire`);
    await week.getByText("Session ended. Sign in again to see your week.").waitFor();
    assert.equal(await week.locator("[data-week-entry]").count(), 0);
  });
}

test("working-week fixture admits producer date fields through the live adapter", async (t) => {
  const server = await startWorkerFixture({ assets: await workingWeekAssets("2026-11-11") });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(`${server.origin}/?fixture=1`);
  const result = await page.evaluate(async () => {
    const { createClient } = await import("/js/" + "client.js");
    const client = await createClient("fixture", {});
    return client.getHomeAgenda();
  });
  const dates = result.deals.flatMap((deal: { critical_dates: object[] }) => deal.critical_dates);
  assert.ok(dates.length);
  for (const row of dates) {
    for (const key of ["id", "kind", "due_on", "note", "status"])
      assert.ok(Object.hasOwn(row, key), `producer critical date requires ${key}`);
    assert.equal(Object.hasOwn(row, "date"), false);
  }
  assert.ok(
    (await page.evaluate(() => performance.getEntriesByType("resource").map((r) => r.name))).some((url) =>
      url.includes("home-working-week-responses.json"),
    ),
    "live adapter reads admitted MCP response bytes",
  );
});
