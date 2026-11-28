import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page, Route } from "playwright";
import { inspectPhoneAccessibility } from "../scripts/phone-accessibility.ts";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const added = "00000000-0000-4000-8000-000000000777";
const other = "00000000-0000-4000-8000-000000000888";
const firstClient = "00000000-0000-4000-8000-000000000001";
const vendor = firstClient;
type Sent = { method: string; path: string; body: Record<string, unknown> | null };
type Answer = { status: number; json: unknown };

async function setup(
  t: import("node:test").TestContext,
  path: string,
  answer: (sent: Sent) => Answer | Promise<Answer>,
  {
    width = 1440,
    theme = "dark",
    engineSwitch = true,
    holdList = false,
    record = {},
    facets = {},
    activity,
    reread,
    rereadRecord = {},
  }: {
    width?: number;
    theme?: "dark" | "light";
    engineSwitch?: boolean;
    // The list read, and the filter choices it carries, never arrives.
    holdList?: boolean;
    // Fields the record read adds, as a newer engine would.
    record?: Record<string, unknown> | (() => Record<string, unknown>);
    // Filter choices the list read adds.
    facets?: Record<string, unknown>;
    // The record's activity answers once this settles.
    activity?: Promise<void>;
    // A second read of the record answers once this settles.
    reread?: Promise<void>;
    // Fields the record's second read changes, as the engine answers after a save.
    rereadRecord?: Record<string, unknown>;
  } = {},
) {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 844 }, colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(
    (theme) => localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme })),
    theme,
  );
  const sent: Sent[] = [];
  await page.route("https://**", (route) => route.abort());
  // A record added in the test is outside the synthetic directory, so its drawer reads as not found.
  const listHeld = new Promise<void>((release) => t.after(() => release()));
  let recordReads = 0;
  await page.route("**/api/v1/business/**", async (route) => {
    const url = new URL(route.request().url());
    const isList = url.pathname.split("/").length === 5;
    if (holdList && isList) return listHeld.then(() => route.abort());
    if (!isList && ++recordReads > 1) await reread;
    try {
      const json = directoryFixture(url.href);
      return route.fulfill({
        json: isList
          ? { ...json, facets: Object.assign({}, json.facets, facets) }
          : {
              ...json,
              record: Object.assign(
                {},
                json.record,
                typeof record === "function" ? record() : record,
                recordReads > 1 ? rereadRecord : {},
              ),
            },
      });
    } catch {
      return route.fulfill({ status: 404, json: { error: "RECORD_NOT_FOUND" } });
    }
  });
  await page.route("**/mcp", async (route) => {
    await activity;
    return route.fulfill({
      json: {
        jsonrpc: "2.0",
        id: route.request().postDataJSON()?.id,
        result: { content: [{ type: "text", text: "{}" }] },
      },
    });
  });
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
  );
  await page.route("**/api/engine/**", async (route: Route) => {
    const request = route.request();
    const call = {
      method: request.method(),
      path: new URL(request.url()).pathname + new URL(request.url()).search,
      body: request.postDataJSON(),
    };
    sent.push(call);
    const { status, json } = await answer(call);
    return route.fulfill({ status, json });
  });
  await page.route(
    (url) => url.pathname === "/clients" || url.pathname === "/vendors",
    async (route) => {
      const response = await route.fetch();
      const html = await response.text();
      return route.fulfill({
        response,
        body: engineSwitch ? html.replace("<html ", "<html data-clients-vendors-from-engine ") : html,
      });
    },
  );
  // A local host opts into the live client explicitly.
  await page.goto(`${server.url}${path}${path.includes("?") ? "&" : "?"}mode=live`);
  return { page, sent };
}

const posts = (sent: Sent[]) => sent.filter((call) => call.method === "POST");
const withoutKey = ({ idempotency_key, ...body }: Record<string, unknown>) => {
  assert.match(String(idempotency_key), /^[0-9a-f-]{36}$/);
  return body;
};

// The page under the modal dialog is checked by the phone accessibility walk; this checks the dialog.
async function assertTargets(page: Page, label: string) {
  const observed = await inspectPhoneAccessibility(page);
  const inDialog = (targets: { selector: string }[]) => targets.filter((target) => target.selector.includes("dialog"));
  assert.equal(observed.overflow, false, `${label}: no sideways scroll`);
  assert.deepEqual(inDialog(observed.small), [], `${label}: every control is at least 44 by 44`);
  assert.deepEqual(inDialog(observed.covered), [], `${label}: every control is reachable`);
  assert.deepEqual(observed.violations, [], `${label}: no accessibility violations`);
}

