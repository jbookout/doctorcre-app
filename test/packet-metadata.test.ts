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

test("client appointment display omits missing or raw legacy timestamps", () => {
  for (const appointment of [undefined, null, "2031-03-04T14:00:00.123456+00:00 to 2031-03-04T14:30:00Z"]) {
    const input = structuredClone(recorded);
    const first = input.presentation.stops[0];
    assert.ok(first);
    Reflect.set(first, "appointment", appointment);
    const packet = readPacketPresentation(input);
    assert.ok(packet);
    const dom = new JSDOM("<main></main>");
    const root = dom.window.document.querySelector("main");
    assert.ok(root);
    appendPacketPresentation(root, packet.stops[0], packet.notes);
    assert.equal(root.querySelector(".packet-appointment"), null);
    assert.doesNotMatch(root.textContent, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  }
});

test("all recorded client surfaces contain readable appointment text without ISO timestamps", async () => {
  const { readFile } = await import("node:fs/promises");
  const { packetFixturePdf } = await import("../scripts/packet-fixture.ts");
  const { observePdf } = await import("../scripts/packet-pdf-observation.ts");
  const packet = readPacketPresentation(recorded);
  assert.ok(packet);
  assert.equal(packet.stops[0]?.appointment, "Tue, Mar 4, 8:00 to 8:30 AM CST");
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector("main");
  assert.ok(root);
  for (const stop of packet.stops) appendPacketPresentation(root, stop, packet.notes);
  const html = await readFile(new URL("./fixtures/packet-parity/packet.html", import.meta.url), "utf8");
  const pdf = await observePdf(await packetFixturePdf());
  for (const surface of [root.textContent, new JSDOM(html).window.document.body.textContent, JSON.stringify(pdf)])
    assert.doesNotMatch(surface, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
});
