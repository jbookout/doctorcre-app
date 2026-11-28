import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Locator, Page, Route } from "playwright";
import type { ClientDeal } from "../src/ui/deal-diagram.tsx";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const shots = "out/test-artifacts/client-deals";
await mkdir(shots, { recursive: true });
const recordId = "00000000-0000-4000-8000-000000000001";
// A vendor the synthetic directory holds, so Open lands on a real card.
const titleVendor = "00000000-0000-4000-8000-000000000011";
const role = (label: string) => [{ role: label.toLowerCase(), label }];
const deal = (id: string, name: string, parts: Partial<ClientDeal>): ClientDeal => ({
  id,
  name,
  client_id: recordId,
  client_name: "Example client",
  phase: "negotiation",
  phase_label: "Negotiation",
  open: true,
  closed_on: null,
  owner: "dell",
  vendors: [],
  introductions: [],
  ...parts,
});
const introduction = (vendor_id: string, vendor_name: string, chosen: boolean) => ({
  id: `i-${vendor_id}`,
  version: "113",
  vendor_id,
  vendor_name,
  made_by: "team" as const,
  introduced_by: "dell" as const,
  introduced_party_id: recordId,
  introduced_party_name: "Example client",
  introduced_on: "2026-10-14",
  note: null,
  removable: true,
  chosen,
});
const deals: ClientDeal[] = [
  deal("d1", "Example second office", {
    vendors: [{ party_id: "v1", name: "Example Pelican Bank", roles: role("Lender"), introduction_id: "i-v1" }],
    introductions: [
      introduction("v1", "Example Pelican Bank", true),
      introduction("v2", "Example Salt Lending", false),
    ],
  }),
  deal("d2", "Example third office", { owner: "joe", phase_label: "Touring" }),
  deal("d3", "Example first office", {
    open: false,
    closed_on: "2024-03-01",
    phase_label: "Closed",
    vendors: [{ party_id: titleVendor, name: "Example Halloran Title", roles: role("Title"), introduction_id: null }],
  }),
];

type Answer = (route: Route) => Promise<void>;
const answer =
  (list: ClientDeal[]): Answer =>
  (route) =>
    route.fulfill({ json: { deals: list } });

async function openCard(
  t: TestContext,
  deals: Answer,
  {
    width = 1440,
    height = 900,
    scheme = "dark",
    saves,
    introductions,
    dealSaves = true,
  }: {
    width?: number;
    height?: number;
    scheme?: string;
    saves?: Answer;
    introductions?: Answer;
    dealSaves?: boolean;
  } = {},
) {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width, height },
    reducedMotion: "reduce",
  });
  await page.addInitScript((theme) => {
    localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme }));
  }, scheme);
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) => r.fulfill({ json: directoryFixture(r.request().url()) }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }));
  await page.route("**/api/engine/clients/*/deals", (route) => deals(route));
  if (saves) {
    await page.route("**/api/engine/deals/*/parties**", (route) => saves(route));
    if (introductions) await page.route("**/api/engine/introductions**", (route) => introductions(route));
    await page.route(
      (url) => url.pathname === "/api/engine/vendors",
      (route) => {
        const query = (new URL(route.request().url()).searchParams.get("q") ?? "").toLowerCase();
        return route.fulfill({ json: { rows: catalog.filter((v) => v.name.toLowerCase().includes(query)) } });
      },
    );
    await page.route("**/api/engine/vendors/summary", (route) =>
      route.fulfill({
        json: {
          all: 3,
          no_category: 0,
          categories: [...role("Lender"), ...role("Title")].map(({ role: slug, label }) => ({ slug, label })),
        },
      }),
    );
    // Party saves follow the Clients and Vendors switch, and a deal's vendors the deal-saves switch too.
    await page.route(
      (url) => url.pathname === "/clients",
      async (route) => {
        const response = await route.fetch();
        const html = (await response.text()).replace(
          "<html ",
          `<html data-clients-vendors-from-engine ${dealSaves ? "data-deals-saves-from-engine " : ""}`,
        );
        return route.fulfill({ response, body: html });
      },
    );
  }
  await page.goto(`${server.url}/clients?all=true&record=${recordId}&mode=live`);
  const panel = page.locator("#recordPanel");
  await panel.locator("#recordActivity").waitFor();
  return { page, panel };
}

const dealHeads = (panel: Locator) =>
  panel.locator(".client-deal > .client-deal-head").evaluateAll((heads) => heads.map((head) => head.textContent));

test("a client's card draws each of its deals, open deals first, with the closed month on a past deal", async (t) => {
  const { page, panel } = await openCard(t, answer(deals));
  await panel.locator(".client-deal").first().waitFor();
  assert.equal(await panel.locator(".client-deals-section > h3").textContent(), "Deals");
  assert.deepEqual(await dealHeads(panel), [
    "Example second officeNegotiation",
    "Example third officeTouring",
    "Example first officeClosed Mar 2024",
  ]);
  assert.equal(await panel.locator(".client-deal a").first().getAttribute("href"), "/deals?deal=d1");
  assert.equal(await panel.locator(".client-deal .deal-diagram").count(), 3);
  await page.screenshot({ path: `${shots}/card-1440-dark.png` });
});

test("opening a deal shows it large in place of the table, and the x brings the table back", async (t) => {
  const { page, panel } = await openCard(t, answer(deals));
  const opener = panel.getByRole("button", { name: "Open Example second office large" });
  await opener.click();
  const opened = page.locator(".client-deal-opened");
  await opened.waitFor();
  assert.equal(await page.locator("#listRegion").isVisible(), false, "the table steps aside");
  assert.equal(await panel.isVisible(), true, "the card stays beside it");
  assert.deepEqual(
    await opened.locator(".deal-diagram-date").allTextContents(),
    ["Introduced Oct 14, 2026", "Introduced Oct 14, 2026"],
    "dates sit under each introduced name",
  );
  await page.screenshot({ path: `${shots}/opened-1440-dark.png` });
  await opened.getByRole("button", { name: "Back to the table" }).click();
  assert.equal(await opened.count(), 0);
  assert.equal(await page.locator("#listRegion").isVisible(), true, "the table returns");
  assert.equal(await opener.evaluate((node) => node === document.activeElement), true, "focus returns to the opener");
});

test("a client's card shows no Deals heading until the read answers with a deal", async (t) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { panel } = await openCard(t, async (route) => {
    await held;
    return answer(deals)(route);
  });
  await panel.locator(".client-deals-section").waitFor({ state: "attached" });
  assert.equal(await panel.locator(".client-deals-section").textContent(), "", "nothing while the read is out");
  release();
  await panel.locator(".client-deal").first().waitFor();
  assert.equal(await panel.locator(".client-deals-section > h3").textContent(), "Deals");
});