const themes: ("light" | "dark")[] = ["light", "dark"];
for (const theme of themes)
  test(`New client offers a likely duplicate, then saves a separate record at 390 px in ${theme}`, async (t) => {
    const { page, sent } = await setup(
      t,
      "/clients",
      ({ path, body }) => {
        if (path === "/api/engine/parties" && !body?.force_new)
          return {
            status: 409,
            json: {
              error: "party_exists",
              candidates: [{ id: other, name: "Example Smile Studio", city: "Demo City" }],
            },
          };
        if (path === "/api/engine/parties")
          return { status: 201, json: { party_id: added, name: "Example Smile Studio" } };
        return { status: 201, json: { party_id: added, status: "roster" } };
      },
      { width: 390, theme },
    );
    const open = await page.getByRole("button", { name: "New client" }).boundingBox();
    assert.ok(open && open.height >= 44 && open.width >= 44);
    await page.getByRole("button", { name: "New client" }).click();
    const dialog = page.getByRole("dialog", { name: "New client" });
    await dialog.getByLabel("Name").fill("Example Smile Studio");
    await dialog.getByLabel("Email").fill("front@example.test");
    await dialog.getByLabel("Phone").fill("(202) 555-0101");
    await dialog.getByLabel("How found").selectOption("referral");
    await dialog.getByLabel("Practice type").fill("Dental");
    await assertTargets(page, `New client ${theme}`);
    const radio = await dialog.getByLabel("Company").boundingBox();
    assert.ok(radio && radio.width <= 24 && radio.height <= 24, `the radio box is small, not ${radio?.width}`);
    await dialog.getByRole("button", { name: "Save client" }).click();
    const use = dialog.getByRole("button", { name: "Use Example Smile Studio · Demo City" });
    await use.waitFor();
    assert.equal(
      await use.evaluate(
        (choice) => choice === document.activeElement && choice.getBoundingClientRect().bottom <= innerHeight,
      ),
      true,
      "the first choice has focus and is in view",
    );
    await dialog.getByText("An existing record keeps its own email, phone and city").waitFor();
    await dialog.getByRole("button", { name: "Save as a separate record" }).click();
    await page.waitForURL(`**/clients?record=${added}`);
    assert.equal(await dialog.count(), 0);
    const [first, separate, client] = posts(sent);
    assert.deepEqual(withoutKey(first?.body ?? {}), {
      kind: "company",
      name: "Example Smile Studio",
      email: "front@example.test",
      phone: "(202) 555-0101",
    });
    assert.deepEqual(withoutKey(separate?.body ?? {}), { ...withoutKey(first?.body ?? {}), force_new: true });
    assert.equal(client?.path, "/api/engine/clients");
    assert.deepEqual(withoutKey(client?.body ?? {}), {
      party_id: added,
      how_found: "referral",
      status: "roster",
      vertical: "Dental",
    });
  });

test("New client can use the existing record a partner picks", async (t) => {
  const { page, sent } = await setup(t, "/clients", ({ path }) =>
    path === "/api/engine/parties"
      ? {
          status: 409,
          json: { error: "party_exists", candidates: [{ id: other, name: "Example Smile Studio", city: null }] },
        }
      : { status: 201, json: { party_id: other } },
  );
  await page.getByRole("button", { name: "New client" }).click();
  const dialog = page.getByRole("dialog", { name: "New client" });
  await dialog.getByLabel("Name").fill("Example Smile Studio");
  await dialog.getByLabel("How found").selectOption("event");
  await dialog.getByRole("button", { name: "Save client" }).click();
  await dialog.getByRole("button", { name: "Use Example Smile Studio" }).click();
  await page.waitForURL(`**/clients?record=${other}`);
  assert.deepEqual(
    posts(sent).map((call) => call.path),
    ["/api/engine/parties", "/api/engine/clients"],
  );
});

// Saves edits as the engine does: a field whose from is not what it holds now is refused with the current record.
function engine(party: Record<string, unknown>, role: "client" | "vendor", profile: Record<string, unknown>) {
  // The contact holds its phone as the engine shows it.
  const state = { contact: { ...party }, profile: { ...profile } };
  const contactRead = () => ({ ...state.contact, phone: state.contact.phone ? { shown: state.contact.phone } : null });
  const changesIn = (body: Record<string, unknown> | null) =>
    Object.entries(body ?? {}).flatMap(([name, change]) =>
      typeof change === "object" && change !== null && "from" in change && "to" in change
        ? [{ name, from: change.from, to: change.to }]
        : [],
    );
  const edit = (held: Record<string, unknown>, body: Record<string, unknown> | null, read: () => unknown) => {
    const changes = changesIn(body);
    const stale = changes.filter(({ name, from }) => JSON.stringify(from) !== JSON.stringify(held[name] ?? null));
    if (stale.length)
      return {
        status: 409,
        json: { error: "version_conflict", fields: stale.map(({ name }) => name), current: read() },
      };
    for (const { name, to } of changes)
      held[name] = name === "phone" && typeof to === "string" ? `+1${to.replace(/\D/g, "")}` : to;
    return { status: 200, json: read() };
  };
  return {
    state,
    answer({ method, path, body }: Sent): Answer {
      const id = state.contact.party_id;
      if (method === "GET" && path === `/api/engine/parties/${id}`)
        return { status: 200, json: { ...contactRead(), client: null, vendor: null, [role]: state.profile } };
      if (path === `/api/engine/parties/${id}`) return edit(state.contact, body, contactRead);
      if (path === `/api/engine/${role}s/${id}`) return edit(state.profile, body, () => state.profile);
      return { status: 500, json: {} };
    },
  };
}
const vendorParty = {
  party_id: vendor,
  kind: "company",
  name: "Demo Partner 01",
  city: "Demo City",
  email: "hello@example.test",
  phone: "+12025550101",
  company: null,
};
const vendorProfile = { party_id: vendor, stage: "warm", offers: null, categories: ["banker"] };

