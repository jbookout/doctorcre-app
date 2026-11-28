import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after, before, type TestContext } from "node:test";
import type { Locator, Page } from "playwright";
import { buildArtifact } from "../scripts/artifact.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { chromium } from "./browser-harness.mjs";
import { ownedFixtureServer } from "./fixture-probe.ts";

let server: Awaited<ReturnType<typeof ownedFixtureServer>>;
before(async () => {
  const outDir = temporaryDirectory("home-columns-");
  await buildArtifact({ root: process.cwd(), outDir });
  server = await ownedFixtureServer({ root: join(outDir, "site") });
});
after(() => server?.close());

const today = "2026-11-25";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const card = (n: number, title: string, fields: Record<string, unknown> = {}) => ({
  item_id: `next_action:${id(n)}`,
  card_id: `next_action:${id(n)}`,
  source_type: "next_action",
  source_id: id(n),
  source_version: "1",
  base_version: "1:0:inbox",
  source_state: "needs_attention",
  title,
  why: "The practice asked for it",
  primary_action: "Mark done",
  activity_at: "2026-11-24T15:00:00.000Z",
  completed_at: null,
  due_on: null,
  hold_until: null,
  snoozed_until: null,
  disposition: "inbox",
  section: "inbox",
  unseen: false,
  context_label: "Example Dental",
  open_url: `/deals?deal=${id(99)}&focus=next-step&step=${id(n)}`,
  deal_id: id(99),
  kind_label: "Task",
  action_id: id(n),
  action_version: 1,
  merged_source_ids: [id(n)],
  waiting_version: 0,
  waiting_on: null,
  source_activity: null,
  undo_completion: false,
  returns_at: null,
  waiting_reason: null,
  days_late: null,
  late_label: null,
  tile: "reminders",
  ...fields,
});
const late = (n: number, title: string, days: number) =>
  card(n, title, {
    due_on: new Date(Date.parse(today) - days * 86_400_000).toISOString().slice(0, 10),
    days_late: days,
  });
const reply = (n: number, title: string) =>
  card(n, title, {
    item_id: `suggestion:${id(n)}`,
    card_id: `suggestion:${id(n)}`,
    source_type: "email_proposal",
    action_id: null,
    action_version: null,
    deal_id: null,
    open_url: null,
    kind_label: "Suggestion",
    primary_action: "Review suggestions",
    tile: "inbox",
  });
const group = (items: unknown[]) => ({ count: items.length, items });
const longTitle = "Ask the sample contractor for an estimate on the second-floor buildout and the new parking…";
const longInstruction =
  "Ask the sample contractor for an estimate on the second-floor buildout and the new parking lot lighting before Friday, including separate line items for the lobby canopy, patient drop-off lane, and signage conduit. Follow-up set on Aug 13, 2026.";
const dashboard = {
  ok: true,
  schema_version: "home-inbox.v6",
  home_mark_drop: true,
  home_proposal_drop: true,
  reminders: group([
    late(1, "Call the sample practice", 3),
    late(2, "Send the sample lease comments", 14),
    late(3, "Follow up on the old sample", 15),
    card(4, "Send the sample floor plan", { due_on: today }),
    card(5, longTitle, {
      why: longInstruction,
    }),
  ]),
  inbox: group([reply(11, "Send your reply to the sample practice")]),
  waiting: group([
    card(21, "Send the sample parking study", {
      section: "snoozed",
      disposition: "snoozed",
      snoozed_until: "2026-12-01T15:00:00Z",
      returns_at: "2026-12-01T15:00:00Z",
      waiting_reason: "Snoozed",
      primary_action: null,
    }),
  ]),
};

const deal = (n: number, phase: string, fields: Record<string, unknown> = {}) => ({
  id: id(100 + n),
  name: `Example Deal ${n}`,
  phase,
  owner: "joe",
  attention: null,
  operating_state: "active",
  workspace_kind: "team",
  next_step_required: false,
  open_actions: [{ id: id(200 + n), owner: "joe", due_on: "2026-12-04", description: "Call the landlord" }],
  ...fields,
});
const deals = [
  deal(1, "Research", {
    attention: { reason: "A next step is late.", since: "2026-11-23" },
    open_actions: [{ id: id(201), owner: "joe", due_on: "2026-11-22", description: "Call" }],
  }),
  deal(2, "Legal", {
    attention: { reason: "This deal has no next step and no suggestion.", since: "2026-11-02" },
    next_step_required: true,
    open_actions: [],
  }),
  deal(3, "Legal", { attention: true }),
  deal(4, "Research", { operating_state: "parked", attention: true }),
  deal(5, "Research", { workspace_kind: "national_account" }),
];
const reviewDeal = (state: string, workspace_kind: string, operating_state: string) => ({
  deal_id: id(500),
  state,
  workspace_kind,
  operating_state,
  reviewed: null,
});
const reviewItems = [
  { ...reviewDeal("open", "team", "active"), reviewed: { by: "joe" } },
  reviewDeal("open", "team", "active"),
  reviewDeal("open", "team", "active"),
  reviewDeal("open", "team", "parked"),
  reviewDeal("open", "national_account", "active"),
  reviewDeal("lost", "team", "active"),
  { party_id: id(401), state: "open", reviewed: null },
  { party_id: id(402), state: "open", reviewed: null },
];
const criticalDate = (n: number, due_on: string) => ({
  id: id(300 + n),
  deal_id: id(101),
  deal_name: "Example Deal 1",
  kind: "Due diligence ends",
  due_on,
  done: false,
});
const comingUpDates = [criticalDate(1, "2026-11-27"), criticalDate(2, today), criticalDate(3, "2026-12-10")];
const sampleMeeting = { title: "Sample site visit", start: "2026-11-25T20:00:00Z", end: "2026-11-25T21:00:00Z" };

// Names of any Leads board or Quiet list read Home makes.
const leadReads: string[] = [];

async function openHome(
  t: TestContext,
  width: number,
  height: number,
  tours: unknown[] = [],
  dates = comingUpDates,
  home: typeof dashboard = dashboard,
  leadCounts: unknown = { schema_version: "lead-counts.v1", new_from_email: 2, follow_ups_late: 1 },
  right: {
    deals?: typeof deals;
    meetings?: (typeof sampleMeeting)[];
    touch?: boolean;
    theme?: "light";
    failedRead?: "weekly review" | "critical dates";
    beforeLoad?: (page: Page) => Promise<void>;
    waitForReady?: false;
  } = {},
) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width, height },
    timezoneId: "America/Chicago",
    hasTouch: right.touch ?? width <= 760,
  });
  await page.clock.setFixedTime(new Date("2026-11-25T16:00:00Z"));
  await page.addInitScript(
    (theme) =>
      localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ walkthroughSeen: { joe: true }, theme })),
    right.theme,
  );
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
  );
  await page.route(
    (url) => url.pathname === "/" && url.searchParams.get("mode") === "live",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace("<html ", "<html data-home-today-from-engine ");
      await route.fulfill({ response, body });
    },
  );
  await page.route("**/api/engine/home/inbox?view=dashboard&contract=home-inbox.v6", (route) =>
    route.fulfill({ json: home }),
  );
  await page.route("**/api/engine/home/today", (route) =>
    route.fulfill({
      json: {
        ok: true,
        schema_version: "home-today.v1",
        today,
        viewer: null,
        meetings: {
          state: "ready",
          items: right.meetings ?? [sampleMeeting],
        },
      },
    }),
  );
  if (tours.length)
    await page.route("**/api/engine/calendar/meetings?*", (route) =>
      route.fulfill({
        json: {
          schema_version: "calendar-meetings.v1",
          meetings: [{ partner: "joe", name: "Joe", state: "empty", items: [] }],
          tours: { state: "ready", reason: null, items: tours },
        },
      }),
    );
  await page.route("**/api/engine/weekly-reviews?week_of=2026-11-23", (route) =>
    route.fulfill(right.failedRead === "weekly review" ? { status: 503 } : { json: { items: reviewItems } }),
  );
  await page.route("**/api/engine/calendar/critical-dates", (route) =>
    route.fulfill(
      right.failedRead === "critical dates"
        ? { status: 503 }
        : { json: { schema_version: "calendar-critical-dates.v1", critical_dates: dates } },
    ),
  );
  await page.route("**/api/engine/leads/counts", (route) => route.fulfill({ json: leadCounts }));
  await page.route("**/mcp", async (route) => {
    const call = route.request().postDataJSON();
    if (["lead-board", "quiet-follow-ups"].includes(call.params.name)) leadReads.push(call.params.name);
    await route.fulfill({
      json: {
        jsonrpc: "2.0",
        id: call.id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ board_from_engine: true, deals: right.deals ?? deals }) }],
        },
      },
    });
  });
  await right.beforeLoad?.(page);
  await page.goto(`${server.origin}/?mode=live`);
  if (right.waitForReady === false) return page;
  await page.getByRole("region", { name: "Reminders", exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector(".home-placeholder"));
  return page;
}

