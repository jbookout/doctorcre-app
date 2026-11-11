import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseVendorMarkets } from "../src/ui/vendor-markets-client.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/vendor-markets.v1.json", import.meta.url), "utf8"));
test("producer fixture preserves unique counts, multi-market and Regional references", () => {
  const page = parseVendorMarkets(fixture);
  assert.equal(page.selected_market, "sandestin");
  assert.equal(page.markets.find((m) => m.slug === "sandestin")?.vendor_count, 1);
  assert.deepEqual(page.vendors.find((v) => v.name === "Synthetic multi")?.market_slugs, ["other", "sandestin"]);
});
test("refuses duplicate memberships, incorrect counts, dangling references and versions", () => {
  for (const mutate of [
    (p: typeof fixture) => {
      p.schema_version = "v2";
    },
    (p: typeof fixture) => {
      p.markets[0].vendor_count = 2;
    },
    (p: typeof fixture) => {
      p.markets[0].memberships.push(p.markets[0].memberships[0]);
    },
    (p: typeof fixture) => {
      p.vendors = [];
    },
  ]) {
    const p = structuredClone(fixture);
    mutate(p);
    assert.throws(() => parseVendorMarkets(p));
  }
});
test("explicit empty registry has no selection", () => {
  assert.equal(
    parseVendorMarkets({
      ok: true,
      schema_version: "vendor-markets.v1",
      state: "empty",
      selected_market: null,
      markets: [],
      vendors: [],
    }).state,
    "empty",
  );
});

test("recorded fixture conforms to the pinned producer schema", async () => {
  const { Ajv } = await import("ajv");
  const contract = JSON.parse(readFileSync(new URL("../contracts/vendor-markets.v1.json", import.meta.url), "utf8"));
  const validator = new Ajv({ strict: false, validateFormats: false }).compile(contract.response_schema);
  assert.equal(validator(fixture), true, JSON.stringify(validator.errors));
});