test("Edit takes the record's current values after a conflict, so the next save applies what the partner typed", async (t) => {
  const fake = engine(vendorParty, "vendor", { ...vendorProfile, categories: [] });
  const { page, sent } = await setup(t, `/vendors?all=true&record=${vendor}`, fake.answer);
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Demo Partner 01" });
  await dialog.getByLabel("Phone").fill("202-555-0199");
  await dialog.getByLabel("Banking").check();
  fake.state.profile.categories = ["lender"];
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.getByText("Someone changed this since you opened it. Now: Categories Lender.").waitFor();
  assert.equal(await dialog.getByLabel("Banking").isChecked(), true);
  assert.equal(await dialog.getByLabel("Phone").inputValue(), "(202) 555-0199");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.waitFor({ state: "hidden" });
  const [contact, refused, role] = posts(sent);
  assert.equal(contact?.path, `/api/engine/parties/${vendor}`);
  assert.deepEqual(withoutKey(contact?.body ?? {}), { phone: { from: "+12025550101", to: "202-555-0199" } });
  assert.deepEqual(withoutKey(refused?.body ?? {}), { categories: { from: [], to: ["banker"] } });
  assert.deepEqual(withoutKey(role?.body ?? {}), { categories: { from: ["lender"], to: ["banker"] } });
  assert.equal(posts(sent).length, 3);
});

test("Edit before the list's choices load keeps the record's categories and stage, and saves only the city", async (t) => {
  const fake = engine(vendorParty, "vendor", vendorProfile);
  const { page, sent } = await setup(t, `/vendors?all=true&record=${vendor}`, fake.answer, { holdList: true });
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Demo Partner 01" });
  assert.equal(await dialog.getByLabel("Banker").isChecked(), true);
  assert.equal(await dialog.getByLabel("Stage").inputValue(), "warm");
  await dialog.getByLabel("City").fill("Example Town");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(
    posts(sent).map((call) => [call.path, withoutKey(call.body ?? {})]),
    [[`/api/engine/parties/${vendor}`, { city: { from: "Demo City", to: "Example Town" } }]],
  );
});

test("Edit on a client opened by its old id edits the party the record names", async (t) => {
  const party = "00000000-0000-4000-8000-000000000555";
  const fake = engine({ ...vendorParty, party_id: party, name: "Demo Practice 01" }, "client", {
    party_id: party,
    status: "roster",
    client_type: "group_practice",
    how_found: "not_recorded",
    vertical: "Dental",
  });
  const { page, sent } = await setup(t, `/clients?record=${firstClient}`, fake.answer, {
    record: { party_id: party },
    width: 390,
  });
  // On a phone the record actions sit in the header's menu.
  await page.locator("#recordPanel").getByRole("button", { name: "Record actions" }).click();
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Demo Practice 01" });
  assert.equal(await dialog.getByLabel("Client type").inputValue(), "group_practice");
  assert.equal(await dialog.getByLabel("How found").locator("option", { hasText: "Not recorded" }).count(), 1);
  await assertTargets(page, "Edit client");
  await dialog.getByLabel("Practice type").fill("Orthodontics");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(
    // The card's own read of the client's deals is not part of the edit.
    sent.filter((call) => /\/(parties|clients)\/[^/]+$/.test(call.path)).map((call) => call.path),
    [`/api/engine/parties/${party}`, `/api/engine/clients/${party}`],
  );
  assert.deepEqual(withoutKey(posts(sent)[0]?.body ?? {}), { vertical: { from: "Dental", to: "Orthodontics" } });
});

test("Renaming a client redraws its deal diagrams and opened deal with the new name", async (t) => {
  const fake = engine({ ...vendorParty, name: "Demo Practice 01" }, "client", {
    party_id: firstClient,
    status: "roster",
    client_type: "group_practice",
    how_found: "not_recorded",
    vertical: "Dental",
  });
  const deal = {
    id: "d1",
    name: "Demo office",
    phase: "negotiation",
    phase_label: "Negotiation",
    open: true,
    closed_on: null,
    owner: "dell",
    vendors: [],
    introductions: [],
  };
  const { page } = await setup(
    t,
    `/clients?record=${firstClient}`,
    (call) => (call.path.endsWith("/deals") ? { status: 200, json: { deals: [deal] } } : fake.answer(call)),
    { rereadRecord: { name: "Demo Renamed Practice" } },
  );
  const panel = page.locator("#recordPanel");
  const clientBox = (where: Locator) => where.locator(".deal-diagram").getByText("Demo Practice 01", { exact: true });
  await panel.getByRole("button", { name: "Open Demo office large" }).click();
  const opened = page.locator(".client-deal-opened");
  await clientBox(opened).waitFor();
  await panel.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Demo Practice 01" });
  await dialog.getByLabel("Name").fill("Demo Renamed Practice");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.waitFor({ state: "hidden" });
  const renamed = (where: Locator) =>
    where.locator(".deal-diagram").getByText("Demo Renamed Practice", { exact: true }).first();
  await renamed(panel).waitFor();
  await renamed(opened).waitFor();
  assert.equal(await clientBox(panel).count(), 0, "the card's diagram has no old name");
  assert.equal(await clientBox(opened).count(), 0, "the opened view has no old name");
});

test("Edit says it is opening and opens once however often it is pressed", async (t) => {
  const fake = engine(vendorParty, "vendor", vendorProfile);
  let release = () => {};
  const read = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settle = () => {};
  const activity = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const { page, sent } = await setup(
    t,
    `/vendors?all=true&record=${vendor}`,
    async (call) => {
      if (call.method === "GET") await read;
      return fake.answer(call);
    },
    { activity },
  );
  const button = page.locator("#recordPanel").getByRole("button", { name: "Edit" });
  await button.click();
  // Settled activity redraws the record panel while Edit is still opening.
  settle();
  await page.locator('#recordActivity :is(.activity-list, .activity-note:not([data-state="loading"]))').waitFor();
  const opening = page.locator("#recordPanel").getByRole("button", { name: "Opening…" });
  assert.equal(await opening.isDisabled(), true);
  await opening.click({ force: true });
  release();
  await page.getByRole("dialog", { name: "Edit Demo Partner 01" }).waitFor();
  assert.equal(await button.isEnabled(), true, "the redrawn Edit is ready again");
  await button.click({ force: true }).catch(() => {});
  // One read is the card's relationship; Edit reads once more.
  assert.equal(sent.filter((call) => call.path === `/api/engine/parties/${vendor}`).length, 2);
});

