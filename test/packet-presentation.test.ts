import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parsePublicTourPacket } from "../src/ui/public-tour-packet.ts";
import { presentedPacket } from "./packet-presentation.fixture.ts";

const read = (file: string) => readFileSync(new URL(`./fixtures/tour-packet/${file}`, import.meta.url), "utf8");
const response = JSON.parse(read("response.json"));

test("packet fixture matches the recorded PR3182 producer response through the production parser", () => {
  const producer = JSON.parse(read("producer.json"));
  assert.equal(producer.source_commit, "fe5a1c1c4c56aa0a6c74b215576d0d667f51c007");
  assert.equal(createHash("sha256").update(read("tour-packet-template.ts")).digest("hex"), producer.sha256);
  assert.deepEqual(presentedPacket(response.stops), response);
  const packet = parsePublicTourPacket(response);
  assert.deepEqual(parsePublicTourPacket(presentedPacket(response.stops)), packet);
  assert.deepEqual(
    packet.map((stop) => stop.facts[3]?.value),
    Array(3).fill("USD 20 to 25 SF per year"),
  );
});

test("producer fixture preserves distinct size quantities and Unknown instead of a fake formatter", () => {
  const stops = response.stops.map((stop: Record<string, unknown>, index: number) => ({
    ...stop,
    size: { value: 1201 + index, unit: "SF" },
  }));
  const packet = parsePublicTourPacket(presentedPacket(stops));
  assert.deepEqual(
    packet.map((stop) => stop.facts[2]?.value),
    ["1202 SF", "1203 SF", "1201 SF"],
  );
  assert.ok(packet.every((stop) => stop.facts[0]?.value === "Unknown"));
});