for (const [width, height] of [
  [1440, 900],
  [1280, 640],
] as const)
  test(`Home shows Reminders, Inbox and the day side by side on one ${width}x${height} screen`, async (t) => {
    const page = await openHome(t, width, height);
    const reminders = page.getByRole("region", { name: "Reminders", exact: true });
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    const waiting = page.getByRole("region", { name: "In motion and waiting", exact: true });
    const meetings = page.getByRole("region", { name: "Today's meetings", exact: true });
    await meetings.waitFor();
    assert.equal(await reminders.getByRole("heading", { level: 2 }).textContent(), "Reminders 5 · 2 late");
    const groups = await reminders.getByRole("region").evaluateAll((nodes) => nodes.map((node) => node.ariaLabel));
    assert.deepEqual(groups, ["Late", "Today", "No date"]);
    assert.deepEqual(await inbox.getByRole("button").allTextContents(), ["Snooze", "Drop"]);
    assert.deepEqual(await waiting.getByRole("button").allTextContents(), ["Wake"]);
    assert.equal(await page.getByRole("checkbox").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Snooze selected" }).count(), 0);
    const box = async (tile: typeof inbox) => (await tile.boundingBox()) ?? assert.fail("tile is not drawn");
    const region = (name: string) => box(page.getByRole("region", { name, exact: true }));
    const [left, middle, below] = [await box(reminders), await box(inbox), await box(waiting)];
    const right = await box(meetings);
    const leadsLine = await region("Leads");
    const column = [right, await region("Deals"), await region("Coming up"), leadsLine];
    assert.ok(left.x + left.width <= middle.x && middle.x + middle.width <= right.x, "three columns, left to right");
    assert.ok(Math.abs(below.x - middle.x) < 1 && below.y >= middle.y + middle.height, "waiting sits under Inbox");
    assert.ok(
      column.every((next, i) => {
        const above = column[i - 1];
        return Math.abs(next.x - right.x) < 1 && (!above || next.y >= above.y + above.height);
      }),
      "meetings, Deals, Coming up and Leads stack in the right column",
    );
    assert.equal(
      await page.locator("#appMainSlot").evaluate((main) => main.scrollHeight <= main.clientHeight),
      true,
      "the main area does not scroll",
    );
    assert.ok(leadsLine.y + leadsLine.height <= height, "Leads is on the first screen");
    assert.equal(
      await page.evaluate(() => document.scrollingElement?.scrollHeight),
      height,
      "the page does not scroll",
    );
  });

test("Reminders 15 or more days late fold into one line that opens in place", async (t) => {
  const page = await openHome(t, 1440, 900);
  const reminders = page.getByRole("region", { name: "Reminders", exact: true });
  const lateRows = reminders.getByRole("region", { name: "Late" }).getByRole("article");
  assert.deepEqual(await lateRows.getByRole("link").allTextContents(), [
    "Send the sample lease comments",
    "Call the sample practice",
  ]);
  assert.equal(await reminders.getByText("Follow up on the old sample").count(), 0);
  await reminders.getByRole("button", { name: "1 more than two weeks late" }).click();
  await reminders
    .getByRole("region", { name: "More than two weeks late" })
    .getByText("Follow up on the old sample")
    .waitFor();
  assert.equal(await reminders.getByRole("heading", { level: 2 }).textContent(), "Reminders 5 · 2 late");
});

for (const width of [390, 500, 999] as const)
  test(`At ${width}px Today's meetings comes first, Leads after Inbox, and In motion and waiting last`, async (t) => {
    const page = await openHome(t, width, 844);
    await page.getByRole("region", { name: "Today's meetings", exact: true }).waitFor();
    const tiles = await page.locator(".home-slice").evaluateAll((nodes) =>
      nodes
        .map((node) => ({ name: node.getAttribute("aria-label"), top: node.getBoundingClientRect().top }))
        .sort((a, b) => a.top - b.top)
        .map(({ name }) => name),
    );
    assert.deepEqual(tiles, [
      "Today's meetings",
      "Reminders",
      "Inbox",
      "Deals",
      "Coming up",
      "Leads",
      "In motion and waiting",
    ]);
  });

test("The Leads line counts new and late leads and opens Leads", async (t) => {
  const page = await openHome(t, 1440, 900);
  const line = page.getByRole("region", { name: "Leads", exact: true }).getByRole("link");
  assert.equal(await line.textContent(), "Leads2 new from email · 1 follow-up late");
  assert.equal(await line.getAttribute("href"), "/leads");
  assert.deepEqual(leadReads, [], "Home reads no Leads board or Quiet list");
});

for (const [fault, answer] of [
  ["a wrong schema version", { schema_version: "lead-counts.v0", new_from_email: 2, follow_ups_late: 1 }],
  ["a missing count", { schema_version: "lead-counts.v1", new_from_email: 2 }],
] as const)
  test(`The Leads line says counts are unavailable for ${fault}, never wrong numbers`, async (t) => {
    const page = await openHome(t, 1440, 900, [], comingUpDates, dashboard, answer);
    const line = page.getByRole("region", { name: "Leads", exact: true }).getByRole("link");
    assert.equal(await line.textContent(), "LeadsLead counts unavailable");
  });

test("At 1440 a waiting row keeps its whole return date and gives the rest to the title", async (t) => {
  const page = await openHome(t, 1440, 900);
  const row = page.getByRole("region", { name: "In motion and waiting", exact: true }).getByRole("article");
  const fits = (selector: string) =>
    row.locator(selector).evaluate((node) => ({ text: node.textContent, fits: node.scrollWidth <= node.clientWidth }));
  assert.deepEqual(await fits(".inbox-why"), { text: "Snoozed until Dec 1, 2026, 9:00 AM", fits: true });
  assert.deepEqual(await fits("h3"), { text: "Send the sample parking study", fits: true });
});

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const)
  test(`At ${width} a tour row in Today's meetings shows Tour at the row start and its whole title`, async (t) => {
    const page = await openHome(t, width, height, [
      {
        id: "tour-1",
        deal_id: id(99),
        deal_name: "Example Dental",
        owner: "joe",
        planned_on: today,
        stop_count: 3,
        open_url: `/deals?deal=${id(99)}`,
      },
    ]);
    const row = page.getByRole("region", { name: "Today's meetings", exact: true }).locator(".home-tour");
    await row.waitFor();
    const rowLeft = (await row.boundingBox())?.x ?? assert.fail("the tour row is not drawn");
    const markLeft = (await row.locator(".home-today-time").boundingBox())?.x ?? assert.fail("Tour is not drawn");
    const title = row.locator(".home-today-title");
    const drawn = {
      markOffset: markLeft - rowLeft,
      titlePadding: await title.evaluate((node) => getComputedStyle(node).paddingInlineStart),
      titleText: await title.textContent(),
      titleCut: await title.evaluate((node) => node.scrollWidth > node.clientWidth),
    };
    assert.ok(drawn.markOffset < 16, `Tour sits at the row start, not ${drawn.markOffset}px in`);
    assert.equal(drawn.titlePadding, "0px");
    assert.equal(drawn.titleText, "Example Dental · 3 stops");
    assert.equal(drawn.titleCut, false, "the title is not cut off");
  });