test("Edit to an email another record has offers that record, and Keep this email saves it anyway", async (t) => {
  const fake = engine(vendorParty, "vendor", vendorProfile);
  const { page, sent } = await setup(t, `/vendors?all=true&record=${vendor}`, (call) =>
    call.method === "POST" && call.path === `/api/engine/parties/${vendor}` && !call.body?.force_new
      ? {
          status: 409,
          json: { error: "party_exists", candidates: [{ id: other, name: "Demo Partner 02", city: null }] },
        }
      : fake.answer(call),
  );
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Demo Partner 01" });
  await dialog.getByLabel("Email").fill("shared@example.test");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.getByText("Another record has this email.").waitFor();
  await dialog.getByRole("button", { name: "Open Demo Partner 02" }).waitFor();
  await dialog.getByRole("button", { name: "Keep this email" }).click();
  await dialog.waitFor({ state: "hidden" });
  const [refused, kept] = posts(sent);
  assert.deepEqual(withoutKey(kept?.body ?? {}), { ...withoutKey(refused?.body ?? {}), force_new: true });
  assert.equal(fake.state.contact.email, "shared@example.test");
});

test("Open on another record's email opens it in the list that holds it", async (t) => {
  const party = "00000000-0000-4000-8000-000000000555";
  const otherVendor = "00000000-0000-4000-8000-000000000002";
  const fake = engine({ ...vendorParty, party_id: party, name: "Demo Practice 01" }, "client", {
    party_id: party,
    status: "roster",
    client_type: null,
    how_found: "inbound",
    vertical: null,
  });
  const { page } = await setup(
    t,
    `/clients?record=${firstClient}`,
    (call) =>
      call.path === `/api/engine/parties/${otherVendor}`
        ? { status: 200, json: { ...vendorParty, party_id: otherVendor, client: null, vendor: vendorProfile } }
        : call.method === "POST" && call.path === `/api/engine/parties/${party}`
          ? {
              status: 409,
              json: { error: "party_exists", candidates: [{ id: otherVendor, name: "Demo Partner 02", city: null }] },
            }
          : fake.answer(call),
    { record: { party_id: party } },
  );
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Demo Practice 01" });
  await dialog.getByLabel("Email").fill("shared@example.test");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.getByRole("button", { name: "Open Demo Partner 02" }).click();
  await page.waitForURL(`**/vendors?record=${otherVendor}`);
  await page.locator("#recordPanel").getByRole("heading", { name: "Demo Partner 02" }).waitFor();
});

test("Edit opened from the keyboard gives focus back to Edit when it closes", async (t) => {
  const fake = engine(vendorParty, "vendor", vendorProfile);
  const { page } = await setup(t, `/vendors?all=true&record=${vendor}`, fake.answer);
  // Settled activity re-renders the panel, which would take keyboard focus off Edit before Enter lands.
  await page.locator('#recordActivity :is(.activity-list, .activity-note:not([data-state="loading"]))').waitFor();
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).press("Enter");
  await page.getByRole("dialog", { name: "Edit Demo Partner 01" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Edit Demo Partner 01" }).waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-party-edit"), null, { timeout: 2000 });
});

test("A saved edit gives focus to the redrawn Edit", async (t) => {
  const fake = engine(vendorParty, "vendor", vendorProfile);
  let answer = () => {};
  const reread = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const { page } = await setup(t, `/vendors?all=true&record=${vendor}`, fake.answer, { reread });
  await page.locator('#recordActivity :is(.activity-list, .activity-note:not([data-state="loading"]))').waitFor();
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Demo Partner 01" });
  await dialog.getByLabel("City").fill("Example Town");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.waitFor({ state: "hidden" });
  // The record reloads after the dialog has closed, so its redraw comes last.
  const shown = await page.locator("[data-party-edit]").elementHandle();
  answer();
  await page.waitForFunction((button) => !button?.isConnected, shown);
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-party-edit")), true);
});

