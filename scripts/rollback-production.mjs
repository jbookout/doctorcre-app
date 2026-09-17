import { execFileSync } from "node:child_process";

const versionId = process.argv[2];
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(versionId || "")) {
  throw new Error("usage: npm run rollback:production -- <exact-version-id>");
}

execFileSync("npx", ["wrangler", "versions", "deploy", `${versionId}@100%`, "--env", "",
  "--message", `DoctorCRE production rollback to ${versionId}`, "--yes"], {
  cwd: new URL("../", import.meta.url),
  stdio: "inherit",
});