test("Deals counts the Monday review's items and the board's phases, and Coming up lists the next 14 days, each opening what it counts", async (t) => {
  const page = await openHome(t, 1440, 900);
  const tile = page.getByRole("region", { name: "Deals", exact: true });
  const link = (name: string) => tile.getByRole("link", { name, exact: true }).getAttribute("href");
  assert.equal(
    (await tile.locator(".home-deals-counts").textContent())?.replaceAll("\u00a0", " "),
    "3 open · 1 parked · 1 national · 2 prospects",
  );
  assert.equal(await tile.getByRole("heading", { level: 2 }).textContent(), "Deals");
  assert.equal(await link("3 open · 1 parked · 1 national · 2 prospects"), "/deals");
  assert.equal(await link("Research 1"), "/deals?column=research");
  assert.equal(await link("Example Deal 1 A next step is late."), `/deals?deal=${id(101)}`);
  assert.equal(await link("Example Deal 2 This deal has no next step and no suggestion."), `/deals?deal=${id(102)}`);
  assert.equal(await tile.getByRole("link", { name: /^Example Deal 3/ }).count(), 0, "a stored flag is not attention");
  assert.equal(await link("1 has no next step"), "/deals?view=list&filter=no-next-step");
  assert.equal(await link("Monday review 1 of 8 includes 1 closed or lost this week"), "/deals?view=review");
  const comingUp = page.getByRole("region", { name: "Coming up", exact: true });
  assert.deepEqual(await comingUp.getByRole("link").allTextContents(), [
    "2",
    "Wed, Nov 25Due diligence ends · Example Deal 1",
    "Fri, Nov 27Due diligence ends · Example Deal 1",
  ]);
  assert.equal(await comingUp.getByRole("link", { name: "2", exact: true }).getAttribute("href"), "/calendar");
  assert.equal(await comingUp.getByRole("link").nth(1).getAttribute("href"), `/calendar?day=${today}`);
});

for (const [width, height] of [
  [1440, 900],
  [1280, 640],
] as const)
  test(`At ${width}x${height} the Deals heading shows a practice's counts on one line under it, and the week's closings sit on the Monday review line`, async (t) => {
    const page = await openHome(t, width, height);
    await page.addInitScript(() =>
      localStorage.setItem(
        "doctorcre.visual-preferences",
        JSON.stringify({ theme: "light", walkthroughSeen: { joe: true } }),
      ),
    );
    const items = (count: number, state: string, workspace: string, operating: string) =>
      Array.from({ length: count }, () => reviewDeal(state, workspace, operating));
    const parties = Array.from({ length: 12 }, (_, n) => ({ party_id: id(410 + n), state: "open", reviewed: null }));
    const review = [
      ...items(37, "open", "team", "active"),
      ...items(27, "open", "team", "parked"),
      ...items(16, "open", "national_account", "active"),
      ...items(1, "lost", "team", "active"),
      ...parties,
      { party_id: id(430), state: "dropped", reviewed: null },
    ];
    await page.route("**/api/engine/weekly-reviews?week_of=2026-11-23", (route) =>
      route.fulfill({ json: { items: review } }),
    );
    await page.reload();
    const tile = page.getByRole("region", { name: "Deals", exact: true });
    const counts = tile.locator(".home-deals-counts");
    await counts.getByText("37 open").waitFor();
    assert.equal(
      (await counts.textContent())?.replaceAll("\u00a0", " "),
      "37 open · 27 parked · 16 national · 12 prospects",
    );
    assert.ok(
      await counts.evaluate(
        (node) => node.getBoundingClientRect().height < 1.5 * parseFloat(getComputedStyle(node).lineHeight),
      ),
      "the counts are one line",
    );
    assert.ok(await counts.evaluate((node) => node.scrollWidth <= node.clientWidth), "the counts are not clipped");
    assert.equal(
      (await tile.getByRole("link", { name: /^Monday review/ }).textContent())?.replaceAll("\u00a0", " "),
      "Monday review 0 of 94 includes 1 closed or lost and 1 dropped this week",
    );
    assert.ok(
      await tile.evaluate((node) => node.scrollWidth <= node.clientWidth),
      "nothing in Deals runs past the tile",
    );
  });

for (const width of [1440, 500] as const)
  test(`At ${width} each Needs attention reason sits closer to its own deal than to the next`, async (t) => {
    const page = await openHome(t, width, 900);
    const list = page.locator(".home-deals-attention");
    await list.scrollIntoViewIfNeeded();
    const [first, second] = await list.evaluate((ul) =>
      [...ul.querySelectorAll("a")].map((link) => {
        const label = link.firstChild;
        const reason = link.querySelector("span")?.getBoundingClientRect();
        if (!label || !reason) throw Error("a deal line has a name and a reason");
        const name = document.createRange();
        name.selectNodeContents(label);
        const { top, bottom } = name.getBoundingClientRect();
        return { top, bottom, reasonTop: reason.top, reasonBottom: reason.bottom };
      }),
    );
    assert.ok(first && second, "two deals need attention");
    const own = first.reasonTop - first.bottom;
    const next = second.top - first.reasonBottom;
    assert.ok(own < next, `a reason sits ${own}px under its deal and ${next}px above the next deal`);
  });

test("At 1280x640 the attention list and Coming up fold to one line each that opens in place", async (t) => {
  const page = await openHome(t, 1280, 640);
  const tile = page.getByRole("region", { name: "Deals", exact: true });
  assert.equal(
    await tile
      .getByRole("link", { name: /^Example Deal/ })
      .first()
      .isVisible(),
    false,
  );
  await tile.getByRole("button", { name: "2 need attention" }).click();
  await tile.getByRole("link", { name: "Example Deal 2 This deal has no next step and no suggestion." }).waitFor();
  await page.getByRole("button", { name: "Coming up 2 dates in the next 14 days" }).click();
  await page.getByRole("link", { name: /Fri, Nov 27/ }).waitFor();
});

test("At 1280x640 every right-column tile shows whole, and each Leads count keeps to one line", async (t) => {
  const page = await openHome(t, 1280, 640);
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll(".home-side > *")]
      .filter((tile) => tile.scrollHeight > tile.clientHeight)
      .map((tile) => tile.getAttribute("aria-label")),
  );
  assert.deepEqual(clipped, []);
  const parts = page.getByRole("region", { name: "Leads" }).locator(".home-door-detail > span");
  assert.deepEqual(await parts.allTextContents(), ["2 new from email", "1 follow-up late"]);
  for (const part of await parts.all()) {
    const lines = await part.evaluate((node) => node.getClientRects().length);
    assert.equal(lines, 1);
  }
});

