import test from "node:test";
import { loadBrowserCases } from "./browser-proof-cases.ts";

for (const [name, run] of await loadBrowserCases("./prove-answer-table-sourced-csv-download.test.mjs")) test(name, run);
