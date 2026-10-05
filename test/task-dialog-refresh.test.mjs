import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { taskDialogTransition } from "../js/task-records-model.js";

const open = { key: "team_loop:201", viewer: "joe", closing: "done", outcome: "Counsel confirmed" };
const rows = [{ kind: "team_loop", number: "201" }];

test("a failed board read conceals the task detail and retains typed close text only in page memory", () => {
  const failed = taskDialogTransition({ status: "error", open, held: null, rows: [], viewer: "joe" });
  assert.equal(failed.action, "conceal");
  assert.deepEqual(failed.held, open);
  const ended = taskDialogTransition({ status: "unauthorized", open, held: null, rows: [], viewer: "joe" });
  assert.equal(ended.action, "conceal");
  assert.equal(ended.held, null, "a finished session does not retain a private outcome for a future actor");
  assert.equal(taskDialogTransition({ status: "unauthorized", open: null, held: open, rows: [], viewer: "joe" }).held, null);
  const unverified = taskDialogTransition({ status: "unverified", open, held: null, rows: [], viewer: "joe" });
  assert.equal(unverified.action, "conceal");
  assert.equal(unverified.held, null, "failed identity verification never carries a close outcome forward");
});

test("a valid reread refreshes an open task without clearing its typed close outcome", () => {
  const refreshed = taskDialogTransition({ status: "ready", open, held: null, rows, viewer: "joe" });
  assert.equal(refreshed.action, "refresh");
  assert.deepEqual(refreshed.snapshot, open);
  assert.equal(refreshed.held, null);
  const changedActor = taskDialogTransition({ status: "ready", open, held: null, rows, viewer: "dell" });
  assert.equal(changedActor.action, "discard", "a different actor never inherits the prior actor's typed outcome");
});

test("retry restores a concealed task only for the same actor and still-open row", () => {
  const restored = taskDialogTransition({ status: "ready", open: null, held: open, rows, viewer: "joe" });
  assert.equal(restored.action, "restore");
  assert.deepEqual(restored.snapshot, open);
  assert.equal(restored.held, null);
  for (const options of [{ rows: [] }, { viewer: "dell" }]) {
    const refused = taskDialogTransition({ status: "ready", open: null, held: open, rows, viewer: "joe", ...options });
    assert.equal(refused.action, "discard");
    assert.equal(refused.held, null);
  }
});

test("Tasks routes invalid and failed reads through the dialog guard before painting", async () => {
  const source = await readFile(new URL("../js/task-records.js", import.meta.url), "utf8");
  assert.match(source, /view\.message = "The board answered[\s\S]*?dialogAction = reconcileTaskDialog\(\);\s*render\(\);/);
  assert.match(source, /view\.message = view\.status === "unauthorized"[\s\S]*?dialogAction = reconcileTaskDialog\(\);/);
  assert.match(source, /transition\.action === "conceal" \|\| transition\.action === "discard"\) \{\s*closeDialog\(\)/);
  assert.match(source, /settleTaskReadFocus\(dialogAction\)/);
  assert.match(source, /key: view\.open, viewer: view\.openViewer,/,
    "the modal snapshot must retain the actor who opened it, not the actor on the latest board read");
});
