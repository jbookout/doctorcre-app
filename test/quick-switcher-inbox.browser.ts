import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";

test("standalone inbox task absent from board opens its exact card in each viewport and theme", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir("/tmp/WR617.S1.J294-shots", { recursive: true });
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      try {
        await page.goto(`${server.origin}/search?mode=fixture`);
        await page.getByRole("button", { name: "Quick switcher" }).waitFor();
        await page.evaluate(async (theme) => {
          document.documentElement.dataset.theme = theme;
          document.querySelector<HTMLButtonElement>(".quick-switcher-toggle")?.click();
        }, theme);
        await page.getByRole("combobox").fill("Confirm next steps from the pipeline call");
        const option = page.getByRole("option", { name: /Confirm next steps from the pipeline call/ });
        await option.waitFor({ timeout: 4000 });
        assert.equal(await option.count(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: `/tmp/WR617.S1.J294-shots/${width}-${theme}.png` });
        await page.getByRole("combobox").press("Enter");
        await page.waitForURL("**/inbox/card/demo-call");
      } finally {
        await page.close();
      }
    }
});

test("canonical tasks deduplicate, isolate source failures and fence retired reads", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(`${server.origin}/search?mode=fixture`);
  const inbox = await page.evaluate(async () => {
    const { switcherInboxReader } = await import(String("/js/ui-quick-switcher.js"));
    const snapshot = await switcherInboxReader(async () => {
      throw Error("Fixture must not send");
    }, true)();
    const id = "11111111-1111-4111-8111-111111111111";
    const item = {
      ...snapshot.items[0],
      item_id: `next_action:${id}`,
      source_id: id,
      action_id: id,
      title: "Standalone canonical task",
      deal_id: null,
      context_label: null,
      open_url: null,
    };
    return {
      ...snapshot,
      items: [
        item,
        {
          ...item,
          item_id: `capture_post_call_action:${id}`,
          source_type: "capture_post_call_action",
          title: "Offboard canonical task",
          deal_id: "22222222-2222-4222-8222-222222222222",
        },
      ],
    };
  });
  const board = {
    deals: [
      {
        id: "deal-outside-inbox",
        name: "Board Deal",
        open_actions: [
          { id: inbox.items[0].action_id, item_id: inbox.items[0].item_id, description: "Standalone canonical task" },
        ],
      },
    ],
  };
  const network = { nodes: [{ id: "party:contact", name: "Accessible Contact", kind: "contact" }] };
  for (const failed of ["board", "network", "inbox", "none"]) {
    await page.evaluate(
      async ({ board, network, inbox, failed }) => {
        const { openQuickSwitcher, readQuickSwitcherSources } = await import(String("/js/ui-quick-switcher.js"));
        const sources = { board, network, inbox };
        openQuickSwitcher({
          opener: document.querySelector(".quick-switcher-toggle"),
          pages: [{ label: "Calendar", href: "/calendar" }],
          read: () =>
            readQuickSwitcherSources(
              ...(["board", "network", "inbox"] as const).map((source) => async () => {
                if (source === failed) throw Error("Synthetic failure");
                return sources[source];
              }),
            ),
        });
      },
      { board, network, inbox, failed },
    );
    await page.getByRole("combobox").fill("Standalone canonical task");
    await page.getByRole("option").first().waitFor();
    assert.equal(await page.getByRole("option").count(), 1);
    await page.getByRole("button", { name: "Tasks", exact: true }).click();
    assert.equal(await page.getByRole("option").count(), 1);
    if (failed === "inbox") await page.getByText("Home tasks unavailable.", { exact: false }).waitFor();
    if (failed !== "network") {
      await page.getByRole("button", { name: "Contacts", exact: true }).click();
      await page.getByRole("combobox").fill("Accessible Contact");
      await page.getByRole("option").waitFor();
    }
    await page.getByRole("combobox").press("Escape");
  }
  await page.evaluate(async (inbox) => {
    const { openQuickSwitcher } = await import(String("/js/ui-quick-switcher.js"));
    openQuickSwitcher({
      opener: document.querySelector(".quick-switcher-toggle"),
      pages: [],
      read: async () => ({ board: null, network: null, inbox: { ...inbox, truncated: true } }),
    });
  }, inbox);
  await page.getByText("Home task snapshot is limited", { exact: false }).waitFor();
  await page.getByRole("combobox").fill("Offboard");
  await page.getByRole("option").waitFor();
  await page.getByRole("combobox").press("Enter");
  await page.waitForURL(`**/inbox/card/${encodeURIComponent(inbox.items[1].item_id)}`);
  await page.goto(`${server.origin}/search?mode=fixture`);
  await page.evaluate(async () => {
    const { openQuickSwitcher } = await import(String("/js/ui-quick-switcher.js"));
    openQuickSwitcher({
      opener: document.querySelector(".quick-switcher-toggle"),
      pages: [],
      read: () => new Promise((resolve) => Reflect.set(window, "finishInboxRead", resolve)),
    });
  });
  await page.getByRole("combobox").waitFor();
  await page.evaluate(() => dispatchEvent(new Event("doctorcre-session-invalidated")));
  await page.evaluate((inbox) => Reflect.get(window, "finishInboxRead")({ board: null, network: null, inbox }), inbox);
  assert.equal(await page.locator("[data-quick-switcher]").count(), 0);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("doctorcre.quick-switcher.recents.v1")), null);
});