test("Crowded Home tiles keep their headings and first rows readable", async (t) => {
  const wrappedTitle =
    "Confirm whether the practice wants the revised lease language, parking instructions, and second-floor buildout scope added to the proposal before the next site visit.";
  const records = Array.from({ length: 42 }, (_, index) => index + 1);
  const dates = records.map((n) => criticalDate(n, today));
  const busyDeals = records.map((n) =>
    deal(n, "Research", { attention: { reason: "A next step is late.", since: "2026-11-23" } }),
  );
  const meetings = records.map((n) => ({ ...sampleMeeting, title: `Sample visit ${n}` }));
  const waiting = records.map((n) =>
    card(700 + n, `Sample waiting item ${n}`, {
      section: "snoozed",
      disposition: "snoozed",
      returns_at: "2026-12-01T15:00:00Z",
      waiting_reason: "Snoozed",
    }),
  );

  const viewports = [
    { width: 1280, height: 599, waitingCount: 42, inboxCount: 42 },
    { width: 1280, height: 599, waitingCount: 42, inboxCount: 1 },
    { width: 1280, height: 599, waitingCount: 1, inboxCount: 42 },
    { width: 1280, height: 640, waitingCount: 1, inboxCount: 42, touch: true },
    { width: 390, height: 844, waitingCount: 42, inboxCount: 42 },
  ];
  for (const { width, height, waitingCount, inboxCount, touch } of viewports) {
    await t.test(`${width}x${height} with ${inboxCount} in Inbox and ${waitingCount} waiting`, async (t) => {
      const page = await openHome(
        t,
        width,
        height,
        [],
        dates,
        {
          ...dashboard,
          reminders: group(records.map((n) => card(500 + n, `Sample reminder ${n}`))),
          inbox: group(
            inboxCount === 1
              ? [reply(601, wrappedTitle)]
              : records.map((n) => reply(600 + n, `Sample inbox item ${n}`)),
          ),
          waiting: group(waiting.slice(0, waitingCount)),
        },
        { schema_version: "lead-counts.v1", new_from_email: 42, follow_ups_late: 42 },
        { deals: busyDeals, meetings, ...(touch ? { touch } : {}) },
      );
      const phone = width === 390;
      const tile = (name: string) => page.getByRole("region", { name, exact: true });
      const comingUp = tile("Coming up");
      if (!phone) {
        const deals = tile("Deals");
        await deals.getByRole("button", { name: "42 need attention" }).click();
        await comingUp.getByRole("button", { name: "Coming up 42 dates in the next 14 days" }).click();
      }

      const tiles = [
        ["Today's meetings", "summary"],
        ["Reminders", "article"],
        ["Inbox", "article"],
        ["Deals", phone ? ".home-deals-counts a" : ".home-deals-attention a"],
        ["Coming up", "li a"],
        ["Leads", ".home-door"],
        ["In motion and waiting", "article"],
      ] as const;
      for (const [name, selector] of tiles) {
        const region = tile(name);
        const heading = region.locator(name === "Leads" ? "strong" : ":scope > header");
        const first = region.locator(selector).first();
        if (phone) await first.evaluate((row) => row.scrollIntoView({ block: "center" }));
        else await region.evaluate((tile) => tile.scrollIntoView({ block: "nearest", behavior: "instant" }));
        const [bounds, head, row, column] = await Promise.all([
          region.boundingBox(),
          heading.boundingBox(),
          first.boundingBox(),
          phone ? null : region.locator("..").boundingBox(),
        ]);
        assert.ok(bounds && head && row, `${name} draws its heading and first row`);
        const visibleTop = Math.max(bounds.y, column?.y ?? 0);
        const visibleBottom = Math.min(bounds.y + bounds.height, column ? column.y + column.height : height);
        assert.ok(head.y >= visibleTop && head.y + head.height <= visibleBottom, `${name} heading fits`);
        assert.ok(row.y >= (name === "Leads" ? visibleTop : head.y + head.height), `${name} row clears the heading`);
        assert.ok(row.y + row.height <= visibleBottom + 1, `${name} first row fits`);
      }

      const viewport = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.scrollingElement?.scrollHeight ?? 0,
      }));
      assert.equal(viewport.width, width, "the page does not scroll sideways");
      if (phone) assert.ok(viewport.height > height, "the stacked phone page scrolls vertically");
      else {
        assert.equal(viewport.height, height, "the desktop page does not scroll");
        await comingUp.locator("li a").last().scrollIntoViewIfNeeded();
        assert.ok(await comingUp.evaluate((region) => region.scrollTop > 0), "dates scroll inside Coming up");
        assert.ok(
          await page.locator("#appMainSlot").evaluate((main) => main.scrollHeight <= main.clientHeight),
          "the main area does not scroll",
        );
      }
      await tile("In motion and waiting").getByRole("link", { name: "Sample waiting item 1", exact: true }).click();
      await tile("Details for Sample waiting item 1").waitFor();
    });
  }

  await t.test("1280x599 touch shows the whole Deals attention button on load", async (t) => {
    const page = await openHome(t, 1280, 599, [], comingUpDates, dashboard, undefined, { touch: true, theme: "light" });
    assert.ok(await page.evaluate(() => matchMedia("(pointer: coarse)").matches));
    assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
    const deals = page.getByRole("region", { name: "Deals", exact: true });
    const attention = deals.getByRole("button", { name: "2 need attention" });
    await attention.waitFor();
    const [tile, button] = await Promise.all([deals.boundingBox(), attention.boundingBox()]);
    assert.ok(tile && button && button.height >= 44, "the attention button has a full touch target");
    assert.ok(
      button.y >= tile.y && button.y + button.height <= tile.y + tile.height,
      "the whole button fits before scrolling",
    );
    await attention.tap();
    const first = deals.getByRole("link", { name: /Example Deal 1 A next step is late/ });
    const [openedTile, row] = await Promise.all([deals.boundingBox(), first.boundingBox()]);
    assert.ok(
      openedTile && row && row.y + row.height <= openedTile.y + openedTile.height,
      "opening the fold exposes the first deal",
    );
  });
});

const busyMeetings = Array.from({ length: 42 }, (_, index) => ({
  ...sampleMeeting,
  title: `Sample visit ${index + 1}`,
}));
const wrappedDeal = deal(1, "Research", {
  name: "Sample practice",
  attention: {
    reason:
      "The practice asked us to confirm the revised lease terms, parking instructions, the second-floor buildout scope, the updated tour schedule, and which documents are needed before the next site visit.",
  },
});

test("At 1280x599 an offline notice fits without scrolling Home's main area", async (t) => {
  const page = await openHome(t, 1280, 599);
  await page.context().setOffline(true);
  const notice = page.getByText("Offline. Showing the last available update.", { exact: true });
  await notice.waitFor();
  const main = page.locator("#appMainSlot");
  const bounds = (await main.boundingBox()) ?? assert.fail("Home's main area is drawn");
  await page.mouse.move(bounds.x + 2, bounds.y + bounds.height - 3);
  await page.mouse.wheel(0, 300);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(
    await main.evaluate((slot) => [scrollY, slot.scrollTop, slot.scrollHeight - slot.clientHeight]),
    [0, 0, 0],
    "the page and main area stay still and fit the viewport",
  );
  const [bar, heading, message] = await Promise.all([
    page.locator("#appTopbar").boundingBox(),
    page.getByRole("heading", { name: /^Reminders/ }).boundingBox(),
    notice.boundingBox(),
  ]);
  assert.ok(bar && heading && message, "the heading and notice are drawn");
  assert.ok(heading.y >= bar.y + bar.height, "the app bar does not cover the heading");
  assert.ok(message.y + message.height <= bounds.y + bounds.height, "the notice stays in the viewport");
});

test("At 1280x599 Tab keeps the Deals phases and their focus rings clear of the closed fold", async (t) => {
  const page = await openHome(t, 1280, 599, [], comingUpDates, dashboard, undefined, {
    meetings: busyMeetings,
  });
  const tile = page.getByRole("region", { name: "Deals", exact: true });
  const phases = tile.locator(".home-phases a");
  await phases.last().waitFor();
  assert.equal(await phases.count(), 7);
  await tile.locator(".home-deals-counts a").focus();
  for (const phase of await phases.all()) {
    await page.keyboard.press("Tab");
    const [result, header, fold, bounds] = await Promise.all([
      phase.evaluate((link) => {
        const css = getComputedStyle(link);
        const { top, bottom, left, right } = link.getBoundingClientRect();
        const outset = Number.parseFloat(css.outlineWidth) + Number.parseFloat(css.outlineOffset);
        return {
          name: link.textContent,
          focused: link.matches(":focus-visible") && css.outlineStyle !== "none",
          outset,
          top,
          bottom,
          left,
          right,
        };
      }),
      tile.locator("header").boundingBox(),
      tile.getByRole("button", { name: "2 need attention" }).boundingBox(),
      tile.boundingBox(),
    ]);
    assert.ok(result.focused && result.outset > 0 && header && fold && bounds, `Tab draws a ring on ${result.name}`);
    assert.ok(result.top - result.outset >= header.y + header.height, `${result.name}'s ring is below the heading`);
    assert.ok(result.bottom + result.outset <= fold.y, `${result.name}'s ring is above the fold`);
    assert.ok(
      result.left - result.outset >= bounds.x && result.right + result.outset <= bounds.x + bounds.width,
      `both sides of ${result.name}'s ring fit`,
    );
  }
});

test("At 1280x599 every phase is a full touch target under the closed Deals fold", async (t) => {
  const page = await openHome(t, 1280, 599, [], comingUpDates, dashboard, undefined, {
    touch: true,
    meetings: busyMeetings,
  });
  const phases = page.getByRole("region", { name: "Deals", exact: true }).locator(".home-phases a");
  await phases.last().waitFor();
  assert.equal(await phases.count(), 7);
  for (const phase of await phases.all()) {
    const hit = await phase.evaluate((link) => {
      link.scrollIntoView({ block: "center", behavior: "instant" });
      const box = link.getBoundingClientRect();
      const x = box.left + box.width / 2;
      return (
        box.height >= 44 && [box.top + 1, box.bottom - 1].every((y) => link.contains(document.elementFromPoint(x, y)))
      );
    });
    assert.ok(hit, `Both edges of ${await phase.textContent()} are tappable`);
  }
});