test("A saved contact with a refused profile refreshes the record, and focus finds the new Edit", async (t) => {
  const fake = engine(vendorParty, "vendor", vendorProfile);
  const { page } = await setup(t, `/vendors?all=true&record=${vendor}`, (call) =>
    call.path === `/api/engine/vendors/${vendor}`
      ? { status: 422, json: { error: "invalid_field_value", fields: ["offers"] } }
      : fake.answer(call),
  );
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Demo Partner 01" });
  await dialog.getByLabel("City").fill("Example Town");
  await dialog.getByLabel("What they offer").fill("Construction loans");
  const reread = page.waitForRequest(
    (request) => request.method() === "GET" && new URL(request.url()).pathname.endsWith(`/business/vendors/${vendor}`),
  );
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog.getByText("Check the highlighted fields.").waitFor();
  await reread;
  assert.equal(fake.state.contact.city, "Example Town");
  await dialog.getByRole("button", { name: "Close" }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-party-edit"), null, { timeout: 2000 });
});

test("Edit names each choice from its own list and offers Not recorded only to a record that has it", async (t) => {
  const party = "00000000-0000-4000-8000-000000000555";
  const fake = engine({ ...vendorParty, party_id: party, name: "Demo Practice 01" }, "client", {
    party_id: party,
    status: "roster",
    client_type: null,
    how_found: "inbound",
    vertical: null,
  });
  const { page } = await setup(t, `/clients?all=true&record=${firstClient}`, fake.answer, {
    record: { party_id: party },
    facets: { types: [{ slug: "referral", label: "Referral practice" }] },
  });
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Demo Practice 01" });
  await dialog.getByText("Changing the practice type clears the subtype.").waitFor();
  assert.equal(await dialog.getByLabel("How found").locator("option", { hasText: "Not recorded" }).count(), 0);
  await dialog.getByLabel("How found").selectOption("event");
  await dialog.getByLabel("Client type").selectOption("referral");
  Object.assign(fake.state.profile, { how_found: "not_recorded", client_type: "referral" });
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await dialog
    .getByText("Now: How found Not recorded; Client type Referral practice. Save again", { exact: false })
    .waitFor();
});

test("Edit does not open for a record the partner has already left", async (t) => {
  const fake = engine(vendorParty, "vendor", vendorProfile);
  let release = () => {};
  const read = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { page } = await setup(t, `/vendors?all=true&record=${vendor}`, async (call) => {
    if (call.method === "GET") await read;
    return fake.answer(call);
  });
  await page.locator("#recordPanel").getByRole("button", { name: "Edit" }).click();
  await page.locator("#recordPanel").getByRole("button", { name: "Opening…" }).waitFor();
  await page.locator("#recordClose").click();
  await page.waitForURL((url) => !url.searchParams.has("record"));
  release();
  await page.waitForResponse((response) => response.url().endsWith(`/api/engine/parties/${vendor}`));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await page.getByRole("dialog").count(), 0);
});

test("Using an existing record that is already a vendor opens it", async (t) => {
  const { page, sent } = await setup(t, "/vendors?all=true", ({ path }) =>
    path === "/api/engine/parties"
      ? {
          status: 409,
          json: { error: "party_exists", candidates: [{ id: other, name: "Example Lending", city: null }] },
        }
      : { status: 409, json: { error: "already_vendor", party_id: other } },
  );
  await page.getByRole("button", { name: "New vendor" }).click();
  const dialog = page.getByRole("dialog", { name: "New vendor" });
  await dialog.getByLabel("Name").fill("Example Lending");
  await dialog.getByRole("button", { name: "Save vendor" }).click();
  assert.equal(await dialog.getByText("An existing record keeps its own").count(), 0);
  await dialog.getByRole("button", { name: "Use Example Lending" }).click();
  await page.waitForURL(`**/vendors?all=true&record=${other}`);
  await page.getByText("This record is already a vendor, so it is open now.").waitFor();
  assert.equal(await dialog.count(), 0);
  assert.equal(posts(sent).length, 2);
});

test("A client saved while unconfirmed opens instead of refusing after an edit", async (t) => {
  let unanswered: unknown;
  const { page } = await setup(t, "/clients", ({ path, body }) => {
    if (path === "/api/engine/parties") return { status: 201, json: { party_id: added, name: "Example Dental" } };
    unanswered ??= body?.idempotency_key;
    return body?.idempotency_key === unanswered
      ? { status: 503, json: { error: "database_unavailable" } }
      : { status: 409, json: { error: "already_client", party_id: added } };
  });
  await page.getByRole("button", { name: "New client" }).click();
  const dialog = page.getByRole("dialog", { name: "New client" });
  await dialog.getByLabel("Name").fill("Example Dental");
  await dialog.getByLabel("How found").selectOption("inbound");
  await dialog.getByRole("button", { name: "Save client" }).click();
  await dialog.getByText("Not confirmed yet.").waitFor();
  await dialog.getByLabel("Practice type").fill("Dental");
  await dialog.getByRole("button", { name: "Save client" }).click();
  await page.waitForURL(`**/clients?record=${added}`);
  await page.getByText("This record is already a client, so it is open now.").waitFor();
});

test("New client asks for How found before saving anything, and says what is wrong", async (t) => {
  const { page, sent } = await setup(t, "/clients", () => ({ status: 201, json: { party_id: added } }));
  await page.getByRole("button", { name: "New client" }).click();
  const dialog = page.getByRole("dialog", { name: "New client" });
  await dialog.getByLabel("Name").fill("Example Dental");
  await dialog.getByRole("button", { name: "Save client" }).click();
  await dialog.getByText("Fill in the highlighted fields.").waitFor();
  const howFound = dialog.getByLabel("How found");
  assert.equal(await howFound.getAttribute("aria-invalid"), "true");
  assert.equal(await dialog.getByRole("combobox", { name: "How found", description: "Fill this in." }).count(), 1);
  assert.equal(await dialog.getByLabel("Name").getAttribute("aria-invalid"), null);
  assert.equal(posts(sent).length, 0);
  await howFound.selectOption("event");
  await dialog.getByRole("button", { name: "Save client" }).click();
  await page.waitForURL(`**/clients?record=${added}`);
});

