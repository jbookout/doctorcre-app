import assert from "node:assert/strict";
import { buildSync } from "esbuild";

const built = buildSync({
  entryPoints: [new URL("../src/ui/tour-client-grants.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "clientGrantHelpers",
});
const output = built.outputFiles[0];
assert.ok(output);

export const clientGrantsScript = `${output.text}\nconst { prepareClientGrant, grantReceipt, renderClientGrants } = clientGrantHelpers;`;
