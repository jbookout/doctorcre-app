import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { appendPacketMetadata, packetAsOf } from "../src/ui/packet-facts.ts";

test("packet as-of matches the producer UTC display across equivalent offsets", () => {
  assert.equal(packetAsOf("2026-08-27T07:00:00-05:00"), "As of August 27, 2026 at 12:00 UTC");
  assert.equal(packetAsOf("2026-08-27T12:00:00Z"), "As of August 27, 2026 at 12:00 UTC");
  for (const value of [null, undefined, "bad", "2026-02-30T12:00:00Z", "2026-08-27"])
    assert.equal(packetAsOf(value), "");
});

test("share metadata contains only fixed CARR branding and the sourced as-of", () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector("main");
  assert.ok(root);
  appendPacketMetadata(root, "2026-08-27T12:00:00Z");
  assert.equal(root.querySelector(".packet-brand")?.textContent, "CARR");
  assert.equal(root.querySelector(".packet-as-of")?.textContent, "As of August 27, 2026 at 12:00 UTC");
  assert.equal(root.querySelector("time")?.dateTime, "2026-08-27T12:00:00.000Z");
});