test("At 1280x599 opening Deals attention shows both edges of a wrapped result", async (t) => {
  const page = await openHome(t, 1280, 599, [], comingUpDates, dashboard, undefined, {
    touch: true,
    deals: [wrappedDeal],
    meetings: busyMeetings,
  });
  const tile = page.getByRole("region", { name: "Deals", exact: true });
  await tile.getByRole("button", { name: "1 needs attention" }).tap();
  const result = tile.getByRole("link", { name: /Sample practice The practice asked/ });
  const [row, head, bounds] = await Promise.all([
    result.boundingBox(),
    tile.locator("header").boundingBox(),
    tile.boundingBox(),
  ]);
  assert.ok(row && head && bounds && row.height > 100, "the result wraps");
  assert.ok(
    row.y >= head.y + head.height && row.y + row.height <= Math.min(bounds.y + bounds.height, 599),
    "the complete result fits under the heading",
  );
});

test("At 1280x599 Deals refits wrapped counts after a late font load", async (t) => {
  const page = await openHome(t, 1280, 599, [], comingUpDates, dashboard, undefined, {
    touch: true,
    meetings: busyMeetings,
  });
  const tile = page.getByRole("region", { name: "Deals", exact: true });
  const counts = tile.locator(".home-deals-counts");
  const loops: string[] = [];
  page.on("pageerror", (error) => {
    if (error.message.includes("ResizeObserver loop")) loops.push(error.message);
  });
  const fold = tile.getByRole("button", { name: "2 need attention" });
  await fold.waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const before = (await counts.boundingBox()) ?? assert.fail("Deal counts are drawn");
  await page.addStyleTag({
    content: `
    @font-face { font-family: HomeCountsTest; src: local("Arial"), local("Liberation Sans"), local("DejaVu Sans"); size-adjust: 250%; }
    .home-deals-counts { font-family: HomeCountsTest, sans-serif; }
  `,
  });
  await page.evaluate(async () => {
    await document.fonts.load("12px HomeCountsTest");
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const [after, button, bounds, minimum] = await Promise.all([
    counts.boundingBox(),
    fold.boundingBox(),
    tile.boundingBox(),
    tile.evaluate((region) => Number.parseFloat(getComputedStyle(region).minBlockSize)),
  ]);
  assert.ok(after && button && bounds && after.height > before.height, "the loaded font wraps the counts");
  assert.ok(
    minimum >= after.y + after.height - bounds.y + button.height,
    "the tile reserves space for the wrapped counts and fold",
  );
  assert.ok(after.y + after.height <= button.y, "the fold stays below the wrapped counts");
  assert.deepEqual(loops, [], "refitting the column does not cause a resize loop");
});

test("At 1280x599 wheel and touch carry from a finished tile to Leads", async (t) => {
  const dates = Array.from({ length: 42 }, (_, index) => criticalDate(index + 1, today));
  for (const touch of [false, true]) {
    await t.test(touch ? "touch swipe" : "mouse wheel", async (t) => {
      const page = await openHome(t, 1280, 599, [], dates, dashboard, undefined, {
        touch,
        deals: [wrappedDeal],
        meetings: busyMeetings,
      });
      await page.getByRole("button", { name: "Coming up 42 dates in the next 14 days" }).click();
      await page.getByRole("button", { name: "1 needs attention" }).click();
      const meetings = page.getByRole("region", { name: "Today's meetings", exact: true });
      const column = page.locator(".home-side");
      const leads = page.getByRole("region", { name: "Leads", exact: true }).locator("strong");
      await column.evaluate((region) => {
        region.scrollTop = 0;
      });
      await meetings.evaluate((tile) => {
        tile.scrollTop = tile.scrollHeight;
      });
      const [list, right, heading] = await Promise.all([
        meetings.boundingBox(),
        column.boundingBox(),
        leads.boundingBox(),
      ]);
      assert.ok(
        list && right && heading && heading.y + heading.height > right.y + right.height,
        "Leads starts below the column viewport",
      );
      assert.ok(
        await meetings.evaluate(
          (tile) => tile.scrollTop > 0 && Math.abs(tile.scrollHeight - tile.clientHeight - tile.scrollTop) <= 1,
        ),
        "the input starts at the tile's lower limit",
      );
      const x = Math.round(list.x + list.width / 2);
      const y = Math.round(list.y + list.height - 8);
      if (touch) {
        const input = await page.context().newCDPSession(page);
        await input.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        for (const offset of [30, 75, 125])
          await input.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - offset }] });
        await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else {
        await page.mouse.move(x, y);
        await page.mouse.wheel(0, 600);
      }
      await page.waitForFunction(() => {
        const column = document.querySelector(".home-side");
        const heading = column?.querySelector('[aria-label="Leads"] strong');
        if (!column?.scrollTop || !heading) return false;
        const visible = column.getBoundingClientRect();
        const label = heading.getBoundingClientRect();
        return label.top >= visible.top && label.bottom <= visible.bottom;
      });
      assert.deepEqual(
        await page.evaluate(() => [scrollY, document.querySelector("#appMainSlot")?.scrollTop]),
        [0, 0],
        "the page stays put",
      );
    });
  }
});

test("Crowded touch columns keep every tile heading reachable at 599, 640 and 900", async (t) => {
  for (const height of [599, 640, 900]) {
    await t.test(`1280x${height}`, async (t) => {
      const dates = Array.from({ length: 42 }, (_, index) => criticalDate(index + 1, today));
      const page = await openHome(t, 1280, height, [], dates, dashboard, undefined, {
        touch: true,
        deals: [wrappedDeal],
        meetings: busyMeetings,
      });
      if (height < 900) {
        await page.getByRole("button", { name: "Coming up 42 dates in the next 14 days" }).tap();
        await page.getByRole("button", { name: "1 needs attention" }).tap();
        const right = page.locator(".home-side");
        assert.ok(
          await right.evaluate((column) => column.scrollHeight > column.clientHeight),
          "the column scrolls when the previews cannot fit",
        );
      }
      for (const name of [
        "Reminders",
        "Inbox",
        "In motion and waiting",
        "Today's meetings",
        "Deals",
        "Coming up",
        "Leads",
      ]) {
        const tile = page.getByRole("region", { name, exact: true });
        const heading = tile.locator(name === "Leads" ? "strong" : "header h2");
        await tile.evaluate((region) => region.scrollIntoView({ block: "start", behavior: "instant" }));
        const box = (await heading.boundingBox()) ?? assert.fail(`${name} draws a heading`);
        assert.ok(box.y >= 0 && box.y + box.height <= height, `${name} heading is reachable`);
      }
      assert.equal(
        await page.evaluate(() => document.scrollingElement?.scrollHeight),
        height,
        "the page itself does not scroll",
      );
    });
  }
});