test("New vendor fits a 560 px form at 1440, offers no relationship level, and explains a refused save plainly", async (t) => {
  const { page, sent } = await setup(t, "/vendors?all=true", ({ path }) =>
    path === "/api/engine/parties"
      ? { status: 201, json: { party_id: added, name: "Example Lending" } }
      : { status: 422, json: { error: "database_refused_the_statement", rule: "party_role_avoid_not_target" } },
  );
  await page.getByRole("button", { name: "New vendor" }).click();
  const dialog = page.getByRole("dialog", { name: "New vendor" });
  const box = await dialog.boundingBox();
  assert.ok(box && box.width <= 560 && box.width >= 540, `form is about 560 px wide, not ${box?.width}`);
  assert.equal(await dialog.getByLabel("Relationship level").count(), 0);
  await dialog.getByLabel("Name").fill("Example Lending");
  await dialog.getByLabel("Banking").check();
  await dialog.getByRole("button", { name: "Save vendor" }).click();
  await dialog.getByText("This was not saved. Try again.").waitFor();
  const [, role] = posts(sent);
  assert.deepEqual(withoutKey(role?.body ?? {}), { party_id: added, categories: ["banker"] });
});

test("An edit after an unanswered save clears Not confirmed yet and saves the new values", async (t) => {
  let answered = false;
  const { page, sent } = await setup(t, "/clients", ({ path }) => {
    if (path === "/api/engine/parties" && !answered) {
      answered = true;
      return { status: 503, json: { error: "database_unavailable" } };
    }
    return path === "/api/engine/parties"
      ? { status: 201, json: { party_id: added, name: "Example Dental Group" } }
      : { status: 201, json: { party_id: added } };
  });
  await page.getByRole("button", { name: "New client" }).click();
  const dialog = page.getByRole("dialog", { name: "New client" });
  await dialog.getByLabel("Name").fill("Example Dental");
  await dialog.getByLabel("How found").selectOption("inbound");
  await dialog.getByRole("button", { name: "Save client" }).click();
  const status = dialog.locator("[data-status]");
  await dialog.getByText("Not confirmed yet.").waitFor();
  await dialog.getByLabel("Name").fill("Example Dental Group");
  assert.equal(await status.textContent(), "");
  await dialog.getByRole("button", { name: "Save client" }).click();
  await page.waitForURL(`**/clients?record=${added}`);
  const [unanswered, party] = posts(sent);
  assert.equal(party?.body?.name, "Example Dental Group");
  assert.notEqual(party?.body?.idempotency_key, unanswered?.body?.idempotency_key);
});

test("Without the Clients and Vendors switch there is no New client, and the record says Practice type", async (t) => {
  const { page } = await setup(t, `/clients?record=${firstClient}`, () => ({ status: 404, json: {} }), {
    engineSwitch: false,
  });
  const panel = page.locator("#recordPanel");
  await panel.getByText("Practice type").first().waitFor();
  await page.waitForLoadState("networkidle");
  assert.equal(await panel.getByText("Vertical", { exact: true }).count(), 0);
  assert.equal(await page.locator(".party-new").count(), 0);
});

test("Link to someone on a record opened by its old id links the party the record names", async (t) => {
  const party = "00000000-0000-4000-8000-000000000555";
  const { page, sent } = await setup(
    t,
    `/vendors?all=true&record=${vendor}`,
    ({ method, path }) =>
      method === "GET" && path.startsWith("/api/engine/parties/search")
        ? {
            status: 200,
            json: {
              ok: true,
              parties: [{ id: other, display_name: "Avery Example", kind: "person", city: "Demo City" }],
            },
          }
        : { status: 201, json: { link_id: "00000000-0000-4000-8000-000000000999" } },
    { record: { party_id: party } },
  );
  await page.locator("#recordPanel").getByRole("button", { name: "Link to someone" }).click();
  const dialog = page.getByRole("dialog", { name: "Link Demo Partner 01 to someone" });
  await dialog.getByLabel("Link", { exact: true }).selectOption("can_introduce");
  await dialog.getByLabel("Find a person or company").fill("Avery");
  await dialog.getByLabel("Avery Example · Demo City").check();
  await dialog.getByLabel("Note").fill("Met at a study club");
  await dialog.getByRole("button", { name: "Save link" }).click();
  await dialog.waitFor({ state: "hidden" });
  const [link] = posts(sent);
  assert.equal(link?.path, "/api/engine/party-links");
  assert.deepEqual(withoutKey(link?.body ?? {}), {
    kind: "can_introduce",
    party_id: party,
    other_party_id: other,
    note: "Met at a study club",
  });
});

const self = "00000000-0000-4000-8000-000000000555";
const search = (call: Sent): Answer | null =>
  call.method === "GET" && call.path.startsWith("/api/engine/parties/search")
    ? {
        status: 200,
        json: {
          ok: true,
          parties: [
            { id: self, display_name: "Demo Partner 01", kind: "company", city: "Demo City" },
            {
              id: other,
              display_name: new URLSearchParams(call.path.split("?")[1]).get("query")?.startsWith("Bl")
                ? "Blake Example"
                : "Avery Example",
              kind: "person",
              city: "Demo City",
            },
          ],
        },
      }
    : null;
async function openLink(t: import("node:test").TestContext, save: Answer) {
  const { page, sent } = await setup(t, `/vendors?all=true&record=${vendor}`, (call) => search(call) ?? save, {
    record: { party_id: self },
  });
  await page.locator("#recordPanel").getByRole("button", { name: "Link to someone" }).click();
  return { page, sent, dialog: page.getByRole("dialog", { name: "Link Demo Partner 01 to someone" }) };
}

