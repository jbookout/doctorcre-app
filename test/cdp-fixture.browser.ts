import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "../scripts/proof-browser.mjs";
import { cdpEndpoint } from "./cdp-fixture.ts";

for (const fault of ["missing file", "malformed file", "endpoint refusal"]) {
  test(`CDP acquisition diagnoses ${fault} and closes its owner`, async (t) => {
    const browser = await chromium.launch({ args: ["--remote-debugging-port=0", "--enable-automation"] });
    t.after(() => browser.close());
    await assert.rejects(
      cdpEndpoint(browser, {
        timeoutMs: 150,
        readPortFile: async () => {
          if (fault === "missing file") throw Object.assign(new Error("synthetic missing file"), { code: "ENOENT" });
          return fault === "malformed file" ? "65536\n" : "1\n";
        },
      }),
      /CDP acquisition.*phase=.*browser.*diagnostics/s,
    );
    assert.equal(browser.isConnected(), false);
  });
}
test("CDP acquisition waits for delayed file visibility and validates the endpoint", async (t) => {
  const browser = await chromium.launch({ args: ["--remote-debugging-port=0", "--enable-automation"] });
  t.after(() => browser.close());
  let release!: () => void;
  const visible = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed!: () => void;
  const reading = new Promise<void>((resolve) => {
    observed = resolve;
  });
  let hidden = true;
  const acquisition = cdpEndpoint(browser, {
    readPortFile: async (path) => {
      observed();
      if (hidden) throw new Error("not visible yet");
      await visible;
      return readFile(path, "utf8");
    },
  });
  await reading;
  hidden = false;
  release();
  const endpoint = await acquisition;
  const connection = await (await import("playwright")).chromium.connectOverCDP(endpoint);
  await connection.close();
  assert.equal(browser.isConnected(), true);
});
test("close during CDP acquisition rejects and drains the owner", async (t) => {
  const browser = await chromium.launch({ args: ["--remote-debugging-port=0", "--enable-automation"] });
  t.after(() => browser.close());
  let reading!: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const acquiring = cdpEndpoint(browser, {
    timeoutMs: 200,
    readPortFile: async () => {
      reading();
      throw new Error("not visible yet");
    },
  });
  const rejection = assert.rejects(acquiring, /CDP acquisition/);
  await started;
  await browser.close();
  await rejection;
  assert.equal(browser.isConnected(), false);
});