test("At 1280x599 every control in the scrolling column stays visible in both Tab directions", async (t) => {
  const dates = Array.from({ length: 42 }, (_, index) => criticalDate(index + 1, today));
  for (const touch of [false, true]) {
    await t.test(touch ? "touch layout" : "pointer layout", async (t) => {
      const page = await openHome(t, 1280, 599, [], dates, dashboard, undefined, {
        touch,
        deals: [wrappedDeal],
        meetings: busyMeetings,
      });
      await page.context().setOffline(true);
      await page.getByText("Offline. Showing the last available update.", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Coming up 42 dates in the next 14 days" }).click();
      await page.getByRole("button", { name: "1 needs attention" }).click();
      const column = page.locator(".home-side");
      assert.ok(await column.evaluate((region) => region.scrollHeight > region.clientHeight));
      const controls = await column.locator("a[href]:visible, button:enabled:visible, summary:visible").all();
      const leads = controls.at(-1) ?? assert.fail("Leads is the last control");
      assert.equal(await leads.getAttribute("href"), "/leads");
      await leads.focus();

      for (const [key, targets] of [
        ["Shift+Tab", controls.slice(0, -1).reverse()],
        ["Tab", controls.slice(1)],
      ] as const) {
        for (const target of targets) {
          await page.keyboard.press(key);
          const result = await target.evaluate(async (control) => {
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const region = control.closest(".home-column");
            if (!region) throw Error("Missing Home column");
            const visible = region.getBoundingClientRect();
            const { top, bottom, left, right } = control.getBoundingClientRect();
            const edgeTop = visible.top + region.clientTop;
            const edgeLeft = visible.left + region.clientLeft;
            return {
              label: control.textContent?.trim(),
              focused: document.activeElement === control,
              clipped: Math.max(
                edgeTop - top,
                bottom - (edgeTop + region.clientHeight),
                edgeLeft - left,
                right - (edgeLeft + region.clientWidth),
              ),
            };
          });
          assert.ok(result.focused, `${key} focuses ${result.label}`);
          assert.ok(result.clipped <= 0.5, `${key} clips ${result.label} by ${result.clipped}px`);
        }
      }
      assert.deepEqual(
        await page.evaluate(() => [scrollY, document.querySelector("#appMainSlot")?.scrollTop]),
        [0, 0],
        "the page and main area stay put",
      );
    });
  }
});

async function assertHomePreview(tile: Locator, label: string, ...selectors: string[]) {
  const { clipped, height } = await tile.evaluate((node, selectors) => {
    node.scrollIntoView({ block: "start", behavior: "instant" });
    const bounds = node.getBoundingClientRect();
    const parent = node.closest(".home-column, #appMainSlot");
    if (!parent) throw Error("Missing Home layout");
    const column = parent.getBoundingClientRect();
    const top = Math.max(bounds.top, column.top + parent.clientTop);
    const bottom = Math.min(bounds.bottom, column.top + parent.clientTop + parent.clientHeight);
    const parts = selectors.length ? selectors.map((selector) => node.querySelector(selector)) : [node];
    const clipped = parts.map((part, index) => {
      const box = part?.getBoundingClientRect();
      if (!box?.height || !part) return `${selectors[index]} is missing`;
      const cut = Math.max(top - box.top, box.bottom - bottom, part.scrollHeight - part.clientHeight);
      return cut > 0.5 ? `${selectors[index] ?? "notice"} is clipped by ${cut}px` : null;
    });
    return { clipped: clipped.filter(Boolean), height: bounds.height };
  }, selectors);
  assert.equal(clipped.length, 0, `${label} (${height}px): ${clipped.join(", ")}`);
}

test("Home protects each rendered tile preview as reads change state", async (t) => {
  const dates = Array.from({ length: 42 }, (_, index) => criticalDate(index + 1, today));
  const attentionDeals = Array.from({ length: 42 }, (_, index) =>
    deal(index + 1, "Research", { attention: { reason: "A next step is late." } }),
  );
  const crowded = {
    ...dashboard,
    reminders: group(dates.map((_, index) => card(600 + index, `Sample reminder ${index + 1}`))),
    inbox: group(dates.map((_, index) => reply(700 + index, `Sample Inbox item ${index + 1}`))),
    waiting: group(
      dates.map((_, index) =>
        card(800 + index, `Sample waiting item ${index + 1}`, {
          section: "snoozed",
          disposition: "snoozed",
          returns_at: "2026-12-01T15:00:00Z",
          waiting_reason: "Snoozed",
        }),
      ),
    ),
  };
  const todayPath = "**/api/engine/home/today";
  const emptyReads = [
    [todayPath, { ok: true, schema_version: "home-today.v1", today, meetings: { state: "empty", items: [] } }],
    [
      "**/api/engine/home/inbox?view=dashboard&contract=home-inbox.v6",
      { ...dashboard, reminders: group([]), inbox: group([]), waiting: group([]) },
    ],
    ["**/api/engine/weekly-reviews?week_of=2026-11-23", { items: [] }],
    ["**/api/engine/calendar/critical-dates", { schema_version: "calendar-critical-dates.v1", critical_dates: [] }],
    ["**/api/engine/leads/counts", { schema_version: "lead-counts.v1", new_from_email: 0, follow_ups_late: 0 }],
  ] as const;
  const tiles = [
    ["Reminders", "article"],
    ["Inbox", "article"],
    ["In motion and waiting", "article"],
    ["Today's meetings", "summary"],
    ["Deals", ".home-deals-counts"],
    ["Coming up", "li"],
    ["Leads", ".home-door"],
  ] as const;

  for (const height of [599, 640, 900]) {
    for (const touch of [false, true]) {
      await t.test(`1280x${height} ${touch ? "touch" : "pointer"}`, async (t) => {
        const todayRead = Promise.withResolvers<void>();
        const holds = new Map([[todayPath, todayRead.promise]]);
        let response: "fixture" | "failed" | "empty" = "fixture";
        const page = await openHome(t, 1280, height, [], dates, crowded, undefined, {
          touch,
          deals: attentionDeals,
          meetings: busyMeetings,
          waitForReady: false,
          beforeLoad: async (page) => {
            for (const [path, json] of emptyReads) {
              await page.route(path, async (route) => {
                if (response === "failed") return route.fulfill({ status: 503 });
                if (response === "empty") return route.fulfill({ json });
                await holds.get(path);
                return route.fallback();
              });
            }
          },
        });
        const tile = (name: string) => page.getByRole("region", { name, exact: true });
        const notice = (text: string) => page.getByText(text, { exact: true });
        const skeletons = page.locator(".home-column > .home-placeholder");
        const short = height < 900;
        const attention = tile("Deals").getByRole("button", { name: "42 need attention" });
        const datesFold = tile("Coming up").getByRole("button", { name: "Coming up 42 dates in the next 14 days" });
        async function openFolds() {
          if (!short) return;
          await attention.click();
          await datesFold.click();
        }
        try {
          await tile("Leads").waitFor();
          await openFolds();
          await tile("Deals").locator(".home-deals-attention li").first().waitFor();
          await tile("Coming up").waitFor();
          await assertHomePreview(
            page.locator(".home-side > .home-placeholder"),
            "Meetings skeleton",
            "header",
            ".home-placeholder-row",
          );
        } finally {
          todayRead.resolve();
        }
        for (const offline of [false, true]) {
          if (offline) {
            await page.context().setOffline(true);
            await assertHomePreview(notice("Offline. Showing the last available update."), "Offline notice");
          }
          for (const [name, row] of tiles) {
            const preview = short && name === "Deals" ? ".home-deals-attention li" : row;
            const parts = name === "Leads" ? [preview] : ["header", preview];
            if (short && (name === "Deals" || name === "Coming up")) parts.push(".home-short-fold-line");
            await assertHomePreview(tile(name), name, ...parts);
          }
        }
        await page.context().setOffline(false);
        if (short) {
          await attention.click();
          await datesFold.click();
          await tile("Deals").evaluate((node) => {
            node.scrollTop = 0;
          });
          await assertHomePreview(
            tile("Deals"),
            "Closed Deals",
            "header",
            ".home-deals-counts",
            ".home-short-fold-line",
          );
          await assertHomePreview(tile("Coming up"), "Closed Coming up", ".home-short-fold-line");
        }
        assert.deepEqual(
          await page.evaluate(() => [scrollY, document.querySelector("#appMainSlot")?.scrollTop]),
          [0, 0],
        );

        const toursPath = "**/api/engine/calendar/meetings?*";
        await page.route(toursPath, (route) => route.fulfill({ status: 503 }));
        await page.reload();
        await notice("Tours unavailable.").waitFor();
        await openFolds();
        await assertHomePreview(
          tile("Today's meetings"),
          "Meetings with tours unavailable",
          "header",
          "[role=status]",
          "summary",
        );
        await page.unroute(toursPath);

        const otherReads = Promise.withResolvers<void>();
        for (const [path] of emptyReads) if (path !== todayPath) holds.set(path, otherReads.promise);
        try {
          await page.reload();
          await tile("Today's meetings").waitFor();
          assert.equal(await tile("Leads").count(), 0, "Leads is omitted until its counts arrive");
          const loading = await skeletons.all();
          assert.equal(loading.length, 4, "Reminders, Inbox, Deals and Coming up show loading previews");
          for (const skeleton of loading)
            await assertHomePreview(skeleton, "Loading tile", "header", ".home-placeholder-row");
        } finally {
          otherReads.resolve();
        }
        await tile("Leads").waitFor();

        response = "failed";
        await page.reload();
        await assertHomePreview(
          page.getByRole("alert").filter({ hasText: "Reminders and Inbox unavailable" }),
          "Inbox read failure",
          "h2",
          "p",
          "button",
        );
        for (const text of ["Meetings unavailable.", "Deals unavailable.", "Coming up unavailable."])
          await assertHomePreview(notice(text), text);
        await assertHomePreview(tile("Leads"), "Leads read failure", ".home-door", ".home-door-detail");
        assert.equal(await notice("Lead counts unavailable").count(), 1);

        response = "empty";
        await page.reload();
        await page.locator(".home-sections").waitFor({ state: "attached" });
        await page.waitForFunction(
          () => !document.querySelector(".home-placeholder, .home-tile-status, .home-read-status"),
        );
        for (const [name] of tiles) assert.equal(await tile(name).count(), 0, `${name} is omitted when empty`);
      });
    }
  }
});

test("At 1280x599 failed-read notices are readable beside expanded lists", async (t) => {
  const dates = Array.from({ length: 42 }, (_, index) => criticalDate(index + 1, today));
  const attentionDeals = Array.from({ length: 42 }, (_, index) =>
    deal(index + 1, "Research", { attention: { reason: "A next step is late." } }),
  );
  for (const [failedRead, notice, fold] of [
    ["weekly review", "Deals unavailable.", "Coming up 42 dates in the next 14 days"],
    ["critical dates", "Coming up unavailable.", "42 need attention"],
  ] as const) {
    await t.test(notice, async (t) => {
      const page = await openHome(t, 1280, 599, [], dates, dashboard, undefined, {
        failedRead,
        meetings: busyMeetings,
        deals: attentionDeals,
      });
      await page.getByRole("button", { name: fold, exact: true }).click();
      const status = page.getByText(notice, { exact: true });
      await status.evaluate((node) => node.scrollIntoView({ block: "center", behavior: "instant" }));
      const { height, contentHeight, clippedByColumn } = await status.evaluate((node) => {
        const column = node.closest(".home-column");
        if (!column) throw Error("Missing Home column");
        const { top, bottom } = node.getBoundingClientRect();
        const columnTop = column.getBoundingClientRect().top + column.clientTop;
        return {
          height: node.clientHeight,
          contentHeight: node.scrollHeight,
          clippedByColumn: Math.max(columnTop - top, bottom - (columnTop + column.clientHeight)),
        };
      });
      assert.ok(height >= contentHeight, `${notice} shows only ${height}px of ${contentHeight}px`);
      assert.ok(clippedByColumn <= 0.5, `${notice} fits inside the column`);
    });
  }
});

test("Coming up is not drawn when no open deal has a date in the next 14 days", async (t) => {
  const page = await openHome(
    t,
    1440,
    900,
    [],
    [criticalDate(4, "2026-12-10"), { ...criticalDate(5, today), done: true }],
  );
  assert.equal(await page.getByRole("region", { name: "Coming up", exact: true }).count(), 0);
  assert.equal(await page.getByText("Coming up").count(), 0);
});

for (const [width, height] of [
  [1440, 900],
  [1280, 640],
] as const)
  test(`At ${width}x${height} a long reminder stays two lines on the list and shows its full instruction when opened`, async (t) => {
    const page = await openHome(t, width, height);
    const shortRow = page.getByRole("region", { name: "Today", exact: true }).getByRole("article");
    const row = page.getByRole("region", { name: "No date", exact: true }).getByRole("article");
    const title = row.getByRole("heading", { level: 3 });
    const caption = row.locator(".inbox-why");
    assert.equal(await title.textContent(), longTitle);
    assert.equal(await caption.textContent(), "Example Dental");
    assert.ok(
      await title.evaluate(
        (node) => node.getBoundingClientRect().height < 1.5 * parseFloat(getComputedStyle(node).lineHeight),
      ),
      "the action heading stays on one line",
    );
    assert.ok(
      await caption.evaluate(
        (node) => node.getBoundingClientRect().height < 1.5 * parseFloat(getComputedStyle(node).lineHeight),
      ),
      "the second line stays on one line",
    );
    const shortBox = (await shortRow.boundingBox()) ?? assert.fail("short row is not drawn");
    const longBox = (await row.boundingBox()) ?? assert.fail("long row is not drawn");
    assert.ok(
      Math.abs(longBox.height - shortBox.height) <= 2,
      `long row height ${longBox.height}px matches a two-line row ${shortBox.height}px`,
    );
    assert.equal(
      await page.evaluate(() => document.scrollingElement?.scrollHeight),
      height,
      "the page does not scroll",
    );
    assert.ok(
      await title.evaluate((node) => {
        const text = node.textContent ?? "";
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const top = node.getBoundingClientRect().top;
        let seen = 0;
        let lastOnLine = -1;
        for (let text_node = walker.nextNode(); text_node; text_node = walker.nextNode()) {
          const range = document.createRange();
          for (let at = 0; at < (text_node.textContent ?? "").length; at += 1) {
            range.setStart(text_node, at);
            range.setEnd(text_node, at + 1);
            const rect = range.getBoundingClientRect();
            if (rect.width > 0 && rect.top < top + 4) lastOnLine = seen + at;
          }
          seen += (text_node.textContent ?? "").length;
        }
        return lastOnLine >= 0 && lastOnLine < text.length - 1 && /\s/.test(text.slice(lastOnLine, lastOnLine + 2));
      }),
      "the heading is cut between whole words",
    );
    await row.getByRole("link", { name: longTitle }).click();
    const details = page.getByRole("region", { name: `Details for ${longTitle}` });
    await details.waitFor();
    await details.getByText(longInstruction, { exact: true }).waitFor();
    assert.equal(await title.evaluate((node) => node.scrollLeft), 0, "opening the row does not scroll its heading");
    const close = details.getByRole("button", { name: /^Close/ });
    assert.ok(
      await close.evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getClientRects().length === 1;
      }),
      "Close stays on one line",
    );
  });

