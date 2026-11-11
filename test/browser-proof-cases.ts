import assert from "node:assert/strict";
import type { TestContext } from "node:test";

type BrowserCase = [string, (context: TestContext) => Promise<void>];

export async function loadBrowserCases(path: string): Promise<BrowserCase[]> {
  const module: unknown = await import(path);
  assert.ok(typeof module === "object" && module !== null && "browserCases" in module);
  const cases: unknown = module.browserCases;
  assert.ok(Array.isArray(cases));
  const result: BrowserCase[] = [];
  for (const entry of cases) {
    assert.ok(Array.isArray(entry));
    const [name, run]: unknown[] = entry;
    if (typeof name !== "string" || typeof run !== "function") throw Error("Invalid browser proof case");
    result.push([
      name,
      async (context) => {
        await run(context);
      },
    ]);
  }
  return result;
}