test("ready sources remain visible while inbox is pending, joins or fails, and late updates are fenced", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(`${server.origin}/search?mode=fixture`);
  for (const outcome of ["join", "fail", "close", "retire"]) {
    await page.evaluate(async () => {
      const { openQuickSwitcher, readQuickSwitcherSources, switcherInboxReader } = await import(String("/js/ui-quick-switcher.js"));
      const inbox = await switcherInboxReader(async () => { throw Error("Fixture must not send"); }, true)();
      openQuickSwitcher({
        opener: document.querySelector(".quick-switcher-toggle"),
        pages: [],
        read: (publish: (value: unknown) => void) => readQuickSwitcherSources(
          async () => ({ deals: [{ id: "ready", name: "Ready Deal" }] }),
          () => new Promise((resolve) => Reflect.set(window, "finishNetwork", () => resolve({ nodes: [{ id: "ready-contact", name: "Ready Contact", kind: "contact" }] }))),
          () => new Promise((resolve, reject) => {
            Reflect.set(window, "finishInbox", () => resolve(inbox));
            Reflect.set(window, "failInbox", () => reject(Error("Unavailable")));
          }),
          publish,
        ),
      });
    });
    await page.getByRole("combobox").fill("Ready");
    await page.getByRole("option", { name: "Ready Deal Deal", exact: true }).waitFor({ timeout: 1500 });
    await page.evaluate(() => Reflect.get(window, "finishNetwork")());
    await page.getByRole("option", { name: "Ready Contact Contact", exact: true }).waitFor({ timeout: 1500 });
    if (outcome === "close") await page.getByRole("combobox").press("Escape");
    if (outcome === "retire") await page.evaluate(() => dispatchEvent(new Event("doctorcre-session-invalidated")));
    await page.evaluate((outcome) => Reflect.get(window, outcome === "fail" ? "failInbox" : "finishInbox")(), outcome);
    if (outcome === "close" || outcome === "retire") {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator("[data-quick-switcher]").count(), 0);
    } else {
      await page.getByRole("option", { name: "Ready Deal Deal", exact: true }).waitFor();
      await page.getByRole("option", { name: "Ready Contact Contact", exact: true }).waitFor();
      if (outcome === "join") {
        await page.getByRole("combobox").fill("Confirm next steps from the pipeline call");
        await page.getByRole("option", { name: /Confirm next steps from the pipeline call/ }).waitFor();
      } else await page.getByText("Home tasks unavailable.", { exact: false }).waitFor();
      await page.getByRole("combobox").press("Escape");
    }
  }
});
