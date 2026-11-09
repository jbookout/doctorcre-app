import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseExactCard } from "../src/ui/exact-action-card.ts";

const fixtures: unknown[] = JSON.parse(await readFile("test/fixtures/action-card-targets.v2.json", "utf8"));
test("lifecycle cards retain exact identity and suppress unavailable operations", () => {
  const value = fixtures[0];
  assert.ok(
    typeof value === "object" &&
      value !== null &&
      "card" in value &&
      typeof value.card === "object" &&
      value.card !== null &&
      "ref" in value &&
      typeof value.ref === "string",
  );
  for (const state of ["stale", "resolved", "retired"]) {
    const card: Record<string, unknown> = {
      ...value.card,
      state,
      actions: [],
      ...(state === "retired" ? { detail: null } : {}),
    };
    const parsed = parseExactCard({ ...value, card }, value.ref);
    assert.ok(parsed);
    assert.equal(parsed.state, state);
    assert.equal(
      parseExactCard(
        {
          ...value,
          card: {
            ...card,
            actions: [{ action: "review", verb: "review-call-outcome", args: { session_id: "foreign" } }],
          },
        },
        value.ref,
      ),
      null,
    );
  }
});
for (const [index, value] of fixtures.entries())
  test(`recorded producer card ${index} binds exact identity`, () => {
    assert.ok(typeof value === "object" && value !== null && "ref" in value && typeof value.ref === "string");
    const card = parseExactCard(value, value.ref);
    assert.ok(card);
    assert.equal(parseExactCard(value, `${value.ref}A`), null);
    assert.equal(parseExactCard({ ...value, card: { ...card, id: `${card.id.slice(0, -1)}f` } }, value.ref), null);
  });

test("exact review contracts retain the pinned producer bytes", async () => {
  for (const [name, digest] of [
    ["review-call-outcome.v1.json", "16fd6959de22e9c15d20b3c23ecfd7fec0f08aaca10c3fa636d8e25a99f53ab7"],
    ["action-link-resolve.v2.json", "a9eb245d40445044ef60bf318e6b148b37206b41118cf57b7b99eb12066ef113"],
  ]) {
    assert.equal(
      createHash("sha256")
        .update(await readFile(`contracts/carr-interface.v1/${name}`))
        .digest("hex"),
      digest,
    );
  }
});
