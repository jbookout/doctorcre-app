import assert from "node:assert/strict";
import test from "node:test";
import { validateLeadDetail, validateLeadWorkspace } from "../js/leads-client.js";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";
import recording from "./fixtures/research-source/recordings.json" with { type: "json" };

const assets = await appAssetSnapshot();
async function fixture(onRead = () => {}, onWrite = () => {}) {
  return startWorkerFixture({
    assets,
    env: {
      APP_ENV: "fixture",
      CARR: {
        fetch: async (request) => {
          if (new URL(request.url).pathname !== "/mcp")
            return Response.json({ actor: { slug: "example-partner" }, csrf_token: "synthetic-test-token" });
          const body = await request.json();
          const { name, arguments: args } = body.params;
          let value: unknown;
          if (name === "lead-board") {
            onRead();
            value = {
              ...recording,
              ...(args.lead_id ? { detail: { ...structuredClone(recording.detail), id: args.lead_id } } : {}),
            };
          } else if (name === "list-practice-origination") {
            value = {
              ok: true,
              contract: "practice-origination.v1",
              cards: [],
              coverage: [],
              next_cursor: null,
              outreach_started: false,
            };
          } else if (name === "quiet-follow-ups") {
            value = {
              schema_version: "quiet-follow-ups.v1",
              cadence: { lead_days: 45, vendor_days: 90 },
              proposals: [],
              sent: false,
              tasks_created: false,
            };
          } else {
            onWrite();
            value = { error: "unexpected_fixture_rpc" };
          }
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: JSON.stringify(value) }] },
          });
        },
      },
    },
  });
}

