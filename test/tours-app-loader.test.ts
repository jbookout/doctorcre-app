import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { buildToursAppScript } from "./tours-app-loader.ts";

const source = await readFile(new URL("../tours/app.js", import.meta.url), "utf8");

test("Tour fixtures resolve a newly added import without another fixture binding", async () => {
  const script = await buildToursAppScript(
    'import { tourDisplayName as addedName } from "./tour-format.js"; globalThis.result = addedName("New dependency");',
  );
  const context = vm.createContext({ URL });
  vm.runInContext(script, context);
  assert.equal(context.result, "New dependency");
});

test("Tour fixture construction refuses an unresolved new app import", async () => {
  await assert.rejects(
    buildToursAppScript(
      `${source}\nimport { missing } from "./missing-fixture-dependency.js"; globalThis.result = missing;`,
    ),
    /Could not resolve/,
  );
});

test("Tour fixture construction refuses an unavailable named export", async () => {
  await assert.rejects(
    buildToursAppScript(`${source}\nimport { missing } from "./tour-format.js"; globalThis.result = missing;`),
    /No matching export/,
  );
});

test("the complete current Tour app resolves before any fixture runs", async () => {
  assert.ok((await buildToursAppScript()).length > 0);
});
