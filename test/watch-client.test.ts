import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createWatchClient } from "../src/ui/watches/client.ts";

const fixture: unknown = JSON.parse(readFileSync(new URL("./fixtures/watches/recorded.json", import.meta.url), "utf8"));
const subject = { subject_type: "deal", subject_id: "3c8b7e16-50f8-40de-a757-bf9583df4dd2" } as const;
test("watch transport validates producer payload and classifies stale or unknown outcomes", async () => {
  const client = createWatchClient(async () => ({ kind: "payload", payload: fixture, isError: false }));
  assert.equal((await client("read-subject-watch-v2", subject, new AbortController().signal)).kind, "confirmed");
  for (const [payload, kind] of [
    [{ error: "watch_stale_version" }, "conflict"],
    [{}, "unknown"],
    [{ error: "human_caller_required" }, "denied"],
  ] as const) {
    const client = createWatchClient(async () => ({ kind: "payload", payload, isError: true }));
    assert.equal((await client("read-subject-watch-v2", subject, new AbortController().signal)).kind, kind);
  }
});

test("a retired session reported by the shared transport asks for sign-in", async () => {
  const client = createWatchClient(async () => ({
    kind: "unconfirmed",
    reason: "network",
    cause: { status: 401, code: "authentication_required" },
  }));
  assert.equal((await client("read-subject-watch-v2", subject, new AbortController().signal)).kind, "denied");
});
