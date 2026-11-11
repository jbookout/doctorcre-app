import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents:
      "export {readQuickSwitcherSources,switcherInboxReader} from './src/ui/quick-switcher'; export {fixtureInboxRpc} from './src/ui/home/fixture';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
assert.ok(bundle.outputFiles[0]);
const { readQuickSwitcherSources, switcherInboxReader, fixtureInboxRpc } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);

test("switcher uses registered inbox version fallback and rejects malformed or refused reads", async () => {
  const fixture = fixtureInboxRpc();
  const calls: string[] = [];
  const read = switcherInboxReader(async (name: string) => {
    calls.push(name);
    return {
      kind: "payload",
      payload: name === "read-home-inbox-v5" ? { error: "unknown_tool" } : await fixture(name, {}),
    };
  }, false);
  const snapshot = await read();
  assert.equal(snapshot.schema_version, "home-inbox.v4");
  assert.deepEqual(calls, ["read-home-inbox-v5", "read-home-inbox-v4"]);
  for (const result of [
    { kind: "payload", payload: { ok: true } },
    { kind: "payload", isError: true, payload: { error: "permission_denied" } },
    { kind: "unavailable" },
  ]) {
    let reads = 0;
    await assert.rejects(
      switcherInboxReader(async () => {
        reads++;
        return result;
      }, false)(),
    );
    assert.equal(reads, 1);
  }
});

test("three reads start together and each failure preserves successful sources", async () => {
  for (const failed of [0, 1, 2]) {
    const started: number[] = [];
    let release: (value: string) => void = () => {
      throw Error("Not started");
    };
    const held = new Promise<string>((resolve) => {
      release = resolve;
    });
    const readers = [0, 1, 2].map((source) => async () => {
      started.push(source);
      if (source === failed) throw Error("Unavailable");
      return held;
    });
    const pending = readQuickSwitcherSources(readers[0], readers[1], readers[2]);
    await Promise.resolve();
    assert.deepEqual(started, [0, 1, 2]);
    release("accessible");
    assert.deepEqual(
      Object.values(await pending),
      [0, 1, 2].map((source) => (source === failed ? null : "accessible")),
    );
  }
});
