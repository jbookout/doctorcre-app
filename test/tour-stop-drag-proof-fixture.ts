import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { startFixture } from "../scripts/fixture-http.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";

export async function runTourDragProofFixture(
  routes: Map<string, { contentType: string; body: string }>,
  dealId: string,
  context: TestContext,
) {
  const server = await startFixture({ routes });
  try {
    const directory = temporaryDirectory("tour-drag-proof-", context);
    const storage = `${directory}/state.json`;
    await writeFile(storage, JSON.stringify({ cookies: [], origins: [] }));
    return await promisify(execFile)(
      process.execPath,
      [
        "scripts/prove-tour-stop-drag.ts",
        "--origin",
        server.origin,
        "--expected-commit",
        "1".repeat(40),
        "--tour-url",
        `${server.origin}/deals?deal=${dealId}`,
        "--storage-state",
        storage,
        "--timeout-ms",
        "30000",
      ],
      { timeout: 40000 },
    );
  } finally {
    await server.close();
  }
}
