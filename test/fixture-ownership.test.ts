import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";

for (const shape of ["re-export", "direct worker", "URL worker"] as const) {
  test(`unowned fixture via ${shape} receives a typed refusal before acquisition`, async () => {
    const directory = await temporaryDirectory("doctorcre-fixture-ownership-");
    try {
      const harness = new URL("./browser-harness.mjs", import.meta.url).href;
      await writeFile(join(directory, "relay.ts"), `export { fixtureServer } from "${harness}";`);
      const source = `import { fixtureServer } from "${shape === "re-export" ? "./relay.ts" : harness}";
try { const server = await fixtureServer(); await server.close(); console.log("UNOWNED_STARTED"); }
catch (error) { console.log(JSON.stringify({name:error.name,code:error.code,message:error.message})); process.exitCode=78; }`;
      await writeFile(join(directory, "worker.ts"), source);
      await writeFile(
        join(directory, "consumer.ts"),
        `import {spawnSync} from 'node:child_process';
const result=spawnSync(process.execPath,[new URL('worker.ts',import.meta.url).pathname],{encoding:'utf8'});
process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.status;`,
      );
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(
        process.execPath,
        [join(directory, shape === "URL worker" ? "consumer.ts" : "worker.ts")],
        { encoding: "utf8", env, timeout: 30000 },
      );
      assert.equal(result.status, 78, result.stdout + result.stderr);
      const refusal = JSON.parse(result.stdout.split("\n")[0] ?? "");
      assert.equal(refusal.name, "FixtureOwnershipError");
      assert.equal(refusal.code, "FIXTURE_OWNER_REQUIRED");
      assert.match(refusal.message, /fixture-probe.ts/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("lower-level starter refuses absent and forged capabilities before spawning", async () => {
  const { startFixtureServer } = await import("../scripts/fixture-server.mjs");
  for (const capability of [undefined, {}, Symbol("fixture owner")]) {
    await assert.rejects(
      startFixtureServer({}, capability).then(async (server) => {
        await server.stop();
      }),
      { name: "FixtureOwnershipError", code: "FIXTURE_OWNER_REQUIRED" },
    );
  }
});

test("direct owner execution without its IPC lifecycle is refused", () => {
  const result = spawnSync(process.execPath, [new URL("./fixture-probe.ts", import.meta.url).pathname], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FixtureOwnershipError/);
});

test("owned starter forwards its configured environment and awaits shutdown", async () => {
  const { ownedServer } = await import("./fixture-probe.ts");
  const server = await ownedServer({
    env: { FIXTURE_PORT: "19876" },
    args: ["-e", 'console.log("http://127.0.0.1:" + process.env.FIXTURE_PORT); setInterval(() => {}, 1000)'],
  });
  try {
    assert.equal(server.url, "http://127.0.0.1:19876");
  } finally {
    await server.stop();
  }
  await server.stop();
});
