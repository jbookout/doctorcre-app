import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { startFixtureServer } from "../scripts/fixture-server.mjs";
import { chromium } from "./browser-harness.mjs";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const paginated = JSON.parse(await readFile(new URL("./fixtures/vendor-meetings/page.json", import.meta.url), "utf8"));

test("Suggested retains exact named people with unknown channels and unavailable calendar", async (t) => {
  const recording = JSON.parse(
    await readFile(new URL("./fixtures/vendor-meetings/recordings.json", import.meta.url), "utf8"),
  );
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) => r.fulfill({ json: directoryFixture(r.request().url()) }));
  await page.route("**/mcp", (r) => {
    const req = r.request().postDataJSON();
    return r.fulfill({
      json: {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(req.params.name === "read-vendor-meetings" ? recording.suggested : {}),
            },
          ],
        },
      },
    });
  });
  await page.goto(`${server.url}/vendors`);
  const section = page.getByRole("region", { name: "People worth meeting" });
  await section.getByText("Ada Synthetic", { exact: true }).waitFor({ timeout: 5000 });
  for (const text of [
    "Email not recorded",
    "Phone not recorded",
    "1 Synthetic Plaza, Demo City, FL",
    "Medical office purchase financing",
    "Calendar unavailable. People and office details are still shown.",
  ])
    assert.equal(await section.getByText(text, { exact: true }).count(), 1);
});

