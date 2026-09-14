import { fileURLToPath } from "node:url";
import { runCli } from "./artifact.mjs";

await runCli(fileURLToPath(new URL("../", import.meta.url)));