test("Link never offers the record itself and asks who to link when nobody is picked", async (t) => {
  const { sent, dialog } = await openLink(t, { status: 201, json: {} });
  await dialog.getByLabel("Find a person or company").fill("Avery");
  const group = dialog.getByRole("radiogroup", { name: "Who to link" });
  await group.getByLabel("Avery Example · Demo City").waitFor();
  assert.equal(await group.getByRole("radio").count(), 1, "the record itself is not a choice");
  await dialog.getByRole("button", { name: "Save link" }).click();
  await dialog.getByText("Choose who to link.").waitFor();
  assert.equal(await dialog.getByText("Fill in the highlighted fields.").count(), 0);
  assert.deepEqual(posts(sent), []);
});

test("Typing a new search takes back the pick, so Save never links the old match", async (t) => {
  const { page, sent, dialog } = await openLink(t, { status: 201, json: {} });
  await dialog.getByLabel("Find a person or company").fill("Avery");
  await dialog.getByLabel("Avery Example · Demo City").check();
  await dialog.getByLabel("Find a person or company").fill("Blake");
  const old = dialog.getByLabel("Avery Example · Demo City");
  if (await old.count()) {
    assert.equal(await old.isChecked(), false);
    assert.equal(await old.isDisabled(), true);
  }
  await dialog.getByRole("button", { name: "Save link" }).click();
  await dialog.getByText("Choose who to link.").waitFor();
  await dialog.getByLabel("Blake Example · Demo City").waitFor();
  assert.deepEqual(posts(sent), []);
  await page.close();
});

test("Link to a record that is gone says to search again", async (t) => {
  const { dialog } = await openLink(t, { status: 404, json: { error: "not_found" } });
  await dialog.getByLabel("Find a person or company").fill("Avery");
  await dialog.getByLabel("Avery Example · Demo City").check();
  await dialog.getByRole("button", { name: "Save link" }).click();
  await dialog.getByText("That record is no longer there. Search again.").waitFor();
  assert.equal(await dialog.getByText("This was not saved. Try again.").count(), 0);
});

test("A saved link gives focus to the redrawn Link to someone", async (t) => {
  let answer = () => {};
  const reread = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const { page } = await setup(
    t,
    `/vendors?all=true&record=${vendor}`,
    (call) => search(call) ?? { status: 201, json: { link_id: "00000000-0000-4000-8000-000000000999" } },
    { reread },
  );
  await page.locator('#recordActivity :is(.activity-list, .activity-note:not([data-state="loading"]))').waitFor();
  await page.locator("#recordPanel").getByRole("button", { name: "Link to someone" }).click();
  const dialog = page.getByRole("dialog", { name: "Link Demo Partner 01 to someone" });
  await dialog.getByLabel("Find a person or company").fill("Avery");
  await dialog.getByLabel("Avery Example · Demo City").check();
  await dialog.getByRole("button", { name: "Save link" }).click();
  await dialog.waitFor({ state: "hidden" });
  // The record reloads after the dialog has closed, so its redraw comes last.
  const shown = await page.locator("[data-party-link]").elementHandle();
  answer();
  await page.waitForFunction((button) => !button?.isConnected, shown);
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-party-link")), true);
});

test("Link closed after the record redraws gives focus to the new Link to someone", async (t) => {
  let settle = () => {};
  const activity = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const { page } = await setup(
    t,
    `/vendors?all=true&record=${vendor}`,
    (call) => search(call) ?? { status: 500, json: {} },
    {
      activity,
    },
  );
  await page.locator("#recordPanel").getByRole("button", { name: "Link to someone" }).click();
  const dialog = page.getByRole("dialog", { name: "Link Demo Partner 01 to someone" });
  await dialog.waitFor();
  settle();
  await page.locator('#recordActivity :is(.activity-list, .activity-note:not([data-state="loading"]))').waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-party-link"), null, { timeout: 2000 });
});

test("Link does not open while Edit is opening", async (t) => {
  const fake = engine(vendorParty, "vendor", vendorProfile);
  let release = () => {};
  const read = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settle = () => {};
  const activity = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const { page } = await setup(
    t,
    `/vendors?all=true&record=${vendor}`,
    async (call) => {
      if (call.method === "GET") await read;
      return fake.answer(call);
    },
    { activity },
  );
  const panel = page.locator("#recordPanel");
  await panel.getByRole("button", { name: "Edit" }).click();
  // Settled activity redraws the record panel while Edit is still opening.
  settle();
  await page.locator('#recordActivity :is(.activity-list, .activity-note:not([data-state="loading"]))').waitFor();
  await panel.getByRole("button", { name: "Opening…" }).waitFor();
  await panel.getByRole("button", { name: "Link to someone" }).click();
  assert.equal(await page.locator("dialog.party-editor[open]").count(), 0, "Link waits for the Edit that is opening");
  release();
  await page.getByRole("dialog", { name: "Edit Demo Partner 01" }).waitFor();
});

