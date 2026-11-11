import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { grantReceipt, prepareClientGrant, renderClientGrants } from "../src/ui/tour-client-grants.ts";

const projection = "11111111-1111-4111-8111-111111111111";
const grantId = "22222222-2222-4222-8222-222222222222";
const now = Date.parse("2026-11-10T12:00:00Z");
test("create uses an opaque token and sends only hashes with explicit permissions", async () => {
  const grant = await prepareClientGrant({
    projectionId: projection,
    scopes: ["view_packet", "comment"],
    expiresAt: "2026-11-11T12:00:00Z",
    now,
  });
  assert.match(grant.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(grant.payload.token_digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(grant.payload.receipt_digest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(grant.payload).includes(grant.token));
  assert.deepEqual(grant.payload.permission_scopes, ["view_packet", "comment"]);
  const other = await prepareClientGrant({
    projectionId: projection,
    scopes: ["view_packet"],
    expiresAt: "2026-11-11T12:00:00Z",
    now,
  });
  assert.notEqual(grant.token, other.token);
});
test("rotation binds the predecessor and preserves separate download authority", async () => {
  const options = {
    projectionId: projection,
    scopes: ["view_packet"],
    expiresAt: "2026-11-11T12:00:00Z",
    now,
    grantId,
  };
  assert.equal((await prepareClientGrant(options)).payload.share_grant_id, grantId);
  assert.deepEqual(
    (await prepareClientGrant({ ...options, scopes: ["view_packet", "download"] })).payload.permission_scopes,
    ["view_packet", "download"],
  );
  await assert.rejects(prepareClientGrant({ ...options, scopes: ["download"] }));
  await assert.rejects(prepareClientGrant({ ...options, scopes: ["comment"] }));
  await assert.rejects(prepareClientGrant({ ...options, scopes: [] }));
  await assert.rejects(prepareClientGrant({ ...options, expiresAt: "2026-11-10T12:00:00Z" }));
  await assert.rejects(prepareClientGrant({ ...options, projectionId: "wrong" }));
});
test("revocation receipts are deterministic for the exact retained request", async () => {
  const payload = { share_grant_id: grantId, revoked_at: "2026-11-10T12:00:00Z", idempotency_key: projection };
  assert.equal(await grantReceipt(payload), await grantReceipt(payload));
  assert.notEqual(await grantReceipt(payload), await grantReceipt({ ...payload, share_grant_id: projection }));
});
for (const state of ["active", "revoked", "rotated", "expired"])
  test(`panel renders ${state} with permissions and only offers valid revocation`, () => {
    const dom = new JSDOM("<ul></ul>");
    const list = dom.window.document.querySelector("ul");
    assert.ok(list);
    renderClientGrants(
      list,
      [
        {
          share_grant_id: grantId,
          status: state,
          permission_scopes: ["view_packet", "comment"],
          expires_at: "2026-11-11T12:00:00Z",
        },
      ],
      now,
    );
    assert.match(list.textContent ?? "", /View tour · Comment/);
    assert.match(
      list.textContent ?? "",
      new RegExp(
        state === "active"
          ? "Active"
          : state === "rotated"
            ? "Replaced"
            : state.charAt(0).toUpperCase() + state.slice(1),
      ),
    );
    assert.equal(list.querySelectorAll("button").length, state === "active" ? 1 : 0);
  });
test("panel derives expiry and never exposes canonical projection identifiers", () => {
  const dom = new JSDOM("<ul></ul>");
  const list = dom.window.document.querySelector("ul");
  assert.ok(list);
  renderClientGrants(
    list,
    [
      {
        share_grant_id: grantId,
        status: "active",
        permission_scopes: ["view_packet"],
        expires_at: "2026-11-10T12:00:00Z",
        projection_id: projection,
      },
    ],
    now,
  );
  assert.match(list.textContent ?? "", /Expired/);
  assert.ok(!(list.textContent ?? "").includes(projection));
  assert.equal(list.querySelectorAll("button").length, 0);
});
