import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Ajv } from "ajv";
import { parseReviewOutcome } from "../src/ui/review-call-outcome.ts";

const contract = JSON.parse(await readFile("contracts/carr-interface.v1/review-call-outcome.v1.json", "utf8"));
const response = new Ajv().compile(contract.responseSchema);
const refusal = new Ajv().compile(contract.refusalSchema);
const sessionId = "20000000-0000-4000-8000-000000000100";
const receipt = { ok: true, session_id: sessionId, reviewed: true };
const payload = (value: unknown, isError = false) => ({ kind: "payload", payload: value, isError });

test("successful review and replay receipts clear the completed intent", () => {
  for (const value of [receipt, { ok: true, session_id: sessionId, already: "reviewed" }]) {
    for (const replayed of [false, true]) {
      const p = replayed ? { ...value, replayed: true } : value;
      assert.equal(response(p), true);
      assert.deepEqual(parseReviewOutcome(payload(p), sessionId), { kind: "success", intent: "clear" });
    }
  }
});

test("retryable errors and malformed or contradictory receipts retain the original intent", () => {
  for (const value of [
    { ...receipt, error: "partner_required" },
    { ...receipt, error: null },
    { ...receipt, extra: true },
    { ...receipt, already: "reviewed" },
    { ...receipt, reviewed: false },
    { ...receipt, replayed: false },
    { ok: true, session_id: sessionId },
    { error: "partner_required" },
    { ...contract.refusal, correlation_id: "synthetic", extra: true },
  ]) {
    assert.equal(response(value), false);
    assert.equal(refusal(value), false);
    assert.deepEqual(parseReviewOutcome(payload(value), sessionId), { kind: "retryable-error", intent: "retain" });
  }
  for (const result of [null, {}, payload(receipt, true), payload({ ...receipt, session_id: "foreign" })])
    assert.deepEqual(parseReviewOutcome(result, sessionId), { kind: "retryable-error", intent: "retain" });
});

test("terminal session refusal stops the attempt without inventing a completed receipt", () => {
  for (const status of [401, 403])
    assert.deepEqual(parseReviewOutcome({ kind: "authorization", status }, sessionId), {
      kind: "terminal-refusal",
      intent: "retain",
    });
});

test("contract-defined stale source refusal retains the old reference intent", () => {
  const p = { ...contract.refusal, correlation_id: "20000000-0000-4000-8000-000000000999" };
  assert.equal(refusal(p), true);
  for (const isError of [false, true])
    assert.deepEqual(parseReviewOutcome(payload(p, isError), sessionId), { kind: "stale-source", intent: "retain" });
});
