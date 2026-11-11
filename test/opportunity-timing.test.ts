import assert from "node:assert/strict";
import test from "node:test";
import { parseOpportunityTiming, timingMarkup } from "../src/ui/lead-opportunity-timing.ts";

import { supportedTiming, unknownTiming } from "./opportunity-timing-fixture.ts";

test("Added and source day remain separate across timezones", () => {
  for (const zone of ["UTC", "Pacific/Honolulu", "Asia/Tokyo"]) {
    process.env.TZ = zone;
    const html = timingMarkup(parseOpportunityTiming(supportedTiming), true);
    assert.match(html, /Oct 31, 2026, 9:30 PM CDT/);
    assert.match(html, /Oct 1, 2026/);
    assert.match(html, /enumeration/);
    assert.match(html, /synthetic-npi/);
    assert.match(html, /Revision 1/);
  }
});
test("Unknown never uses stage or updated dates", () => {
  const html = timingMarkup(
    parseOpportunityTiming({
      ...unknownTiming,
      updated_at: "2026-12-01",
      last_stage_move: { occurred_at: "2026-12-02" },
    }),
    true,
  );
  assert.match(html, /Opportunity timing unknown/);
  assert.doesNotMatch(html, /Dec|2026-12/);
  assert.match(timingMarkup(undefined), /Added unavailable/);
});
test("Corrupt timing refuses instead of inventing unknown", () => {
  for (const bad of [
    { ...unknownTiming, events: supportedTiming.events },
    { ...supportedTiming, events: [] },
    { ...unknownTiming, record_added_at: "2026-02-30T00:00:00Z" },
    { ...supportedTiming, events: [{ ...supportedTiming.events[0], date: "2026-02-30" }] },
  ])
    assert.throws(() => parseOpportunityTiming(bad));
});

test("Pinned producer contract bytes and all supported source events are retained", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const bytes = await readFile(new URL("../contracts/lead-opportunity-timing.v1/contract.md", import.meta.url));
  const source = JSON.parse(
    await readFile(new URL("../contracts/lead-opportunity-timing.v1/source.json", import.meta.url), "utf8"),
  );
  assert.equal(source.commit, "28ad26f601bdb4714331f122cd68337470509ef6");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256);
  const first = supportedTiming.events[0];
  assert.ok(first);
  const payload = {
    ...supportedTiming,
    events: [
      first,
      {
        ...first,
        source: "pecos",
        record_key: "synthetic-pecos",
        date_basis: "publication",
        meaning: "Public PECOS enrollment observed",
        date: "2026-10-03",
      },
    ],
  };
  const html = timingMarkup(parseOpportunityTiming(payload), true);
  assert.match(html, /Oct 1, 2026/);
  assert.match(html, /Oct 3, 2026/);
  assert.match(html, /synthetic-pecos/);
  assert.match(html, /publication/);
});