test("The relationship button on a vendor card changes the level, parks with a reason, and sets Want to meet", async (t) => {
  const fake = engine(vendorParty, "vendor", {
    ...vendorProfile,
    relationship_level: 1,
    disposition: null,
    disposition_reason: null,
    is_target: false,
  });
  const roleReread = Promise.withResolvers<void>();
  t.after(() => roleReread.resolve());
  const { page, sent } = await setup(
    t,
    `/vendors?all=true&record=${vendor}`,
    async (call) => {
      if (
        call.method === "GET" &&
        call.path === `/api/engine/parties/${vendor}` &&
        fake.state.profile.relationship_level === 2
      )
        await roleReread.promise;
      return fake.answer(call);
    },
    {
      record: () => ({
        relationship_level: fake.state.profile.relationship_level,
        recorded_disposition: fake.state.profile.disposition ?? "active",
        is_target: fake.state.profile.is_target,
      }),
    },
  );
  const panel = page.locator("#recordPanel");
  const button = panel.locator(".rel-button");
  const saves = () => posts(sent).map((call) => [call.path, withoutKey(call.body ?? {})]);

  await button.filter({ hasText: "Building" }).click();
  await panel.getByRole("button", { name: "Established", exact: true }).click();
  const established = button.filter({ hasText: "Established" });
  await established.waitFor();
  assert.equal(await established.isEnabled(), false, "the control waits for the refreshed role");
  assert.ok(await panel.locator("#recordRelationship").evaluate((control) => control === document.activeElement));
  roleReread.resolve();
  await page.waitForFunction(() =>
    document.activeElement?.matches('.rel-button:not([disabled])[data-relationship="established"]'),
  );
  assert.deepEqual(saves(), [[`/api/engine/vendors/${vendor}`, { relationship_level: { from: 1, to: 2 } }]]);

  await established.click();
  await panel.getByRole("button", { name: "Park…" }).click();
  const why = panel.getByLabel("Why park Demo Partner 01?");
  await why.fill("  Slow to reply  ");
  await panel.getByRole("button", { name: "Park", exact: true }).click();
  await panel.locator(".rel-reason", { hasText: "Slow to reply" }).waitFor();
  assert.deepEqual(saves()[1], [
    `/api/engine/vendors/${vendor}`,
    { disposition: { from: null, to: "parked" }, disposition_reason: { from: null, to: "Slow to reply" } },
  ]);

  await button.filter({ hasText: "Parked" }).click();
  await panel.getByRole("button", { name: "Want to meet" }).click();
  await panel.locator(".want-tag", { hasText: "Want to meet" }).waitFor();
  assert.deepEqual(saves()[2], [`/api/engine/vendors/${vendor}`, { is_target: { from: false, to: true } }]);
  assert.equal(saves().length, 3);
});

test("A vendor card can retry a failed relationship refresh after a save", async (t) => {
  const fake = engine(vendorParty, "vendor", { ...vendorProfile, relationship_level: 1 });
  let refreshes = 0;
  const { page, sent } = await setup(
    t,
    `/vendors?all=true&record=${vendor}`,
    (call) => {
      if (
        call.method === "GET" &&
        call.path === `/api/engine/parties/${vendor}` &&
        fake.state.profile.relationship_level === 2 &&
        ++refreshes === 1
      )
        return { status: 503, json: {} };
      return fake.answer(call);
    },
    { record: () => ({ relationship_level: fake.state.profile.relationship_level }) },
  );
  const relationship = page.locator("#recordRelationship");
  const established = relationship.locator(".rel-button", { hasText: "Established" });
  await relationship.locator(".rel-button", { hasText: "Building" }).click();
  await relationship.getByRole("button", { name: "Established", exact: true }).click();

  const alert = relationship.getByRole("alert");
  await alert.filter({ hasText: "Could not load the relationship." }).waitFor();
  assert.equal(await established.isVisible(), false);
  const retry = relationship.getByRole("button", { name: "Try again" });
  await retry.focus();
  await page.keyboard.press("Enter");
  await alert.waitFor({ state: "hidden" });
  await page.waitForFunction(() =>
    document.activeElement?.matches('.rel-button:not([disabled])[data-relationship="established"]'),
  );
  assert.equal(refreshes, 2);
  assert.equal(posts(sent).length, 1);
  await established.click();
  await relationship.getByRole("button", { name: "Park…" }).waitFor();
});

test("Park opens as a question, and Escape closes it without saving or closing the card", async (t) => {
  const fake = engine(vendorParty, "vendor", {
    ...vendorProfile,
    relationship_level: 0,
    disposition: null,
    is_target: false,
  });
  const { page, sent } = await setup(t, `/vendors?all=true&record=${vendor}`, fake.answer);
  const panel = page.locator("#recordPanel");
  await panel.locator(".rel-button:not([disabled])").click();
  await panel.getByRole("button", { name: "Avoid…" }).click();
  await panel.getByLabel("Why avoid Demo Partner 01?").waitFor();
  await page.keyboard.press("Escape");
  await panel.locator("#relationshipMenu").waitFor({ state: "hidden" });
  assert.equal(await panel.isVisible(), true);
  await panel.locator(".rel-button").click();
  assert.equal(
    await panel.getByRole("button", { name: "Core", exact: true }).isVisible(),
    true,
    "the menu opens on its choices again",
  );
  assert.deepEqual(posts(sent), []);
});

for (const [name, refusal, message] of [
  ["a failed save", { status: 500, json: {} }, "This was not saved. Try again."],
  [
    "a version conflict",
    {
      status: 409,
      json: {
        error: "version_conflict",
        fields: ["relationship_level"],
        current: { ...vendorProfile, relationship_level: 3 },
      },
    },
    "Someone changed this since you opened it. Check it and choose again.",
  ],
] as const) {
  test(`The relationship button tells the partner about ${name}`, async (t) => {
    const fake = engine(vendorParty, "vendor", {
      ...vendorProfile,
      relationship_level: 1,
      disposition: null,
      is_target: false,
    });
    const { page } = await setup(t, `/vendors?all=true&record=${vendor}`, (call) =>
      call.method === "POST" ? refusal : fake.answer(call),
    );
    const panel = page.locator("#recordPanel");
    await panel.locator(".rel-button:not([disabled])").click();
    await panel.getByRole("button", { name: "Established", exact: true }).click();
    await page.locator("#recordStatus", { hasText: message }).waitFor();
  });
}
