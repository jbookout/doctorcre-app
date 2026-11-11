import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { appendPacketPresentation, readPacketPresentation } from "../src/ui/packet-presentation.ts";
import recorded from "./fixtures/packet-parity/share.json" with { type: "json" };

test("recorded 2.1.0 packet preserves producer appointments and explicit public notes", () => {
  const packet = readPacketPresentation(recorded);
  assert.ok(packet);
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector("main");
  assert.ok(root);
  const stop = packet.stops[0];
  assert.ok(stop);
  appendPacketPresentation(root, stop, packet.notes);
  assert.equal(root.querySelector(".packet-appointment")?.textContent, stop.appointment);
  assert.equal(root.querySelector(".packet-public-note")?.textContent, stop.public_packet_note);
  assert.deepEqual(
    Array.from(root.querySelectorAll("dd"), (n) => n.textContent),
    stop.facts.map((f) => f.value),
  );
  root.replaceChildren();
  appendPacketPresentation(root, packet.stops[1], packet.notes);
  assert.equal(root.querySelector(".packet-appointment"), null);
  assert.equal(root.querySelector(".packet-public-note"), null);
});

test("unsupported packet contracts refuse without a legacy formatter", () => {
  for (const value of [
    null,
    {},
    { ...recorded, contract_version: "2.0.0" },
    { ...recorded, renderer_version: "1.1.0" },
  ])
    assert.equal(readPacketPresentation(value), null);
});

test("internal notes cannot supply an unset public note", () => {
  const packet = readPacketPresentation(recorded);
  assert.ok(packet);
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector("main");
  const stop = packet.stops[1];
  assert.ok(root && stop);
  appendPacketPresentation(root, { ...stop, ...{ internal_notes: "PRIVATE_CANARY" } }, packet.notes);
  assert.doesNotMatch(root.textContent, /PRIVATE_CANARY/);
});
