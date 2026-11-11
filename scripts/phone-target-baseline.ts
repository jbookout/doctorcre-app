import type { walkV2Accessibility } from "./v2-accessibility-walk.ts";

type BaselineRow = {
  kind: "undersized" | "covered";
  surface: string;
  theme: string;
  selector: string;
};
type Observation = Awaited<ReturnType<typeof walkV2Accessibility>>[number] & { width: number; theme: string };

export function phoneBaselineRows(results: Observation[]): BaselineRow[] {
  return results
    .filter((row) => row.width === 390)
    .flatMap((row) =>
      (["undersized", "covered"] as const).flatMap((kind) =>
        (kind === "undersized" ? row.small : row.covered).map((target) => ({
          kind,
          surface: row.name,
          theme: row.theme,
          selector: target.selector,
        })),
      ),
    );
}

export function comparePhoneBaseline(observed: BaselineRow[], baseline: BaselineRow[]): string[] {
  const key = (row: BaselineRow) => JSON.stringify([row.surface, row.theme, row.selector, row.kind]);
  const remaining = new Map(baseline.map((row) => [key(row), row]));
  const failures: string[] = [];
  if (remaining.size !== baseline.length) failures.push("Duplicate baseline targets");
  for (const row of observed) {
    const previous = remaining.get(key(row));
    if (!previous) failures.push(`New ${row.kind} target ${key(row)}`);
    remaining.delete(key(row));
  }
  for (const row of remaining.values()) failures.push(`Remove fixed or absent target from baseline ${key(row)}`);
  return failures;
}
