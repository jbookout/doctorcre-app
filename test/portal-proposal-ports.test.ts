import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { proposalSelectionPorts } from "../src/ui/portal/proposal-ports.ts";
import type { Proposal } from "../src/ui/portal/tour-list-state.ts";
import { createTourList } from "../src/ui/portal/tour-list-state.ts";

const receipt = JSON.parse(readFileSync("contracts/fixtures/portal-proposals.v1.json", "utf8"));
const id = receipt.selection.selected[0];
const scope = { publication_id: receipt.publication_id, publication_version: 1 };
const properties = [{ id, number: 1, address: "Synthetic property", summary: "Synthetic", role: "candidate" as const }];
const tick = () => new Promise((resolve) => setImmediate(resolve));
function setup(read = async () => receipt, save = async (_version: number, _request: Proposal) => receipt) {
  return proposalSelectionPorts({
    scope,
    properties,
    transport: { read, save },
    signOut: async () => {},
    clearPrivateState() {},
    returnToGate() {},
  });
}
test("producer recording loads exact saved version, membership and notes", async () => {
  const ports = setup();
  assert.deepEqual(
    JSON.parse(JSON.stringify(await ports.read({ signal: new AbortController().signal }))),
    receipt.selection,
  );
});
test("foreign publication, stale publication, unknown enum and unrecognized IDs refuse without normalization", async () => {
  for (const value of [
    { ...receipt, publication_id: "00000000-0000-4000-8000-000000000099" },
    { ...receipt, publication_version: 2 },
    { ...receipt, status: "future-success" },
    { ...receipt, selection: { ...receipt.selection, selected: [` ${id}`] } },
  ]) {
    await assert.rejects(setup(async () => value).read({ signal: new AbortController().signal }));
  }
});
test("retired entries preserve original IDs and notes and require explicit removal before saving", async () => {
  const ports = proposalSelectionPorts({
    scope,
    properties: [],
    transport: { read: async () => ({ ...receipt, retired: [id] }), save: async () => receipt },
    signOut: async () => {},
    clearPrivateState() {},
    returnToGate() {},
  });
  const model = createTourList([], ports);
  await tick();
  assert.equal(String(model.state.kind), "ready");
  assert.deepEqual(
    model.properties.map((p) => p.id),
    [id],
  );
  assert.equal("draft" in model.state && model.state.draft.notes[id], "Client note");
  model.edit(id, false);
  assert.equal(String(model.state.kind), "dirty");
  model.edit(id, true);
  assert.deepEqual("draft" in model.state && model.state.draft.selected, []);
  model.dispose();
});
test("transport uncertainty retries frozen request and exact source revision; conflicts lock edits", async () => {
  const requests: unknown[] = [];
  let failure = "lost";
  const model = createTourList(
    properties,
    setup(
      async () => receipt,
      async (version, request) => {
        assert.equal(version, 1);
        requests.push(request);
        if (failure === "lost") throw Error("lost");
        if (failure === "conflict") throw { status: 409 };
        return { ...receipt, selection: { ...request, version: 2 } };
      },
    ),
  );
  await tick();
  model.note(id, "Exact new note");
  await model.save();
  assert.equal(String(model.state.kind), "uncertain");
  failure = "";
  await model.save();
  assert.equal(String(model.state.kind), "ready");
  assert.equal(requests[0], requests[1]);
  model.note(id, "Another note");
  failure = "conflict";
  await model.save();
  assert.equal(String(model.state.kind), "conflict");
  model.edit(id, false);
  assert.deepEqual("draft" in model.state && model.state.draft.selected, [id]);
  await model.reload(true);
  assert.equal(String(model.state.kind), "ready");
  model.dispose();
});

test("pinned producer contract and recording retain their source hashes", () => {
  const provenance = JSON.parse(readFileSync("contracts/portal-proposals.provenance.json", "utf8"));
  assert.equal(provenance.commit, "1809cc7e3c52eb649707e6ac664dfb33dc5a60e1");
  for (const [path, digest] of Object.entries(provenance.files))
    assert.equal(
      createHash("sha256")
        .update(readFileSync(`contracts/${path}`))
        .digest("hex"),
      digest,
    );
});
