import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { quickAddStartsOpen } from "../js/task-records-model.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const html = await read("tasks.html");
const css = await read("css/tasks.css");
const js = await read("js/task-records.js");

test("Quick add starts collapsed on a phone and open on a wider screen", () => {
  assert.equal(quickAddStartsOpen({ phone: true }), false);
  assert.equal(quickAddStartsOpen({ phone: false }), true);
  assert.equal(quickAddStartsOpen({ phone: true, hasDraftText: true }), true);
});