for (const [width, height] of [
  [1440, 900],
  [1280, 640],
] as const)
  test(`At ${width}x${height} three copies of a long reminder show once as two lines and open with every covered name`, async (t) => {
    const names = ["Maya Example", "Sam Example", "Lee Example"];
    const grouped = card(50, longTitle, {
      context_label: names[0],
      why: longInstruction,
      merged_source_ids: [id(50), id(51), id(52)],
      covers: names.map((record_name, index) => ({
        item_id: `next_action:${id(50 + index)}`,
        base_version: "1:0:inbox",
        action_id: id(50 + index),
        action_version: 1,
        record_name,
      })),
    });
    const page = await openHome(t, width, height, [], comingUpDates, {
      ...dashboard,
      reminders: group([...dashboard.reminders.items, grouped]),
    });
    const noDate = page.getByRole("region", { name: "No date", exact: true });
    const row = noDate.getByRole("article").filter({ hasText: "Covers 3 reminders" });
    assert.equal(await row.count(), 1);
    const title = row.getByRole("heading", { level: 3 });
    const caption = row.locator(".inbox-why");
    assert.equal(await title.textContent(), longTitle);
    assert.equal(await caption.textContent(), "Covers 3 reminders · Maya Example, Sam Example and Lee Example");
    assert.ok(
      await title.evaluate(
        (node) => node.getBoundingClientRect().height < 1.5 * parseFloat(getComputedStyle(node).lineHeight),
      ),
      "grouped action heading stays on one line",
    );
    await row.getByRole("link", { name: longTitle }).click();
    const details = page.getByRole("region", { name: `Details for ${longTitle}` });
    await details.waitFor();
    await details.getByText(longInstruction, { exact: true }).waitFor();
    await details.getByText("Covers 3 reminders · Maya Example, Sam Example, Lee Example", { exact: true }).waitFor();
  });

test("An opened Inbox item shows beside Reminders over the middle and right columns, and Close brings them back", async (t) => {
  const page = await openHome(t, 1440, 900);
  const reminders = page.getByRole("region", { name: "Reminders", exact: true });
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await inbox.getByRole("link", { name: "Send your reply to the sample practice" }).click();
  const details = page.getByRole("region", { name: "Details for Send your reply to the sample practice" });
  await details.waitFor();
  const left = (await reminders.boundingBox()) ?? assert.fail("Reminders left the screen");
  const pane = (await details.boundingBox()) ?? assert.fail("the item is not drawn");
  assert.ok(pane.x >= left.x + left.width, "the item opens right of Reminders");
  assert.ok(pane.x + pane.width > 1300, "the item spans the right columns");
  assert.equal(await page.getByRole("region", { name: "Deals", exact: true }).isVisible(), false);
  await details.getByRole("button", { name: /^Close/ }).click();
  await inbox.waitFor();
  assert.equal(await details.count(), 0);
});

