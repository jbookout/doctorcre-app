import test from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { createFixtureClient } from "../js/fixture-client.js";
import { relationshipNetworkFixture } from "../js/relationship-network-fixture.js";
import { introductionSuggestions } from "../js/relationship-network-model.js";
import { censusResponse } from "../scripts/work-inventory-fixture.mjs";

// The server keeps display snapshots valid for 120 s so the 60 s refresh floor never reads an expired one.
const MINUTE = 60_000;
const windowOf = (s) => Date.parse(s.valid_until) - Date.parse(s.observed_at);

test("demo relationship map still renders one refresh period after it was read", () => {
  const now = Date.now();
  const snapshot = relationshipNetworkFixture(new Date(now).toISOString());
  assert.ok(introductionSuggestions(snapshot, { now: now + MINUTE + 1 }).length > 0);
});

test("demo fixtures mint 120 s validity for the refreshed snapshots", async () => {
  const seed = await readFile(new URL("../data/board-seed.json", import.meta.url), "utf8");
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seed).toString("base64")}` });
  const home = await client.commandCenter();
  assert.equal(windowOf(home.source), 2 * MINUTE);
  assert.equal(windowOf((await client.getRelationshipNetwork())), 2 * MINUTE);
  assert.equal(windowOf(censusResponse(new URL("http://fixture.local/api/v1/work-inventory")).source), 2 * MINUTE);
});
