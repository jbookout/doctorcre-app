import test from "node:test";
import { loadBrowserCases } from "./browser-proof-cases.ts";

for (const [name, run] of await loadBrowserCases("./prove-quiet-vendor-owner-filter.test.mjs")) test(name, run);
