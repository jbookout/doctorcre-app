import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { draftIdentityPlan } from "../js/task-draft-identity.mjs";

test("local task drafts stay with their verified actor", () => {
  assert.equal(draftIdentityPlan("joe", "joe"), "reuse");
  assert.equal(draftIdentityPlan("joe", "dell"), "replace");
  assert.equal(draftIdentityPlan(null, "joe"), "first");
  assert.equal(draftIdentityPlan("joe", null), "refuse");
});

test("Tasks hides Quick Add before identity and on verification failure", async () => {
  const html = await readFile(new URL("../tasks.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../js/task-records.js", import.meta.url), "utf8");
  assert.match(html, /<form[^>]*id="quickAddForm"[^>]*hidden/);
  assert.match(source, /function refuseUnverifiedViewer\(\) \{[\s\S]*?heldQuickAdd = \{/);
  assert.match(source, /if \(view\.status === "unverified"\) \$\("quickAddForm"\)\.hidden = true/);
  assert.match(source, /if \(plan === "reuse" && unverifiedPreviousActor && heldQuickAdd\?\.actor === board\.actor\)/);
});
