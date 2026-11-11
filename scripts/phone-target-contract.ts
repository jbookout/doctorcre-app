import assert from "node:assert/strict";
import type { inspectPhoneAccessibility } from "./phone-accessibility.ts";

type Observation = Awaited<ReturnType<typeof inspectPhoneAccessibility>> & {
  name: string;
  width: number;
  theme: string;
};

export const phoneStates = [
  "Home",
  "Deals board",
  "Deal",
  "Tours library",
  "Tour and cheat sheet",
  "Vendors Suggested",
  "Vendors Research",
  "Relationships",
  "Leads",
];

export function assertPhoneTargets(rows: Observation[]) {
  for (const theme of ["light", "dark"]) {
    const phone = rows.filter((row) => row.width === 390 && row.theme === theme);
    assert.deepEqual(
      phone.map((row) => row.name).sort(),
      [...phoneStates].sort(),
      `All nine phone states inspected once in ${theme}`,
    );
    for (const row of phone) {
      assert.deepEqual(row.small, [], `${row.name} ${theme}: every activation area is at least 44 by 44`);
      assert.deepEqual(row.covered, [], `${row.name} ${theme}: every visible center hits its activation owner`);
    }
  }
}
