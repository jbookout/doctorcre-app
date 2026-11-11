import assert from "node:assert/strict";
import test from "node:test";
import { comparePhoneBaseline } from "../scripts/phone-target-baseline.ts";

const target = { surface: "Home", theme: "light", selector: "#small", width: 20, height: 20 };
test("Phone baseline accepts existing targets without growth in debt", () => {
  assert.deepEqual(comparePhoneBaseline([target], [target]), []);
});
test("Phone baseline rejects new 20 px targets", () => {
  assert.equal(comparePhoneBaseline([target], []).length, 1);
});
test("Phone baseline rejects a target shrinking on either axis", () => {
  assert.equal(comparePhoneBaseline([{ ...target, height: 19 }], [target]).length, 1);
});
test("A fixed target must be removed from the baseline", () => {
  assert.equal(comparePhoneBaseline([], [target]).length, 1);
  assert.deepEqual(comparePhoneBaseline([], []), []);
});