test("a client with no deals never shows a Deals section", async (t) => {
  let answered = () => {};
  const read = new Promise<void>((resolve) => {
    answered = resolve;
  });
  const { page, panel } = await openCard(t, async (route) => {
    await answer([])(route);
    answered();
  });
  await panel.locator(".client-deals-section").waitFor({ state: "attached" });
  await read;
  await page.evaluate(() => new Promise((frame) => requestAnimationFrame(() => requestAnimationFrame(frame))));
  assert.equal(await panel.locator(".client-deals-section").textContent(), "");
  assert.doesNotMatch((await panel.locator("#recordBody").textContent()) ?? "", /Deals/);
});

test("a failed deals read says so plainly and Try again reads them again", async (t) => {
  let fail = true;
  const { panel } = await openCard(t, (route) =>
    fail ? route.fulfill({ status: 500, json: { error: "internal" } }) : answer(deals)(route),
  );
  const retry = panel.getByRole("button", { name: "Try again" });
  await retry.waitFor();
  assert.equal(
    await panel.locator(".client-deals-section .record-note").textContent(),
    "Couldn't load deals. Try again",
  );
  fail = false;
  await retry.click();
  await panel.locator(".client-deal").first().waitFor();
  assert.equal(await panel.locator(".client-deal").count(), 3);
});

for (const [width, height, scheme] of [
  [1440, 900, "light"],
  [1280, 640, "dark"],
  [1280, 640, "light"],
  [390, 844, "dark"],
  [390, 844, "light"],
] as const)
  test(`the card's deals fit at ${width}x${height} ${scheme}`, async (t) => {
    const { page, panel } = await openCard(t, answer(deals), { width, height, scheme });
    await panel.locator(".client-deal").first().waitFor();
    const sideways = await panel.evaluate((node) => node.scrollWidth > node.clientWidth);
    assert.equal(sideways, false, "nothing in the card scrolls sideways");
    assert.equal(
      await panel.locator(".client-deal-open").first().isVisible(),
      width > 767,
      "large view is for a computer",
    );
    const [name, phase] = await panel
      .locator(".client-deal-head")
      .first()
      .evaluate((head) =>
        [...head.querySelectorAll("a, span")].map((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const { top, height } = range.getBoundingClientRect();
          return top + height / 2;
        }),
      );
    assert.ok(
      Math.abs((name ?? 0) - (phase ?? 0)) <= 1,
      `the phase sits level with the deal name (${name} vs ${phase})`,
    );
    await page.screenshot({ path: `${shots}/card-${width}-${scheme}.png` });
    if (width > 767) {
      await panel.locator(".client-deal-open").first().click();
      await page.locator(".client-deal-opened").waitFor();
      await page.screenshot({ path: `${shots}/opened-${width}-${scheme}.png` });
    }
  });

// The vendors the made-up engine finds by name.
const catalog = [
  { id: "v1", name: "Example Pelican Bank" },
  { id: "v2", name: "Example Salt Lending" },
  { id: "v9", name: "Example Harbor Bank" },
];

// A made-up engine: the deals read answers what the saves left, deriving Chosen as the engine does.
function partyEngine(
  refuse: string | null = null,
  after = 0,
  lostResponse: "replacement" | "role" | "undo" | false = false,
) {
  const list = structuredClone(deals);
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const chosen = (d: ClientDeal) =>
    d.introductions.map((i) => ({ ...i, chosen: d.vendors.some((v) => v.party_id === i.vendor_id) }));
  const read: Answer = (route) =>
    route.fulfill({ json: { deals: list.map((d) => ({ ...d, introductions: chosen(d) })) } });
  const save: Answer = (route) => {
    const path = new URL(route.request().url()).pathname;
    const { idempotency_key, ...body } = route.request().postDataJSON();
    assert.match(String(idempotency_key), /^[0-9a-f-]{36}$/);
    sent.push({ path, body });
    if (refuse && sent.length > after) return route.fulfill({ status: 404, json: { error: refuse } });
    const deal = list.find((d) => path.startsWith(`/api/engine/deals/${d.id}/parties`));
    assert.ok(deal, `a known deal: ${path}`);
    // A removal drops one role; the vendor leaves the deal with its last.
    deal.vendors = deal.vendors.flatMap((v) => {
      if (v.party_id !== body.party_id) return [v];
      const left = v.roles.filter((r) => r.role !== body.role);
      return path.endsWith("/remove") && left.length ? [{ ...v, roles: left }] : [];
    });
    const intro = deal.introductions.find((i) => i.vendor_id === body.party_id);
    if (!path.endsWith("/remove"))
      deal.vendors.push({
        party_id: String(body.party_id),
        name: catalog.find((v) => v.id === body.party_id)?.name ?? "Example Halloran Title",
        roles: role(body.role === "title" ? "Title" : "Lender"),
        introduction_id: intro?.id ?? null,
      });
    if (
      (lostResponse === "role" && body.party_id === "v9") ||
      (lostResponse === "undo" && body.party_id === titleVendor && !path.endsWith("/remove"))
    )
      return route.abort();
    return route.fulfill({ json: { deal_id: deal.id, ...body } });
  };
  const receipts = new Map<string, { introduction_id: string }>();
  const introduce: Answer = (route) => {
    const { idempotency_key, ...body } = route.request().postDataJSON();
    assert.match(String(idempotency_key), /^[0-9a-f-]{36}$/);
    const path = new URL(route.request().url()).pathname;
    sent.push({ path, body });
    const prior = receipts.get(idempotency_key);
    if (prior) return route.fulfill({ status: 201, json: { ...prior, replayed: true } });
    if (path.endsWith("/remove")) {
      const id = path.split("/").at(-2);
      const deal = list.find((d) => d.introductions.some((i) => i.id === id && i.removable));
      assert.ok(deal);
      assert.equal(body.version, deal.introductions.find((i) => i.id === id)?.version);
      deal.introductions = deal.introductions.filter((i) => i.id !== id);
      deal.vendors = deal.vendors.map((v) => (v.introduction_id === id ? { ...v, introduction_id: null } : v));
      return route.fulfill({ json: { introduction_id: id } });
    }
    const deal = list.find((d) => d.id === body.deal_id);
    assert.ok(deal, `a known deal: ${body.deal_id}`);
    const id = `i-${body.vendor_id}-${receipts.size}`;
    const version = String(200 + receipts.size);
    if (body.replaces) {
      assert.ok(deal.introductions.some((i) => i.id === body.replaces && i.version === body.replace_version));
      deal.introductions = deal.introductions.filter((i) => i.id !== body.replaces);
    } else {
      assert.ok(!deal.introductions.some((i) => i.vendor_id === body.vendor_id));
    }
    deal.introductions.push({
      id,
      version,
      vendor_id: body.vendor_id,
      vendor_name:
        deal.vendors.find((v) => v.party_id === body.vendor_id)?.name ??
        catalog.find((v) => v.id === body.vendor_id)?.name ??
        "",
      made_by: body.made_by,
      introduced_by: body.introduced_by ?? null,
      introduced_party_id: body.introduced_party_id,
      introduced_party_name: "Example client",
      introduced_on: body.introduced_on,
      note: null,
      removable: true,
      chosen: false,
    });
    deal.vendors = deal.vendors.map((v) => (v.party_id === body.vendor_id ? { ...v, introduction_id: id } : v));
    const receipt = { introduction_id: id, version, ...body };
    receipts.set(idempotency_key, receipt);
    if (lostResponse === "replacement" && body.replaces) return route.abort();
    return route.fulfill({ status: 201, json: receipt });
  };
  return { read, save, introduce, sent, list };
}

