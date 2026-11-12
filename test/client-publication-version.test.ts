import assert from "node:assert/strict";
import test from "node:test";
import { commandFor, parsePublications, publicationFailure } from "../src/ui/client-publication-contract.ts";

const id = "11111111-1111-4111-8111-111111111111";
const file = {
  id,
  title: "Final report",
  kind: "deliverable",
  deliverable_id: id,
  deliverable_version: 7,
  version: 3,
  published: true,
};
const list = (row: object) => ({ ok: true, schema_version: "client-publications.v1", publications: [row] });
test("file publish and withdrawal retain the exact pinned version", () => {
  const [row] = parsePublications(list(file));
  assert.ok(row);
  const publish = commandFor(row, id, true),
    withdraw = commandFor(row, id, false);
  assert.equal(publish.kind, "deliverable");
  assert.equal(withdraw.kind, "deliverable");
  assert.ok("deliverable_version" in publish && "deliverable_version" in withdraw);
  assert.equal(publish.deliverable_version, 7);
  assert.equal(withdraw.deliverable_version, 7);
  assert.equal(commandFor(row, id, false).base_version, 3);
});
test("missing, fractional, unsafe and nonpositive file versions fail closed", () => {
  for (const deliverable_version of [undefined, 0, -1, 1.5, "7", Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => parsePublications(list({ ...file, deliverable_version })));
});

test("only known backend refusals receive a publication hint", () => {
  for (const error of ["toString", "constructor", "__proto__", "PRIVATE SQL"])
    assert.equal(publicationFailure({ error }), null);
  assert.equal(
    publicationFailure({ error: "publication_file_not_shared", message: "PRIVATE SQL" }),
    "Choose a finalized shared file from this deal, then refresh its version.",
  );
});
