import test from "node:test";
import assert from "node:assert/strict";
import { groupConversations, summarizeNow, threadKey } from "../js/observatory-model.js";

const turn = (seq, seat, body, at = "2026-09-29T12:00:00Z") =>
  ({ seq: String(seq), seat, sponsor: "joe", kind: "turn", body, at, msg_id: `m${seq}` });

test("thread keys use explicit work identity and keep unrelated turns apart", () => {
  assert.equal(threadKey(turn(1, "human", "WR-000123: inspect the release")), "wr-000123");
  assert.equal(threadKey(turn(2, "codex", "On WR-000123, the release check passed")), "wr-000123");
  assert.notEqual(threadKey(turn(3, "sol", "Unrelated answer")), "wr-000123");
});

test("each conversation is ordered and archive metadata names speakers, dates and count", () => {
  const threads = groupConversations([
    turn(7, "codex", "WR-000123: done"),
    turn(5, "human", "WR-000123: inspect the release"),
    turn(6, "sol", "WR-000124: check another thing"),
  ]);
  assert.deepEqual(threads.find((x) => x.key === "wr-000123").turns.map((x) => x.seq), ["5", "7"]);
  assert.deepEqual(threads.find((x) => x.key === "wr-000123").participants, ["Joe", "Codex"]);
  assert.equal(threads.find((x) => x.key === "wr-000123").turnCount, 2);
});

test("a human prompt and its unkeyed replies read as one conversation", () => {
  const threads = groupConversations([
    turn(13, "human", "What is running now?"),
    turn(11, "codex", "The release check passed."),
    turn(12, "claude", "The migration remains open."),
    turn(10, "human", "Check this release."),
  ]);
  assert.deepEqual(threads.find((thread) => thread.key === "turn:m10").turns.map((row) => row.seq), ["10", "11", "12"]);
  assert.deepEqual(threads.find((thread) => thread.key === "turn:m13").turns.map((row) => row.seq), ["13"]);
});

test("now summary reads current presence, failures and completions without treating old data as live", () => {
  const now = Date.parse("2026-09-29T12:05:00Z");
  const rows = [
    { ...turn(1, "codex", "WR-000123: building"), at: "2026-09-29T12:03:00Z" },
    { ...turn(2, "hermes", JSON.stringify({ session_presence: { handle: "codex-a", title: "Build Observatory", model: "gpt-6-sol", beat_at: "2026-09-29T12:04:00Z" } })), kind: "receipt" },
    { ...turn(3, "hermes", JSON.stringify({ queue_completion: { outcome: "success", summary: "Release verified" } })), kind: "receipt" },
  ];
  const result = summarizeNow(rows, now);
  assert.equal(result.running.length, 1);
  assert.equal(result.finished.length, 1);
  assert.equal(result.latestTurns.length, 1);
  assert.equal(result.latestTurns[0].body, "WR-000123: building");
});