async function openParties(t: TestContext, engine = partyEngine(), size = {}) {
  const { page, panel } = await openCard(t, engine.read, {
    ...size,
    saves: engine.save,
    introductions: engine.introduce,
  });
  const deal = panel.locator(".client-deal").first();
  const box = (name: string) => deal.getByRole("button", { name: new RegExp(`^${name}`) });
  const shows = (name: string, tone: string) => deal.locator(`[data-tone="${tone}"]`, { hasText: name }).waitFor();
  return { page, panel, deal, box, shows, sent: engine.sent };
}

test("Mark chosen puts an introduced vendor on the deal in the role picked, and the box turns chosen", async (t) => {
  const { page, box, shows, sent } = await openParties(t);
  await box("Example Salt Lending").click();
  const menu = page.getByRole("dialog", { name: "Example Salt Lending on Example second office" });
  assert.match((await menu.textContent()) ?? "", /Introduced Oct 14, 2026 by Dell\./);
  assert.equal(await menu.getByRole("button", { name: "Remove from this deal" }).count(), 0, "not on the deal yet");
  await page.screenshot({ path: `${shots}/menu-introduced-1440-dark.png` });
  await menu.getByRole("button", { name: "Mark chosen" }).click();
  await menu.getByLabel("Chosen as").selectOption({ label: "Lender" });
  await page.screenshot({ path: `${shots}/menu-role-1440-dark.png` });
  await menu.getByRole("button", { name: "Mark chosen" }).click();
  await shows("Example Salt Lending", "chosen");
  assert.deepEqual(sent, [{ path: "/api/engine/deals/d1/parties", body: { party_id: "v2", role: "lender" } }]);
});

async function freezeUndoClock(page: Page) {
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
}

test("Remove asks once, takes the vendor off the deal, and Undo puts them back within 3 seconds", async (t) => {
  const { page, deal, box, shows, sent } = await openParties(t);
  await freezeUndoClock(page);
  await box("Example Pelican Bank").click();
  const menu = page.getByRole("dialog", { name: "Example Pelican Bank on Example second office" });
  await menu.getByRole("button", { name: "Remove from this deal" }).click();
  assert.match((await menu.textContent()) ?? "", /Remove Example Pelican Bank from Example second office\?/);
  await page.screenshot({ path: `${shots}/menu-confirm-1440-dark.png` });
  assert.equal(sent.length, 0, "nothing is sent before the partner confirms");
  await menu.getByRole("button", { name: "Remove", exact: true }).click();
  await shows("Example Pelican Bank", "introduced");
  const undo = deal.locator(".client-deal-undo");
  assert.equal(await undo.textContent(), "Removed Example Pelican Bank from Example second office. Undo");
  await page.clock.runFor(2_900);
  await undo.getByRole("button", { name: "Undo" }).click();
  await shows("Example Pelican Bank", "chosen");
  const pelican = { party_id: "v1", role: "lender" };
  assert.deepEqual(sent, [
    { path: "/api/engine/deals/d1/parties/remove", body: pelican },
    { path: "/api/engine/deals/d1/parties", body: pelican },
  ]);
  await box("Example Pelican Bank").click();
  await menu.getByRole("button", { name: "Remove from this deal" }).click();
  await menu.getByRole("button", { name: "Remove", exact: true }).click();
  await undo.waitFor();
  await page.clock.runFor(3_000);
  await undo.waitFor({ state: "detached" });
});

test("a second removal inside 3 seconds keeps the first removal's Undo for its own 3 seconds", async (t) => {
  const engine = partyEngine();
  engine.list[0]?.vendors.push({
    party_id: titleVendor,
    name: "Example Halloran Title",
    roles: role("Title"),
    introduction_id: null,
  });
  const { page, deal, box, shows } = await openParties(t, engine);
  await freezeUndoClock(page);
  const remove = async (name: string) => {
    await box(name).click();
    await page.getByRole("button", { name: "Remove from this deal" }).click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await deal.locator(".client-deal-undo", { hasText: name }).waitFor();
    await page.clock.runFor(1_000);
  };
  await remove("Example Halloran Title");
  await remove("Example Pelican Bank");
  await shows("Example Pelican Bank", "introduced");
  const undo = deal.locator(".client-deal-undo");
  assert.deepEqual(await undo.allTextContents(), [
    "Removed Example Halloran Title from Example second office. Undo",
    "Removed Example Pelican Bank from Example second office. Undo",
  ]);
  await page.clock.runFor(1_100);
  assert.deepEqual(await undo.allTextContents(), ["Removed Example Pelican Bank from Example second office. Undo"]);
  await page.clock.runFor(1_000);
  await undo.waitFor({ state: "detached" });
});

