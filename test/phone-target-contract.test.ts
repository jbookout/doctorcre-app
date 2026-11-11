import assert from "node:assert/strict";
import test from "node:test";
import { assertPhoneTargets, phoneStates } from "../scripts/phone-target-contract.ts";

const complete = () =>
  ["light", "dark"].flatMap((theme) =>
    phoneStates.map((name) => ({
      name,
      width: 390,
      theme,
      small: [],
      covered: [],
      clipped: [],
      positiveTabindex: [],
      violations: [],
      overflow: false,
    })),
  );

test("Absolute phone contract requires every state and rejects every observed offender", () => {
  assert.doesNotThrow(() => assertPhoneTargets(complete()));
  assert.throws(() => assertPhoneTargets(complete().slice(1)), /nine phone states/);
  const row = complete()[0];
  assert.ok(row);
  for (const kind of ["small", "covered"] as const) {
    const rows = complete();
    const first = rows[0];
    assert.ok(first);
    Reflect.set(first, kind, [{ selector: "#existing", width: 20, height: 20 }]);
    assert.throws(() => assertPhoneTargets(rows), /every/);
  }
});
