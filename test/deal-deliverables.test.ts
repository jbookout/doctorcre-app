import assert from "node:assert/strict";
import test from "node:test";
import { parseDeliverable, parseDeliverableList } from "../src/ui/deal-deliverable-contract.ts";

const deal = "11111111-1111-4111-8111-111111111111";
const row = {
  id: "22222222-2222-4222-8222-222222222222",
  deal_id: deal,
  filename: "Partner.pdf",
  mime: "application/pdf",
  bytes: 5,
  sha256: "a".repeat(64),
  state: "finalized",
  visibility: "private",
  version: 1,
};
test("canonical deliverable validates exact deal, hash, size, version and designation", () => {
  assert.deepEqual(parseDeliverable(row, deal), row);
  for (const change of [
    { deal_id: crypto.randomUUID() },
    { sha256: "a" },
    { bytes: 0 },
    { version: 0 },
    { visibility: "published" },
    { state: "verified" },
  ])
    assert.throws(() => parseDeliverable({ ...row, ...change }, deal));
});
test("canonical list refuses wrong schema and repeated identities", () => {
  assert.equal(
    parseDeliverableList({ ok: true, schema_version: "deal-deliverables.v1", deliverables: [row] }, deal).length,
    1,
  );
  assert.throws(() =>
    parseDeliverableList({ ok: true, schema_version: "deal-documents.v1", deliverables: [row] }, deal),
  );
  assert.throws(() =>
    parseDeliverableList({ ok: true, schema_version: "deal-deliverables.v1", deliverables: [row, row] }, deal),
  );
});