async function setup(t: import("node:test").TestContext, width = 1440) {
  const recording = JSON.parse(
    await readFile(new URL("./fixtures/vendor-meetings/recordings.json", import.meta.url), "utf8"),
  );
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) => r.fulfill({ json: directoryFixture(r.request().url()) }));
  const requests: { view: string; q: string; cursor?: string }[] = [];
  let mode = "ready";
  let release: (() => void) | undefined;
  await page.route("**/mcp", async (route) => {
    const request = route.request().postDataJSON();
    let payload: unknown = {};
    let isError = false;
    if (request.params.name === "read-vendor-meetings") {
      requests.push(request.params.arguments);
      const query = request.params.arguments;
      const held = mode === "hold";
      const failed = mode === "fail";
      payload = structuredClone(recording[query.view]);
      if (mode === "page") payload = structuredClone(paginated[query.view]);
      if (mode === "empty") payload = { ...recording[query.view], items: [], total: 0 };
      if (failed) {
        payload = { error: "vendor_meetings_unavailable" };
        isError = true;
      }
      if (held)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    }
    await route
      .fulfill({
        json: {
          jsonrpc: "2.0",
          id: request.id,
          result: { isError, content: [{ type: "text", text: JSON.stringify(payload) }] },
        },
      })
      .catch(() => {});
  });
  await page.goto(`${server.url}/vendors`);
  const section = page.getByRole("region", { name: "People worth meeting" });
  if (width < 768) await page.locator(".vendor-meetings > summary").click();
  await section.getByText("Ada Synthetic", { exact: true }).waitFor();
  return {
    page,
    section,
    requests,
    setMode: (next: string) => {
      mode = next;
    },
    release: () => release?.(),
  };
}
test("empty, failure and retry remain distinct", async (t) => {
  const { section, setMode } = await setup(t);
  setMode("empty");
  await section.getByRole("searchbox").fill("empty");
  await section
    .getByText("No suggested people match this search. Open Research to see what is missing.", { exact: true })
    .waitFor();
  assert.equal(await section.getByRole("alert").count(), 0);
  setMode("fail");
  await section.getByRole("searchbox").fill("failure");
  await section.getByRole("alert").waitFor();
  assert.equal(await section.getByText("Ada Synthetic", { exact: true }).count(), 0);
  setMode("ready");
  await section.getByRole("button", { name: "Retry people" }).click();
  await section.getByText("Ada Synthetic", { exact: true }).waitFor();
  setMode("fail");
  await section.getByRole("searchbox").fill("another failure");
  await section.getByRole("alert").waitFor();
  setMode("ready");
  await section.getByRole("searchbox").fill("recovered query");
  await section.getByText("Ada Synthetic", { exact: true }).waitFor();
});
test("pagination is query-bound and keyboard tabs retire late responses", async (t) => {
  const { page, section, requests, setMode, release } = await setup(t);
  setMode("page");
  await section.getByRole("searchbox").fill("Ada");
  await section.getByRole("button", { name: "Next people" }).waitFor();
  setMode("hold");
  await section.getByRole("button", { name: "Next people" }).click();
  await page.waitForTimeout(450);
  assert.equal(requests.at(-1)?.cursor, paginated.suggested.next_cursor);
  setMode("ready");
  await section.getByRole("tab", { name: "Suggested", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await section.getByText("A verified office is needed", { exact: true }).waitFor();
  assert.equal(requests.at(-1)?.view, "research");
  assert.equal(requests.at(-1)?.cursor, undefined);
  assert.equal(
    await section.getByRole("tab", { name: "Research", exact: true }).evaluate((el) => el === document.activeElement),
    true,
  );
  release();
  await section.getByText("A meeting reason is needed", { exact: true }).waitFor();
  assert.equal(await section.getByText("1 Synthetic Plaza, Demo City, FL", { exact: true }).count(), 0);
  await page.keyboard.press("Home");
  await section.getByText("1 Synthetic Plaza, Demo City, FL", { exact: true }).waitFor();
  await section.getByRole("searchbox").fill("");
  await section.getByText("1 Synthetic Plaza, Demo City, FL", { exact: true }).waitFor();
  setMode("page");
  await section.getByRole("searchbox").fill("Ada");
  await section.getByRole("button", { name: "Next people" }).click();
  await section.getByRole("button", { name: "Back to first people" }).waitFor();
  setMode("ready");
  await section.getByRole("searchbox").fill("new");
  await section.getByText("1 Synthetic Plaza, Demo City, FL", { exact: true }).waitFor();
  assert.equal(requests.at(-1)?.cursor, undefined);
});
test("session retirement erases results and ignores pending responses", async (t) => {
  const { page, section, setMode, release } = await setup(t);
  setMode("hold");
  await section.getByRole("searchbox").fill("pending");
  await page.waitForTimeout(450);
  await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
  release();
  await page.waitForTimeout(100);
  assert.equal(await section.count(), 0);
});
for (const width of [1440, 390])
  for (const theme of ["light", "dark"])
    test(`vendor meetings fit ${width} ${theme}`, async (t) => {
      const { page, section } = await setup(t, width);
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await section.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const { mkdir } = await import("node:fs/promises");
      await mkdir("/tmp/WR591.S24.J3-shots", { recursive: true });
      await page.screenshot({ path: `/tmp/WR591.S24.J3-shots/suggested-${width}-${theme}.png`, fullPage: true });
      await section.getByRole("tab", { name: "Research", exact: true }).click();
      await section.getByText("A verified office is needed", { exact: true }).waitFor();
      await page.screenshot({ path: `/tmp/WR591.S24.J3-shots/research-${width}-${theme}.png`, fullPage: true });
    });

test("query changes retire successful and failed late reads even when the adapter ignores cancellation", async (t) => {
  const { page } = await setup(t);
  const recording = JSON.parse(
    await readFile(new URL("./fixtures/vendor-meetings/recordings.json", import.meta.url), "utf8"),
  );
  await page.evaluate(async (recording) => {
    const path = "/js/ui-vendor-meetings.generated.js";
    const { mountVendorMeetings } = await import(path);
    const host = document.createElement("div");
    document.body.replaceChildren(host);
    const pending: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
    const mounted = mountVendorMeetings(host, {
      load: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
      href: () => "/vendors",
      open: () => {},
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 400));
    await tick();
    function search(value: string) {
      const input = host.querySelector("input");
      if (!input) throw Error("Missing search");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    search("new");
    await tick();
    pending[1]?.resolve(recording.suggested);
    await tick();
    pending[0]?.reject(Error("Old failure"));
    await tick();
    if (host.querySelector('[role="alert"]')) throw Error("Late failure replaced current result");
    search("third");
    await tick();
    search("fourth");
    await tick();
    if (pending.length !== 4) throw Error("Expected all four reads to start");
    pending[2]?.resolve(recording.research);
    await tick();
    if (host.querySelector('[role="tabpanel"]')?.getAttribute("aria-busy") !== "true")
      throw Error("Late response replaced current pending read");
    pending[3]?.resolve(recording.suggested);
    await tick();
    if (host.querySelector("[data-meeting-office]")?.textContent !== "1 Synthetic Plaza, Demo City, FL")
      throw Error("Late success replaced current result");
    mounted.dispose();
    pending.at(-1)?.resolve(recording.suggested);
    await tick();
    if (host.textContent) throw Error("Disposed mount repainted");
  }, recording);
});

for (const mode of ["ready", "empty", "fail"])
  test(`session retirement clears ${mode} answers`, async (t) => {
    const { page, section, setMode } = await setup(t);
    if (mode !== "ready") {
      setMode(mode);
      await section.getByRole("searchbox").fill(mode);
      if (mode === "fail") await section.getByRole("alert").waitFor();
      else
        await section
          .getByText("No suggested people match this search. Open Research to see what is missing.", { exact: true })
          .waitFor();
    }
    await page.evaluate(() => window.dispatchEvent(new Event("doctorcre-session-invalidated")));
    assert.equal(await section.count(), 0);
  });

test("possible meetings retain exact recorded details and partial-calendar warnings", async (t) => {
  const { page, section } = await setup(t);
  const ready = JSON.parse(await readFile(new URL("./fixtures/vendor-meetings/ready.json", import.meta.url), "utf8"));
  await page.route("**/mcp", (route) => {
    const request = route.request().postDataJSON();
    return route.fulfill({
      json: {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                request.params.name === "read-vendor-meetings" ? ready[request.params.arguments.view] : {},
              ),
            },
          ],
        },
      },
    });
  });
  await section.getByRole("searchbox").fill("meeting");
  await section.getByText("Synthetic office visit", { exact: false }).waitFor();
  const meetings = ready.suggested.items[0].possible_meetings;
  assert.deepEqual(
    await section.locator("h3 + ul > li").allTextContents(),
    meetings.map(
      (m: { title: string; start: string; end: string; location: string | null }) =>
        `${m.title} · ${m.start} to ${m.end}${m.location ? ` · ${m.location}` : ""}`,
    ),
  );
  for (const note of ready.suggested.calendar.notes)
    assert.equal(await section.getByText(note, { exact: true }).count(), 1);
});

test("phone disclosure restores directory and retains meeting view across close and reopen", async (t) => {
  const { page, section } = await setup(t, 390);
  await section.getByRole("tab", { name: "Research", exact: true }).click();
  await section.getByText("A verified office is needed", { exact: true }).waitFor();
  const summary = page.locator(".vendor-meetings > summary");
  await summary.click();
  assert.equal(await section.isVisible(), false);
  await page.locator(".record-row").first().waitFor();
  assert.equal(await page.locator(".record-row").first().isVisible(), true);
  await summary.focus();
  await page.keyboard.press("Enter");
  await section.getByText("A verified office is needed", { exact: true }).waitFor();
  assert.equal(await section.getByRole("tab", { name: "Research", exact: true }).getAttribute("aria-selected"), "true");
});
