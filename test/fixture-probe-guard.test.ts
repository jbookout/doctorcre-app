import assert from "node:assert/strict";
import test from "node:test";
import { checkFixtureProbes } from "../scripts/check-fixture-probes.ts";

const fixture = `import { fixtureServer as acquire } from './browser-harness.mjs';`;
for (const [name, source] of [
  [
    "fixed readiness race",
    `import { fixtureProbe } from './fixture-probe.ts'; Promise.race([fixtureProbe().ready, new Promise(r => setTimeout(r,4000))]);`,
  ],
  [
    "aliased acquisition race",
    `${fixture} const pending=acquire();Promise.race([pending,new Promise(r=>setTimeout(r,4000))]);`,
  ],
  [
    "pre-readiness kill",
    `import { fixtureProbe } from './fixture-probe.ts'; const p=fixtureProbe();setTimeout(()=>p.close(),5000);`,
  ],
  [
    "aliased spawn",
    `${fixture} import {spawn as launch} from 'node:child_process'; launch(process.execPath,['-e',"import('./browser-harness.mjs')"]);`,
  ],
  [
    "computed module",
    `import {spawn} from 'node:child_process'; const module='./browser-'+'harness.mjs'; const code=\`import('＄{module}')\`;spawn(process.execPath,['-e',code]);`.replace(
      "＄",
      "$",
    ),
  ],
  [
    "reexport",
    `import {spawn} from 'node:child_process'; import {acquire} from './relay.ts';spawn(process.execPath, unknown);`,
  ],
  ["inline program", `import {fork} from 'node:child_process';fork('./fixture-server.mjs');`],
  ["unresolved program", `${fixture} import {spawn} from 'node:child_process';spawn(process.execPath,['-e',code]);`],
  [
    "aliased timer",
    `import {fixtureProbe} from './fixture-probe.ts';import {setTimeout as later} from 'node:timers';later(()=>{},4000);`,
  ],
] as const) {
  test(`fixture probe guard refuses ${name}`, () => {
    assert.ok(
      checkFixtureProbes(
        new Map([
          ["test/new-probe.ts", source],
          ["test/relay.ts", `export {fixtureServer as acquire} from './browser-harness.mjs';`],
        ]),
      ).length > 0,
    );
  });
}
test("fixture probe guard admits only the owner API and unrelated CLI processes", () => {
  assert.deepEqual(
    checkFixtureProbes(
      new Map([
        [
          "test/consumer.ts",
          `import {fixtureProbe} from './fixture-probe.ts';const p=fixtureProbe();await p.ready;await p.exercise('abort');await p.close();`,
        ],
        [
          "test/cli.ts",
          `${fixture} import {spawn} from 'node:child_process';spawn(process.execPath,['scripts/prove-example.ts']);`,
        ],
      ]),
    ),
    [],
  );
});

test("strict CLI exits one for a seeded fixed budget and zero after removal", async (t) => {
  const { temporaryDirectory } = await import("../scripts/temp-directory.mjs");
  const { writeFile, rm } = await import("node:fs/promises");
  const { spawnSync } = await import("node:child_process");
  const directory = await temporaryDirectory("doctorcre-probe-guard-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", "-q", directory]).status, 0);
  const path = `${directory}/seed.ts`;
  await writeFile(
    path,
    `import {fixtureProbe} from './fixture-probe.ts'; Promise.race([fixtureProbe().ready,new Promise(r=>setTimeout(r,4000))]);`,
  );
  const command = new URL("../scripts/check-fixture-probes.ts", import.meta.url).pathname;
  const rejected = spawnSync(process.execPath, [command, directory], { encoding: "utf8" });
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /caller deadline/);
  await rm(path);
  const accepted = spawnSync(process.execPath, [command, directory], { encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);
});
