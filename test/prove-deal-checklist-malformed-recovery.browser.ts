import test from "node:test";
import { loadBrowserCases } from "./browser-proof-cases.ts";

for (const [name, run] of await loadBrowserCases("./prove-deal-checklist-malformed-recovery.test.mjs")) test(name, run);
