import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { invalidateTaskRead, isCurrentTaskRead, shouldFocusTaskRetry } from "../js/task-read-epoch.mjs";

test("a failed identity read fences out an earlier successful board response", async () => {
  const view = { sequence: 8, status: "ready", rows: [{ number: "old" }], message: null };
  const oldBoardRead = ++view.sequence;
  let answerOldBoard;
  const pending = new Promise((resolve) => { answerOldBoard = resolve; }).then((rows) => {
    if (isCurrentTaskRead(view, oldBoardRead)) {
      view.rows = rows;
      view.status = "ready";
    }
  });
  invalidateTaskRead(view, "unverified", "Account unverified");
  answerOldBoard([{ number: "should-never-show" }]);
  await pending;
  assert.equal(isCurrentTaskRead(view, oldBoardRead), false);
  assert.equal(view.status, "unverified");
  assert.deepEqual(view.rows, []);
  assert.equal(view.message, "Account unverified");
});

test("a new identity check clears old actor rows before the new board settles", async () => {
  const view = { sequence: 2, status: "ready", rows: [{ owner: "joe" }], message: null };
  const previousBoardRead = ++view.sequence;
  let answerOldBoard;
  const pending = new Promise((resolve) => { answerOldBoard = resolve; }).then((rows) => {
    if (isCurrentTaskRead(view, previousBoardRead)) {
      view.rows = rows;
      view.status = "ready";
    }
  });
  invalidateTaskRead(view, "loading");
  answerOldBoard([{ owner: "joe", number: "old" }]);
  await pending;
  assert.equal(view.status, "loading");
  assert.deepEqual(view.rows, []);
  assert.equal(isCurrentTaskRead(view, previousBoardRead), false);
});

test("Tasks wires the identity fence before getBoard and rejects stale results", async () => {
  const source = await readFile(new URL("../js/task-records.js", import.meta.url), "utf8");
  assert.match(source, /function refuseUnverifiedViewer\(\) \{\s*\/\/[^\n]*\n\s*invalidateTaskRead\(view, "unverified"/);
  assert.match(source, /async function loadViewer\(\) \{[\s\S]*?invalidateTaskRead\(view, "loading"\);[\s\S]*?await client\.getBoard/);
  assert.match(source, /if \(identityRead !== viewerSequence\) return null/);
  assert.match(source, /if \(!isCurrentTaskRead\(view, sequence\)\) return/);
  assert.match(source, /if \(verified === null\) return;\s*if \(!verified\) \{ refuseUnverifiedViewer\(\); return; \}/);
});

test("a concealed task dialog sends keyboard focus to Retry only after a failed final read", async () => {
  for (const status of ["unverified", "error", "unauthorized"]) {
    assert.equal(shouldFocusTaskRetry(true, status), true);
    assert.equal(shouldFocusTaskRetry(false, status), false);
  }
  assert.equal(shouldFocusTaskRetry(true, "loading"), false);
  assert.equal(shouldFocusTaskRetry(true, "ready"), false);
  const source = await readFile(new URL("../js/task-records.js", import.meta.url), "utf8");
  assert.match(source, /if \(reconcileTaskDialog\(\) === "conceal"\) retryFocusPending = true;\s*render\(\);/);
  assert.match(source, /function settleTaskReadFocus\(dialogAction\) \{[\s\S]*?shouldFocusTaskRetry\(concealed, view\.status\)\) \$\("retryRead"\)\?\.focus\(\)/);
  assert.match(source, /function refuseUnverifiedViewer\(\) \{[\s\S]*?settleTaskReadFocus\(dialogAction\)/);
});