validateLeadWorkspace(recording);
validateLeadDetail(recording.detail, recording.detail.id);
for (const width of [390, 1440])
  test(`source transitions and exact intersection ${width}`, async (t) => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(5000);
    let reads = 0,
      writes = 0,
      rpc = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/mcp") rpc++;
    });
    const server = await fixture(
      () => {
        reads++;
      },
      () => {
        writes++;
      },
    );
    t.after(() => server.close());
    await page.goto(`${server.origin}/leads`);
    await page.locator("[data-open]").first().click();
    const panel = page.locator("#sourcedResearch");
    const selector = panel.getByLabel("Finding source", { exact: true });
    await selector.waitFor();
    const options = await selector.locator("option").evaluateAll((nodes) =>
      nodes.map((n) => {
        if (!(n instanceof HTMLOptionElement)) throw Error("Option required");
        return { value: n.value, label: n.textContent };
      }),
    );
    assert.deepEqual(options, [
      { value: "all", label: "All finding sources" },
      { value: "source:https://example.test/source/0", label: "https://example.test/source/0" },
      { value: "source: https://example.test/source/0 ", label: "https://example.test/source/0" },
      { value: "missing", label: "Source not recorded" },
      { value: "source:missing", label: "missing" },
      { value: "source:source:missing", label: "source:missing" },
      { value: "source:all", label: "all" },
      { value: "source:<img src=x onerror=alert(1)>", label: "<img src=x onerror=alert(1)>" },
    ]);
    assert.equal(options.length, 8, "duplicate exact strings share an option; whitespace shares missing");
    assert.equal(new Set(options.map((o) => o.value)).size, options.length);
    const sourceValue = (source: string) => `source:${source}`;
    const ids = (indices: number[]) =>
      indices.map((i) => {
        const item = recording.detail.research.evidence[i];
        assert.ok(item);
        return item.flag_id;
      });
    async function check(indices: number[]) {
      assert.deepEqual(
        await panel.locator("li").evaluateAll((nodes) => nodes.map((n) => n.dataset.flagId)),
        ids(indices),
      );
      assert.equal(await panel.getByRole("status").textContent(), `${indices.length} of 9 loaded findings`);
      assert.equal(await panel.getByText("No matching findings.", { exact: true }).count(), indices.length ? 0 : 1);
    }
    const calls = reads,
      requests = rpc;
    await check([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    await selector.selectOption("missing");
    await check([3, 4]);
    await selector.selectOption(sourceValue("https://example.test/source/0"));
    await check([0, 1]);
    const attention = panel.getByLabel("Finding attention", { exact: true });
    await attention.selectOption("correction");
    await check([1]);
    await panel.getByLabel("Finding kind", { exact: true }).selectOption("address");
    await check([]);
    await panel.getByLabel("Finding kind", { exact: true }).selectOption("");
    await check([1]);
    await attention.selectOption("");
    await check([0, 1]);
    await attention.selectOption("expired");
    await check([0]);
    await attention.selectOption("");
    await check([0, 1]);
    await attention.selectOption("nothing");
    await check([]);
    assert.deepEqual(
      await selector.locator("option").evaluateAll((nodes) =>
        nodes.map((n) => {
          if (!(n instanceof HTMLOptionElement)) throw Error("Option required");
          return { value: n.value, label: n.textContent };
        }),
      ),
      options,
    );
    await attention.selectOption("");
    await check([0, 1]);
    await selector.selectOption("all");
    await check([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    await selector.selectOption(sourceValue("https://example.test/source/0"));
    await check([0, 1]);
    await selector.selectOption("missing");
    await check([3, 4]);
    await selector.selectOption(sourceValue(" https://example.test/source/0 "));
    await check([2]);
    await selector.selectOption("missing");
    await check([3, 4]);
    await selector.selectOption("all");
    await check([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    await selector.selectOption(sourceValue("missing"));
    await check([5]);
    await selector.selectOption(sourceValue("source:missing"));
    await check([6]);
    await selector.selectOption(sourceValue("all"));
    await check([7]);
    await selector.selectOption(sourceValue("<img src=x onerror=alert(1)>"));
    await check([8]);
    assert.equal(await panel.locator("img").count(), 0);
    await panel.getByLabel("Finding kind", { exact: true }).selectOption("phone");
    await check([]);
    assert.deepEqual(
      await selector.locator("option").evaluateAll((nodes) =>
        nodes.map((n) => {
          if (!(n instanceof HTMLOptionElement)) throw Error("Option required");
          return { value: n.value, label: n.textContent };
        }),
      ),
      options,
    );
    await selector.selectOption("missing");
    await check([3]);
    await selector.selectOption("all");
    await check([1, 3, 5, 7]);
    await panel.getByLabel("Finding kind", { exact: true }).selectOption("");
    await check([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(reads, calls);
    assert.equal(writes, 0);
    assert.equal(rpc, requests);
    assert.equal(await panel.locator(":scope > p").nth(0).textContent(), "Needs review");
    assert.equal(await panel.locator(":scope > p").nth(1).textContent(), recording.detail.research.next_step);
    assert.equal(await panel.locator(".research-expiry").count(), 1);
    assert.equal(
      await panel.locator("li").first().getByRole("link").getAttribute("href"),
      "https://example.test/source/0",
    );
    await selector.selectOption("missing");
    await panel.getByLabel("Finding kind", { exact: true }).selectOption("phone");
    assert.equal(await selector.inputValue(), "missing", "mounted panel preserves selection through other filters");
    await panel.getByLabel("Finding kind", { exact: true }).selectOption("");
    for (const selectedSource of ["all", "missing", sourceValue("https://example.test/source/0")]) {
      for (const selectedAttention of ["", "correction", "expired", "nothing"]) {
        await selector.selectOption(selectedSource);
        await attention.selectOption(selectedAttention);
        await panel.getByLabel("Finding kind", { exact: true }).selectOption("phone");
        await page.locator("#closeDetail").click();
        await page.locator("[data-open]").nth(1).click();
        assert.equal(await selector.inputValue(), "all", "different mount starts at all");
        assert.equal(await attention.inputValue(), "", "different mount resets attention independently");
      }
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });

test("absent research and empty evidence have no source selector", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const server = await fixture();
  t.after(() => server.close());
  await page.goto(`${server.origin}/leads`);
  await page.evaluate(async () => {
    const { mountLeadResearch } = await import(String("/js/ui-lead-research.generated.js"));
    const host = document.createElement("div");
    document.body.append(host);
    Reflect.set(window, "sourceMount", mountLeadResearch(host, undefined));
  });
  assert.equal(await page.getByText("Sourced research was not included in this read.", { exact: true }).count(), 1);
  assert.equal(await page.getByLabel("Finding source", { exact: true }).count(), 0);
  await page.evaluate(async () => {
    const mounted: unknown = Reflect.get(window, "sourceMount");
    if (mounted && typeof mounted === "object" && "dispose" in mounted && typeof mounted.dispose === "function")
      mounted.dispose();
    const { mountLeadResearch } = await import(String("/js/ui-lead-research.generated.js"));
    const host = document.createElement("div");
    document.body.append(host);
    Reflect.set(
      window,
      "sourceMount",
      mountLeadResearch(host, { state: "verified", next_step: "No next step", evidence: [] }),
    );
  });
  assert.equal(await page.getByText("No sourced findings.", { exact: true }).count(), 1);
  assert.equal(await page.getByLabel("Finding source", { exact: true }).count(), 0);
});
