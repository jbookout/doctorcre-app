import assert from "node:assert/strict";
import test from "node:test";
import { parseVerbWrites } from "../scripts/drag-read-guard.ts";
import registry from "./fixtures/walk-verb-registry.json" with { type: "json" };

test("recorded CARR metadata distinguishes reads, writes and unknown verbs", () => {
  const writes = parseVerbWrites(registry.response);
  assert.equal(writes.get("list-verbs"), false);
  assert.equal(writes.get("append-tour-route-version"), true);
  assert.equal(writes.get("unknown-verb"), undefined);
});

test("unreadable and contradictory metadata cannot authorize a request", () => {
  for (const value of [
    null,
    {},
    { ...registry.response, count: 1 },
    { ok: true, count: 1, verbs: [{ name: "read", write: "false" }] },
    {
      ok: true,
      count: 2,
      verbs: [
        { name: "read", write: false },
        { name: "read", write: true },
      ],
    },
  ])
    assert.throws(() => parseVerbWrites(value), /metadata unreadable/);
});