for (const [kind, fields] of [
  [
    "a vendor check-in",
    {
      title: "Check in with Sample Signs",
      context_label: "Sample Signs",
      open_url: `/relationships?node=party:${id(600)}&focus=next-step`,
      deal_id: null,
      record: `/relationships?node=party:${id(600)}&focus=next-step`,
    },
  ],
  [
    "a deal's next step",
    { title: "Send the sample site plan", record: `/deals?deal=${id(99)}&focus=next-step&step=${id(30)}` },
  ],
  [
    "a checklist item",
    {
      title: "Order the sample survey",
      primary_action: "Open checklist item",
      checklist_item_ref: `deal-item:${id(601)}`,
      record: `/deals?deal=${id(99)}&item=${id(601)}`,
    },
  ],
] as const)
  test(`Clicking ${kind} in Reminders opens it beside the list with a link to its record, never another page`, async (t) => {
    const reminder = card(30, fields.title, fields);
    const page = await openHome(t, 1440, 900, [], comingUpDates, {
      ...dashboard,
      reminders: group([...dashboard.reminders.items, reminder]),
    });
    const home = page.url();
    await page
      .getByRole("region", { name: "Reminders", exact: true })
      .getByRole("link", { name: fields.title })
      .click();
    const details = page.getByRole("region", { name: `Details for ${fields.title}` });
    await details.waitFor();
    assert.equal(new URL(page.url()).pathname, new URL(home).pathname, "Home stays on screen");
    const left = (await page.getByRole("region", { name: "Reminders", exact: true }).boundingBox()) ?? assert.fail();
    assert.ok(((await details.boundingBox()) ?? assert.fail()).x >= left.x + left.width, "it opens right of Reminders");
    const links = await details
      .locator("a.inbox-source")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
    assert.ok(links.includes(fields.record), `the pane links to ${fields.record}, not ${links}`);
  });

test("An opened reminder has its own Mark done, which saves it as the row's circle does", async (t) => {
  const page = await openHome(t, 1440, 900);
  const reminders = page.getByRole("region", { name: "Reminders", exact: true });
  assert.equal(await reminders.locator("button.home-done").first().isEnabled(), true, "the circle works while closed");
  await reminders.getByRole("link", { name: "Call the sample practice" }).click();
  const details = page.getByRole("region", { name: "Details for Call the sample practice" });
  const saved = page.waitForRequest((request) => request.method() === "POST" && !!request.postData()?.includes(id(1)));
  await details.getByRole("button", { name: "Mark done", exact: true }).click();
  await saved;
});

test("On a phone an opened item covers the screen, and Back returns to the list where it was", async (t) => {
  const page = await openHome(t, 390, 844);
  const title = page
    .getByRole("region", { name: "Reminders", exact: true })
    .getByRole("link", { name: "Call the sample practice" });
  await title.scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollBy(0, 120));
  const scrolled = await page.evaluate(() => scrollY);
  assert.ok(scrolled > 0, "the list is scrolled");
  await title.click();
  const details = page.getByRole("region", { name: "Details for Call the sample practice" });
  await details.waitFor();
  const tabs = (await page.locator("#appShell").boundingBox()) ?? assert.fail("the tab bar is not drawn");
  assert.deepEqual(
    await details.boundingBox(),
    { x: 0, y: 0, width: 390, height: tabs.y },
    "the item covers the screen above the tab bar",
  );
  await details.getByRole("button", { name: "Back", exact: true }).click();
  assert.equal(await details.count(), 0);
  assert.equal(await page.evaluate(() => scrollY), scrolled, "the list is where it was");
});

test("Escape closes an opened Inbox item and focus returns to its row", async (t) => {
  const page = await openHome(t, 1440, 900);
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await inbox.getByRole("link", { name: "Send your reply to the sample practice" }).click();
  const details = page.getByRole("region", { name: "Details for Send your reply to the sample practice" });
  await details.waitFor();
  await page.mouse.click(5, 5);
  await page.keyboard.press("Escape");
  await inbox.waitFor();
  assert.equal(await details.count(), 0);
  const focused = await page.evaluate(() => {
    const active = document.activeElement;
    return { tag: active?.tagName, row: active?.closest("[data-inbox-row]")?.textContent ?? null };
  });
  assert.match(focused.row ?? "", /Send your reply to the sample practice/, "focus is back on its row");
});

test("In light mode at 1440x900 Home and an opened item draw light grounds with readable text", async (t) => {
  const page = await openHome(t, 1440, 900);
  await page.addInitScript(() =>
    localStorage.setItem(
      "doctorcre.visual-preferences",
      JSON.stringify({ theme: "light", walkthroughSeen: { joe: true } }),
    ),
  );
  await page.reload();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await inbox.getByRole("link", { name: "Send your reply to the sample practice" }).click();
  const details = page.getByRole("region", { name: "Details for Send your reply to the sample practice" });
  await details.waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  const drawn = await details.evaluate((node) => {
    const channels = (color: string) => (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = (color: string) => {
      const [r = 0, g = 0, b = 0] = channels(color).map((value) => {
        const unit = value / 255;
        return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ground = getComputedStyle(document.body).backgroundColor;
    const heading = getComputedStyle(node.querySelector("h4") ?? node).color;
    const [light, dark] = [luminance(ground), luminance(heading)].sort((a, b) => b - a);
    return { ground: luminance(ground), contrast: ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05) };
  });
  assert.ok(drawn.ground > 0.5, `the page ground is light, not ${drawn.ground}`);
  assert.ok(drawn.contrast >= 4.5, `the item heading reads at ${drawn.contrast}:1`);
  await page.screenshot({ path: join(process.cwd(), "node_modules/.cache/home-light-1440.png") });
});

test("On a phone the Inbox previews its first rows with See all, like Reminders", async (t) => {
  const inboxRows = [1, 2, 3, 4, 5, 6].map((n) => reply(30 + n, `Send your reply to sample practice ${n}`));
  const page = await openHome(t, 390, 844, [], comingUpDates, { ...dashboard, inbox: group(inboxRows) });
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await inbox.getByRole("button", { name: "See all 6" }).waitFor();
  assert.equal(await inbox.getByRole("article").count(), 4);
  await inbox.getByRole("button", { name: "See all 6" }).click();
  assert.equal(await inbox.getByRole("article").count(), 6);
});

for (const [width, height] of [
  [1024, 768],
  [1236, 772],
] as const)
  test(`At ${width}x${height} Home stacks while the walkthrough takes room beside the rail, and takes its three columns back after`, async (t) => {
    const inboxRows = [1, 2, 3, 4, 5, 6].map((n) => reply(30 + n, `Send your reply to sample practice ${n}`));
    const page = await openHome(t, width, height, [], comingUpDates, { ...dashboard, inbox: group(inboxRows) });
    await page.getByRole("region", { name: "Deals", exact: true }).waitFor();
    const layout = () =>
      page.evaluate(() => {
        const tiles = [...document.querySelectorAll(".home-slice")];
        return {
          lefts: new Set(tiles.map((tile) => Math.round(tile.getBoundingClientRect().left))).size,
          overflowing: tiles.filter((tile) => tile.scrollWidth > tile.clientWidth).map((tile) => tile.ariaLabel),
        };
      });
    const seeAll = page.getByRole("region", { name: "Inbox", exact: true }).getByRole("button", { name: "See all 6" });
    assert.deepEqual(await layout(), { lefts: 3, overflowing: [] }, "three columns before the walkthrough");
    await page.locator("#selfAvatar").click();
    await page.getByRole("button", { name: "How DoctorCRE works", exact: true }).click();
    await seeAll.waitFor();
    assert.deepEqual(
      await layout(),
      { lefts: 1, overflowing: [] },
      "one column with no tile cut off beside the walkthrough",
    );
    await page.keyboard.press("Escape");
    await seeAll.waitFor({ state: "detached" });
    assert.deepEqual(await layout(), { lefts: 3, overflowing: [] }, "three columns again after the walkthrough");
  });