test("a removal that stops partway re-reads the diagram and says how far it got", async (t) => {
  const engine = partyEngine("not_found", 1);
  const lender = engine.list[0]?.vendors[0];
  assert.ok(lender);
  lender.roles = [...role("Lender"), ...role("Title")];
  const { page, deal, box } = await openParties(t, engine);
  await box("Example Pelican Bank").click();
  await page.getByRole("button", { name: "Remove from this deal" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  const alert = page.locator(".deal-vendor-menu").getByRole("alert");
  assert.equal(await alert.textContent(), "That vendor isn't on this deal anymore. 1 of 2 roles were removed.");
  const remaining = box("Example Pelican Bank").filter({ hasNotText: "Lender" });
  await remaining.waitFor();
  assert.match((await remaining.textContent()) ?? "", /Title/);
  assert.equal(await deal.locator(".client-deal-undo").count(), 0);
});

async function addVendor(page: Page, deal: Locator, brought: string) {
  await deal.getByRole("button", { name: "+ Add vendor" }).click();
  const form = page.getByRole("form", { name: "Add a vendor to Example second office" });
  await form.getByLabel("Find a vendor").fill("example");
  const found = form.locator(".deal-add-vendor-found button");
  await found.first().waitFor();
  assert.deepEqual(await found.allTextContents(), ["Example Harbor Bank"], "vendors already on the deal are left out");
  await found.first().click();
  await form.getByLabel("Role").selectOption({ label: "Lender" });
  await form.getByRole("button", { name: brought }).click();
  return form;
}

test("Add vendor records which partner brought them in, puts them on the deal, and the box is chosen under that partner", async (t) => {
  const { page, deal, sent } = await openParties(t);
  const form = await addVendor(page, deal, "Joe");
  assert.equal(await form.getByRole("button", { name: "Joe" }).getAttribute("aria-pressed"), "true");
  await page.screenshot({ path: `${shots}/add-vendor-1440-dark.png` });
  await form.getByRole("button", { name: "Add", exact: true }).click();
  const joe = deal.locator("li", { has: page.locator(".deal-diagram-box", { hasText: /^JJoe/ }) });
  await joe.locator('[data-tone="chosen"]', { hasText: "Example Harbor Bank" }).waitFor();
  assert.equal(await form.count(), 0, "the form closes once saved");
  const [introduction] = sent;
  assert.match(String(introduction?.body.introduced_on), /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(sent, [
    {
      path: "/api/engine/introductions",
      body: {
        made_by: "team",
        vendor_id: "v9",
        introduced_by: "joe",
        introduced_party_id: recordId,
        introduced_on: introduction?.body.introduced_on,
        deal_id: "d1",
        unrecorded_only: true,
      },
    },
    { path: "/api/engine/deals/d1/parties", body: { party_id: "v9", role: "lender" } },
  ]);
});

test("Add vendor with Not recorded puts them on the deal under the dashed line, recording no introduction", async (t) => {
  const { page, deal, sent } = await openParties(t);
  const form = await addVendor(page, deal, "Not recorded");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await deal.locator('.deal-diagram-junction [data-tone="onDeal"]', { hasText: "Example Harbor Bank" }).waitFor();
  assert.deepEqual(sent, [{ path: "/api/engine/deals/d1/parties", body: { party_id: "v9", role: "lender" } }]);
});

test("an Add vendor that is refused after the introduction landed says so, and trying again records it once", async (t) => {
  const { page, deal, sent } = await openParties(t, partyEngine("database_refused_the_statement", 1));
  const form = await addVendor(page, deal, "Dell");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  assert.equal(
    await form.getByRole("alert").textContent(),
    "The database turned this down. They may already be on the deal in that role. Example Harbor Bank is recorded as introduced by Dell.",
  );
  assert.equal(await form.getByRole("button", { name: "Change" }).isEnabled(), false);
  assert.equal(await form.getByLabel("Role").isEnabled(), true);
  await form.getByLabel("Role").selectOption({ label: "Title" });
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await form.getByRole("alert").waitFor();
  assert.equal(sent.at(-1)?.body.role, "title");
  assert.deepEqual(
    sent.map((s) => s.path),
    ["/api/engine/introductions", "/api/engine/deals/d1/parties", "/api/engine/deals/d1/parties"],
  );
});

for (const [width, height, scheme] of [
  [1440, 900, "light"],
  [1280, 640, "dark"],
  [1280, 640, "light"],
  [390, 844, "dark"],
  [390, 844, "light"],
] as const)
  test(`Add vendor fits at ${width}x${height} ${scheme}`, async (t) => {
    const { page, panel, deal } = await openParties(t, partyEngine(), { width, height, scheme });
    await addVendor(page, deal, "Dell");
    const sideways = await panel.evaluate((node) => node.scrollWidth > node.clientWidth);
    assert.equal(sideways, false, "the open form never scrolls the card sideways");
    await page.screenshot({ path: `${shots}/add-vendor-${width}-${scheme}.png` });
  });

test("with deal saves off the vendor boxes are labels and open no menu", async (t) => {
  const { page, deal } = await openParties(t, partyEngine(), { dealSaves: false });
  await deal.locator(".deal-diagram-box", { hasText: "Example Pelican Bank" }).waitFor();
  assert.equal(await deal.getByRole("button", { name: "+ Add vendor" }).count(), 0, "no Add vendor");
  assert.equal(await deal.getByRole("button", { name: /^Example Pelican Bank/ }).count(), 0);
  await deal.locator(".deal-diagram-box", { hasText: "Example Pelican Bank" }).click();
  assert.equal(await page.locator(".deal-vendor-menu").count(), 0);
});

test("Open takes the partner to the vendor's card", async (t) => {
  const { page, panel } = await openParties(t);
  await panel
    .locator(".client-deal")
    .nth(2)
    .getByRole("button", { name: /^Example Halloran Title/ })
    .click();
  const menu = page.getByRole("dialog", { name: "Example Halloran Title on Example first office" });
  assert.match((await menu.textContent()) ?? "", /Brought in by: not recorded/);
  await menu.getByRole("link", { name: "Open Example Halloran Title" }).click();
  await page.locator(`#recordBody[data-record-id="${titleVendor}"]`).waitFor();
  assert.equal(new URL(page.url()).pathname, "/vendors");
});

test("a refused save reads plainly and keeps the menu open", async (t) => {
  const { page, panel, deal, box } = await openParties(t, partyEngine("not_found"));
  await box("Example Pelican Bank").click();
  await page.getByRole("button", { name: "Remove from this deal" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  const alert = page.locator(".deal-vendor-menu").getByRole("alert");
  assert.equal(await alert.textContent(), "That vendor isn't on this deal anymore.");
  assert.equal(await deal.locator(".client-deal-undo").count(), 0, "no Undo for a removal that did not land");
  await page.screenshot({ path: `${shots}/menu-refused-1440-dark.png` });
  await page.locator("#recordClose").click();
  await panel.getByRole("heading", { name: "Deals", exact: true }).waitFor({ state: "hidden" });
  await page.locator(`a[data-record-id="${recordId}"]`).click();
  await box("Example Pelican Bank").click();
  await alert.getByText("That vendor isn't on this deal anymore.").waitFor();
});

test("Enter and Space open a vendor's menu, and Esc closes it and returns focus to the box", async (t) => {
  const { page, box } = await openParties(t);
  const pelican = box("Example Pelican Bank");
  for (const key of ["Enter", " "]) {
    await pelican.focus();
    await page.keyboard.press(key);
    const menu = page.locator(".deal-vendor-menu");
    assert.equal(
      await menu.evaluate((node) => node.contains(document.activeElement)),
      true,
      "focus moves into the menu",
    );
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.equal(await pelican.evaluate((node) => node === document.activeElement), true, "focus returns to the box");
    assert.equal(await page.locator("#recordPanel").isVisible(), true, "Esc closes the menu, not the card");
  }
});

test("without party saves a vendor box is a label", async (t) => {
  const { panel } = await openCard(t, answer(deals));
  await panel.locator(".client-deal").first().waitFor();
  assert.equal(await panel.locator(".deal-diagram [role='button']").count(), 0);
});

for (const [width, height, scheme] of [
  [1440, 900, "light"],
  [1280, 640, "dark"],
  [1280, 640, "light"],
  [390, 844, "dark"],
  [390, 844, "light"],
] as const)
  test(`a vendor's menu fits at ${width}x${height} ${scheme}`, async (t) => {
    const { page, box } = await openParties(t, partyEngine(), { width, height, scheme });
    await box("Example Salt Lending").click();
    const { left, right } = await page
      .locator(".deal-vendor-menu")
      .evaluate((node) => node.getBoundingClientRect().toJSON());
    assert.ok(left >= 0 && right <= width, `the menu stays on screen (${left} to ${right})`);
    const sideways = await page.locator("#recordPanel").evaluate((node) => node.scrollWidth > node.clientWidth);
    assert.equal(sideways, false, "the open menu never makes the card scroll sideways");
    await page.screenshot({ path: `${shots}/menu-${width}-${scheme}.png` });
  });

const longName = "Example Brand - Example Deal 2 - EXAMPLE CITY ST";
for (const [width, height, scheme] of [
  [1280, 599, "dark"],
  [1280, 599, "light"],
  [1440, 900, "dark"],
  [1440, 900, "light"],
  [390, 844, "dark"],
  [390, 844, "light"],
] as const)
  test(`a long deal name never widens the card at ${width}x${height} ${scheme}`, async (t) => {
    const long = [deal("d1", longName, { phase_label: "Letter of intent" })];
    const { page, panel } = await openCard(t, answer(long), { width, height, scheme });
    await panel.locator(".client-deal").first().waitFor();
    const inside = await panel.evaluate((node, wide) => {
      const card = node.getBoundingClientRect();
      const fits = (selector: string) => {
        const box = node.querySelector(selector)?.getBoundingClientRect();
        return !!box && box.width > 0 && box.left >= card.left && box.right <= card.right;
      };
      return {
        sideways: node.scrollWidth > node.clientWidth,
        phase: fits(".client-deal-head > span"),
        diagram: fits(".client-deal .deal-diagram"),
        open: !wide || fits(".client-deal-open"),
      };
    }, width > 767);
    assert.deepEqual(inside, { sideways: false, phase: true, diagram: true, open: true });
    assert.equal(await panel.locator(".client-deal-head a").first().getAttribute("title"), longName);
    await page.screenshot({ path: `${shots}/long-name-${width}-${scheme}.png` });
  });

test("Set records the client on a linked deal and removal leaves the chosen role", async (t) => {
  const engine = partyEngine();
  const linkedDeal = engine.list[2];
  assert.ok(linkedDeal);
  linkedDeal.client_id = "linked-client";
  linkedDeal.client_name = "Example linked client";
  const { page, panel, sent } = await openParties(t, engine);
  const article = panel.locator(".client-deal", { hasText: "Example first office" });
  await article.getByRole("button", { name: /Example Halloran Title/ }).click();
  let menu = page.getByRole("dialog", { name: "Example Halloran Title on Example first office" });
  await menu.getByRole("button", { name: "Set", exact: true }).click();
  await menu.getByRole("button", { name: "The client" }).click();
  await menu.getByRole("button", { name: "Set", exact: true }).click();
  await article.locator('.deal-diagram [data-tone="client"]', { hasText: "Example linked client" }).waitFor();
  const direct = article.locator(".deal-diagram > ul > li > .deal-diagram-vendor", {
    hasText: "Example Halloran Title",
  });
  await direct.getByRole("button", { name: /Title · Chosen/ }).click();
  assert.equal(sent[0]?.body.introduced_party_id, "linked-client");
  menu = page.getByRole("dialog", { name: "Example Halloran Title on Example first office" });
  const { introduced_on } = sent[0]?.body ?? {};
  assert.equal(typeof introduced_on, "string");
  const date = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(String(introduced_on)),
  );
  assert.match((await menu.textContent()) ?? "", new RegExp(`Introduced ${date}`));
  await menu.getByRole("button", { name: "Remove introduction" }).click();
  await menu.getByText("Remove the introduction for Example Halloran Title on Example first office?").waitFor();
  await menu.getByRole("button", { name: "Remove", exact: true }).click();
  await article.locator('.deal-diagram-junction [data-tone="onDeal"]', { hasText: "Example Halloran Title" }).waitFor();
  assert.equal(engine.list[2]?.vendors[0]?.roles[0]?.role, "title");
});

async function openSource(t: TestContext, engine = partyEngine()) {
  const { page, panel, sent } = await openParties(t, engine);
  const article = panel.locator(".client-deal", { hasText: "Example first office" });
  const vendor = article.getByRole("button", { name: /Example Halloran Title/ });
  const menu = page.getByRole("dialog", { name: "Example Halloran Title on Example first office" });
  await vendor.click();
  await menu.getByRole("button", { name: "Set", exact: true }).click();
  return { page, panel, article, vendor, menu, sent };
}

async function holdDealReads(t: TestContext, page: Page) {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  await page.route("**/api/engine/clients/*/deals", async (route) => {
    started.resolve();
    await release.promise;
    await route.fallback();
  });
  return { started: started.promise, release: release.resolve };
}

test("an introduction removed before the reread no longer shows a source", async (t) => {
  const engine = partyEngine();
  const { page, article, vendor, menu } = await openSource(t, engine);
  const held = await holdDealReads(t, page);
  await menu.getByRole("button", { name: "Joe" }).click();
  await menu.getByRole("button", { name: "Set", exact: true }).click();
  await held.started;
  const deal = engine.list[2];
  assert.ok(deal);
  assert.ok(deal.introductions.some((row) => row.introduced_by === "joe"));
  deal.introductions = [];
  deal.vendors = deal.vendors.map((row) => ({ ...row, introduction_id: null }));
  deal.closed_on = "2024-04-17";
  held.release();
  await article.getByText("Closed Apr 2024", { exact: true }).waitFor();
  await vendor.click();
  await menu.getByRole("button", { name: "Set", exact: true }).waitFor({ timeout: 3000 });
  assert.match((await menu.textContent()) ?? "", /Brought in by: not recorded/);
});

async function addWithKnownSource(t: TestContext) {
  const engine = partyEngine(null, 0, "replacement");
  const { page, deal, sent, shows } = await openParties(t, engine);
  await page.route(
    "**/api/engine/deals/d1/parties",
    (route) => route.fulfill({ status: 422, json: { error: "database_refused_the_statement" } }),
    { times: 1 },
  );
  const form = await addVendor(page, deal, "Joe");
  const submit = form.locator('button[type="submit"]');
  await submit.click();
  await form
    .getByRole("alert")
    .getByText(/recorded as introduced by Joe/)
    .waitFor();
  await form.getByRole("button", { name: "The client" }).click();
  return { engine, page, deal, sent, shows, form, submit };
}

test("a lost replacement waits for a fresh read before retrying the role", async (t) => {
  const { page, form, submit, shows, sent } = await addWithKnownSource(t);
  const held = await holdDealReads(t, page);
  await submit.click();
  await form.getByText("Couldn't confirm the save", { exact: false }).waitFor();
  await form.getByRole("button", { name: "Check again" }).click();
  await held.started;
  await form.getByText("Checking the save…", { exact: false }).waitFor();
  assert.equal(await submit.isEnabled(), false);
  held.release();
  await form.getByText(/Recorded as introduced by The client/).waitFor();
  await submit.click();
  await shows("Example Harbor Bank", "chosen");
  assert.equal(sent.filter((row) => row.body.replaces).length, 1);
});

test("removing a checked replacement lets Set record Dell as a new source", async (t) => {
  const { engine, page, deal, form, submit, shows } = await addWithKnownSource(t);
  await submit.click();
  await form.getByText("Couldn't confirm the save", { exact: false }).waitFor();
  await form.getByRole("button", { name: "Check again" }).click();
  await form.getByText(/Recorded as introduced by The client/).waitFor();
  await deal.locator(".deal-diagram > ul > li > .deal-diagram-vendor", { hasText: "Example Harbor Bank" }).waitFor();
  await submit.click();
  await shows("Example Harbor Bank", "chosen");
  const vendor = deal.getByRole("button", { name: /^Example Harbor Bank/ });
  const menu = page.getByRole("dialog", { name: "Example Harbor Bank on Example second office" });
  await vendor.click();
  await menu.getByRole("button", { name: "Remove introduction" }).click();
  await menu.getByRole("button", { name: "Remove", exact: true }).click();
  await deal.locator('.deal-diagram-junction [data-tone="onDeal"]', { hasText: "Example Harbor Bank" }).waitFor();
  await vendor.click();
  await menu.getByRole("button", { name: "Set", exact: true }).click();
  await menu.getByRole("button", { name: "Dell" }).click();
  const request = page.waitForRequest((request) => request.url().endsWith("/api/engine/introductions"));
  await menu.getByRole("button", { name: "Set", exact: true }).click();
  assert.equal((await request).postDataJSON().introduced_by, "dell");
  await shows("Example Harbor Bank", "chosen");
  await vendor.click();
  await menu.getByText(/Introduced .* by Dell/).waitFor({ timeout: 3000 });
  assert.equal(engine.list[0]?.introductions.find((row) => row.vendor_id === "v9")?.introduced_by, "dell");
});

test("an earlier reread cannot hide a role after the Add vendor save lands", async (t) => {
  const engine = partyEngine();
  const { page, panel, deal, shows } = await openParties(t, engine);
  const form = await addVendor(page, deal, "Joe");
  const allowRole = Promise.withResolvers<void>();
  const roleStarted = Promise.withResolvers<void>();
  t.after(() => allowRole.resolve());
  await page.route("**/api/engine/deals/d1/parties", async (route) => {
    if (route.request().postDataJSON().party_id === "v9") {
      roleStarted.resolve();
      await allowRole.promise;
    }
    await route.fallback();
  });
  const releaseStale = Promise.withResolvers<void>();
  const releaseFresh = Promise.withResolvers<void>();
  const staleCaptured = Promise.withResolvers<void>();
  t.after(() => {
    releaseStale.resolve();
    releaseFresh.resolve();
  });
  await page.route("**/api/engine/clients/*/deals", async (route) => {
    const snapshot = structuredClone(engine.list);
    if (snapshot[0]?.vendors.some((vendor) => vendor.party_id === "v9")) {
      await releaseFresh.promise;
    } else {
      staleCaptured.resolve();
      await releaseStale.promise;
    }
    await route.fulfill({ json: { deals: snapshot } }).catch(() => {});
  });
  await form.locator('button[type="submit"]').click();
  await roleStarted.promise;
  // This unrelated Set starts a reread even if Add vendor has not asked for one yet.
  const other = panel.locator(".client-deal", { hasText: "Example first office" });
  await other.getByRole("button", { name: /Example Halloran Title/ }).click();
  const menu = page.getByRole("dialog", { name: "Example Halloran Title on Example first office" });
  await menu.getByRole("button", { name: "Set", exact: true }).click();
  await menu.getByRole("button", { name: "Dell" }).click();
  await menu.getByRole("button", { name: "Set", exact: true }).click();
  await staleCaptured.promise;
  allowRole.resolve();
  await form.waitFor({ state: "hidden" });
  releaseStale.resolve();
  await deal.locator('[data-tone="chosen"]', { hasText: "Example Harbor Bank" }).waitFor({ timeout: 3000 });
  releaseFresh.resolve();
  await shows("Example Harbor Bank", "chosen");
});

test("a transport failure checks the saved role only after the partner asks", async (t) => {
  const engine = partyEngine(null, 0, "role");
  const { page, deal, sent, shows } = await openParties(t, engine);
  const form = await addVendor(page, deal, "Not recorded");
  const held = await holdDealReads(t, page);
  const submit = form.getByRole("button", { name: "Add", exact: true });
  await submit.click();
  await form.getByText("Couldn't confirm the save", { exact: false }).waitFor();
  assert.equal(await submit.isEnabled(), false);
  await form.getByRole("button", { name: "Check again" }).click();
  await held.started;
  await form.getByText("Checking the save…", { exact: false }).waitFor();
  assert.equal(await submit.isEnabled(), false);
  held.release();
  await shows("Example Harbor Bank", "onDeal");
  await submit.click();
  await form.waitFor({ state: "hidden" });
  assert.equal(sent.filter((row) => row.body.party_id === "v9").length, 1);
});

test("a vendor link stays locked when its client card remounts during Set", async (t) => {
  const engine = partyEngine();
  const { page, panel, article, vendor, menu } = await openSource(t, engine);
  const started = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  t.after(() => commit.resolve());
  await page.route("**/api/engine/introductions", async (route) => {
    started.resolve();
    await commit.promise;
    await route.fallback();
  });
  await menu.getByRole("button", { name: "Joe" }).click();
  await menu.getByRole("button", { name: "Set", exact: true }).click();
  await started.promise;
  await page.locator("#recordClose").click();
  await panel.getByRole("heading", { name: "Deals", exact: true }).waitFor({ state: "hidden" });
  await page.locator(`a[data-record-id="${recordId}"]`).click();
  await vendor.click();
  assert.equal(await menu.getByRole("button", { name: "Set", exact: true }).count(), 0);
  commit.resolve();
  await article.locator('[data-tone="chosen"]', { hasText: "Example Halloran Title" }).waitFor();
  await vendor.click();
  await menu.getByText(/Introduced .* by Joe/).waitFor();
  assert.equal(engine.sent.length, 1);
});

test("a late Add role response keeps Title locked while the original Lender save lands", async (t) => {
  const engine = partyEngine();
  const { page, deal, shows } = await openParties(t, engine);
  const form = await addVendor(page, deal, "Not recorded");
  const submit = form.getByRole("button", { name: "Add", exact: true });
  const started = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  t.after(() => commit.resolve());
  await page.route("**/api/engine/deals/d1/parties", async (route) => {
    const { role } = route.request().postDataJSON();
    if (role === "lender") {
      started.resolve();
      await commit.promise;
    }
    await route.fallback();
  });
  await page.clock.install();
  await submit.click();
  await started.promise;
  await page.clock.fastForward(10_001);
  await form.getByText("Still saving…", { exact: true }).waitFor({ timeout: 3000 });
  assert.equal(await form.getByLabel("Role").isEnabled(), false);
  assert.equal(await submit.isEnabled(), false);
  commit.resolve();
  await form.waitFor({ state: "hidden" });
  await shows("Example Harbor Bank", "onDeal");
  assert.deepEqual(
    engine.sent.filter((row) => row.body.party_id === "v9").map((row) => row.body.role),
    ["lender"],
  );
  assert.deepEqual(engine.list[0]?.vendors.find((row) => row.party_id === "v9")?.roles, role("Lender"));
});

test("an unconfirmed Undo without a vendor box can be checked from its notice", async (t) => {
  const engine = partyEngine(null, 0, "undo");
  const { page, panel, sent } = await openParties(t, engine);
  const article = panel.locator(".client-deal", { hasText: "Example first office" });
  const vendor = article.getByRole("button", { name: /Example Halloran Title/ });
  await freezeUndoClock(page);
  await vendor.click();
  const menu = page.getByRole("dialog", { name: "Example Halloran Title on Example first office" });
  await menu.getByRole("button", { name: "Remove from this deal" }).click();
  await menu.getByRole("button", { name: "Remove", exact: true }).click();
  const notice = article.locator(".client-deal-undo");
  await notice.getByRole("button", { name: "Undo", exact: true }).click();
  const check = notice.getByRole("button", { name: "Check again" });
  await check.waitFor({ timeout: 3000 });
  assert.equal(await notice.getByRole("button", { name: "Undo", exact: true }).count(), 0);
  assert.match((await notice.textContent()) ?? "", /Couldn't confirm the save/);
  await check.click();
  await vendor.waitFor();
  await notice.getByText(/put back/).waitFor();
  assert.equal(await notice.getByRole("button", { name: "Undo", exact: true }).count(), 0);
  assert.equal(sent.length, 2);

  await vendor.click();
  await menu.getByRole("button", { name: "Remove from this deal" }).click();
  await menu.getByRole("button", { name: "Remove", exact: true }).click();
  await notice.getByRole("button", { name: "Undo", exact: true }).waitFor();
  assert.equal(await notice.count(), 1);
});

test("a failed Check again restores the unconfirmed message and offers another check", async (t) => {
  const { page, deal, shows, sent } = await openParties(t, partyEngine(null, 0, "role"));
  const form = await addVendor(page, deal, "Not recorded");
  const submit = form.getByRole("button", { name: "Add", exact: true });
  await submit.click();
  const unconfirmed = form.getByText("Couldn't confirm the save", { exact: false });
  await unconfirmed.waitFor();
  await page.route("**/api/engine/clients/*/deals", (route) => route.fulfill({ status: 503 }), { times: 1 });
  const failed = page.waitForResponse((response) => response.url().endsWith("/deals") && response.status() === 503);
  await form.getByRole("button", { name: "Check again" }).click();
  await failed;
  await unconfirmed.waitFor({ timeout: 3000 });
  assert.equal(await submit.isEnabled(), false);
  await form.getByRole("button", { name: "Check again" }).click();
  await shows("Example Harbor Bank", "onDeal");
  await submit.click();
  await form.waitFor({ state: "hidden" });
  assert.equal(sent.filter((row) => row.body.party_id === "v9").length, 1);
});

test("Undo of an unintroduced vendor shows Still saving when the restore is held", async (t) => {
  const engine = partyEngine();
  const { page, panel, sent } = await openParties(t, engine);
  const article = panel.locator(".client-deal", { hasText: "Example first office" });
  const vendor = article.getByRole("button", { name: /Example Halloran Title/ });
  const started = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  t.after(() => commit.resolve());
  await page.route("**/api/engine/deals/*/parties", async (route) => {
    started.resolve();
    await commit.promise;
    await route.fallback();
  });
  await freezeUndoClock(page);
  await vendor.click();
  const menu = page.getByRole("dialog", { name: "Example Halloran Title on Example first office" });
  await menu.getByRole("button", { name: "Remove from this deal" }).click();
  await menu.getByRole("button", { name: "Remove", exact: true }).click();
  const notice = article.locator(".client-deal-undo");
  await notice.getByRole("button", { name: "Undo", exact: true }).click();
  await started.promise;
  await page.clock.runFor(10_001);
  await notice.getByText("Still saving…", { exact: true }).waitFor({ timeout: 3000 });
  assert.equal(await notice.getByRole("button", { name: "Undo", exact: true }).count(), 0);
  assert.equal(sent.length, 1);
  commit.resolve();
  await vendor.waitFor();
  await notice.waitFor({ state: "hidden" });
  assert.equal(sent.length, 2);
});

test("Check again for an unconfirmed Undo survives closing and reopening the client card", async (t) => {
  const engine = partyEngine(null, 0, "undo");
  const { page, panel, sent } = await openParties(t, engine);
  const article = panel.locator(".client-deal", { hasText: "Example first office" });
  const vendor = article.getByRole("button", { name: /Example Halloran Title/ });
  await freezeUndoClock(page);
  await vendor.click();
  const menu = page.getByRole("dialog", { name: "Example Halloran Title on Example first office" });
  await menu.getByRole("button", { name: "Remove from this deal" }).click();
  await menu.getByRole("button", { name: "Remove", exact: true }).click();
  const notice = article.locator(".client-deal-undo");
  await notice.getByRole("button", { name: "Undo", exact: true }).click();
  const check = notice.getByRole("button", { name: "Check again" });
  await check.waitFor();
  await page.locator("#recordClose").click();
  await article.waitFor({ state: "detached" });
  await page.locator(`a[data-record-id="${recordId}"]`).click();
  await article.waitFor();
  await check.waitFor({ timeout: 3000 });
  await check.click();
  await vendor.waitFor();
  await notice.getByText(/put back/).waitFor();
  assert.equal(sent.length, 2);
});

test("a checked Undo never becomes available after a later removal elsewhere", async (t) => {
  const engine = partyEngine(null, 0, "undo");
  const { page, panel, sent } = await openParties(t, engine);
  const article = panel.locator(".client-deal", { hasText: "Example first office" });
  const vendor = article.getByRole("button", { name: /Example Halloran Title/ });
  await freezeUndoClock(page);
  await vendor.click();
  const menu = page.getByRole("dialog", { name: "Example Halloran Title on Example first office" });
  await menu.getByRole("button", { name: "Remove from this deal" }).click();
  await menu.getByRole("button", { name: "Remove", exact: true }).click();
  const notice = article.locator(".client-deal-undo");
  await notice.getByRole("button", { name: "Undo", exact: true }).click();
  await notice.getByRole("button", { name: "Check again" }).click();
  await notice.getByText(/was put back/).waitFor();
  await page.locator("#recordClose").click();
  await article.waitFor({ state: "detached" });
  const changed = engine.list.find((row) => row.name === "Example first office");
  assert.ok(changed);
  changed.vendors = changed.vendors.filter((row) => row.party_id !== titleVendor);
  await page.locator(`a[data-record-id="${recordId}"]`).click();
  await article.waitFor();
  assert.equal(await vendor.count(), 0);
  assert.equal(await notice.getByRole("button", { name: "Undo", exact: true }).count(), 0);
  assert.equal(sent.length, 2);
});

test("a persisted Add refusal describes the source on the latest read", async (t) => {
  const engine = partyEngine("database_refused_the_statement", 1);
  const { page, panel, deal } = await openParties(t, engine);
  const form = await addVendor(page, deal, "Dell");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await form
    .getByRole("alert")
    .getByText(/introduced by Dell/)
    .waitFor();
  await page.locator("#recordClose").click();
  await deal.waitFor({ state: "detached" });
  const source = engine.list[0]?.introductions.find((row) => row.vendor_id === "v9");
  assert.ok(source);
  source.introduced_by = "joe";
  await page.locator(`a[data-record-id="${recordId}"]`).click();
  await panel.getByRole("button", { name: /^Example Harbor Bank/ }).click();
  const menu = page.getByRole("dialog", { name: /Example Harbor Bank on/ });
  await menu.getByText(/Introduced .* by Joe/).waitFor();
  assert.match((await menu.getByRole("alert").textContent()) ?? "", /recorded as introduced by Joe/);
});

test("a lost Add reply has one Check again while the form is open and after closing it", async (t) => {
  const { page, deal } = await openParties(t, partyEngine(null, 0, "role"));
  const form = await addVendor(page, deal, "Not recorded");
  await form.getByRole("button", { name: "Add", exact: true }).click();
  const check = deal.getByRole("button", { name: "Check again" });
  await form.getByRole("button", { name: "Check again" }).waitFor();
  assert.equal(await check.count(), 1);
  await form.getByRole("button", { name: "Cancel" }).click();
  await check.waitFor();
  assert.equal(await check.count(), 1);
});

test("a fresh read clears the Set conflict once the other source is removed", async (t) => {
  const engine = partyEngine();
  const { page, article, vendor, menu } = await openSource(t, engine);
  const deal = engine.list[2];
  const dell = engine.list[0]?.introductions.find((row) => row.introduced_by === "dell");
  assert.ok(deal && dell);
  const held = await holdDealReads(t, page);
  await page.route("**/api/engine/introductions", (route) => {
    deal.introductions = [{ ...dell, vendor_id: titleVendor, vendor_name: "Example Halloran Title" }];
    return route.fulfill({ status: 409, json: { error: "introduction_already_recorded" } });
  });
  await menu.getByRole("button", { name: "Joe" }).click();
  await menu.getByRole("button", { name: "Set", exact: true }).click();
  const refusal = page.getByText(/A source is already recorded/);
  await refusal.waitFor();
  await held.started;
  await page.locator("#recordClose").click();
  await article.waitFor({ state: "detached" });
  deal.introductions = [];
  held.release();
  await page.locator(`a[data-record-id="${recordId}"]`).click();
  await vendor.click();
  await menu.getByText("Brought in by: not recorded", { exact: true }).waitFor();
  await menu.getByRole("button", { name: "Set", exact: true }).waitFor();
  assert.equal(await refusal.count(), 0);
});

test("a refused Not recorded Add is visible on the reopened deal without reopening Add", async (t) => {
  const { page, deal, box } = await openParties(t);
  const form = await addVendor(page, deal, "Not recorded");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  await page.route("**/api/engine/deals/d1/parties", async (route) => {
    started.resolve();
    await release.promise;
    await route.fulfill({ status: 422, json: { error: "database_refused_the_statement" } });
  });
  await form.getByRole("button", { name: "Add", exact: true }).click();
  await started.promise;
  await page.locator("#recordClose").click();
  await deal.waitFor({ state: "detached" });
  const refused = page.waitForResponse(
    (response) => response.url().endsWith("/d1/parties") && response.status() === 422,
  );
  release.resolve();
  await refused;
  await page.locator(`a[data-record-id="${recordId}"]`).click();
  await deal.waitFor();
  const notice = deal.getByRole("alert").filter({ hasText: /The database turned this down/ });
  await notice.waitFor({ timeout: 3000 });
  assert.equal(await box("Example Harbor Bank").count(), 0);
  assert.equal(await form.count(), 0);
  const reopenedForm = await addVendor(page, deal, "Not recorded");
  await reopenedForm.getByRole("alert").waitFor();
  await deal.getByRole("button", { name: "Open Example second office large" }).click();
  const opened = page.getByRole("region", { name: "Example second office", exact: true });
  await opened
    .getByRole("alert")
    .filter({ hasText: /The database turned this down/ })
    .waitFor();
  assert.equal(await page.getByText(/The database turned this down/).count(), 1);
});
