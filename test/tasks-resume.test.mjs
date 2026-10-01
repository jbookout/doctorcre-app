import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("Tasks rereads its board after a hidden tab returns without filing or replacing a draft", async () => {
  const source = await readFile(`${ROOT}/js/task-records.js`, "utf8");
  assert.match(source, /mountAutoRefresh\(\{\s*document,\s*window: globalThis\.window,\s*refresh:/);
  assert.match(source, /mountAutoRefresh\([\s\S]*?await refreshVerified\(\);\s*renderQuickAdd\(\);/);
  assert.match(source, /if \(!client\.selfActor\) await refreshVerified\(\);\s*else await load\(\);/);
  const callback = source.match(/mountAutoRefresh\(\{ document, window: globalThis\.window, refresh: async \(\) => \{([\s\S]*?)\} \}\)/)?.[1];
  assert.ok(callback);
  assert.doesNotMatch(callback, /client\.(?:addLoop|updateLoop|closeLoop)/);
});
