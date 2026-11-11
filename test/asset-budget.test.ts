import assert from "node:assert/strict";
import test from "node:test";
import { assetBudget } from "../scripts/asset-budget.ts";

test("artifact capacity counts its manifest and reserves 2,000 Cloudflare asset slots", () => {
  assert.deepEqual(assetBudget(401), { deployedFiles: 402, limit: 20000, headroom: 19598, minimumHeadroom: 2000 });
  assert.equal(assetBudget(17999).headroom, 2000);
  assert.throws(() => assetBudget(18000), /1999.*2000/);
  assert.throws(() => assetBudget(20000), /-1.*2000/);
});
