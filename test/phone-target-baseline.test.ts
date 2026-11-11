import assert from "node:assert/strict";
import test from "node:test";
import { comparePhoneBaseline } from "../scripts/phone-target-baseline.ts";

const target = {
  kind: "undersized" as const,
  surface: "Home",
  theme: "light",
  selector: "#small",
  width: 20,
  height: 20,
};
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

test("Coverage and size allowances are independent and shrink-only", () => {
  const covered = { ...target, kind: "covered" as const };
  assert.match(comparePhoneBaseline([covered], [target]).join("\n"), /New covered target/);
  assert.deepEqual(comparePhoneBaseline([covered, target], [covered, target]), []);
  assert.match(comparePhoneBaseline([target], [covered, target]).join("\n"), /Remove fixed/);
  assert.match(comparePhoneBaseline([{ ...covered, width: 19 }], [covered]).join("\n"), /got smaller/);
});
