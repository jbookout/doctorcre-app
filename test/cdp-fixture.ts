import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { type Browser, chromium } from "playwright";
import { browserDiagnostics } from "../scripts/proof-browser.mjs";

export async function cdpEndpoint(
  browser: Browser,
  {
    timeoutMs = 30000,
    readPortFile = readFile,
  }: { timeoutMs?: number; readPortFile?: (path: string, encoding: "utf8") => Promise<string> } = {},
) {
  const deadline = performance.now() + timeoutMs;
  let phase = "profile",
    timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  function checkActive() {
    assert.ok(!cancelled && performance.now() < deadline, "acquisition deadline");
    assert.ok(browser.isConnected(), "fixture browser closed during acquisition");
  }
  let last: unknown;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      cancelled = true;
      reject(new Error("acquisition deadline"));
    }, timeoutMs);
  });
  const acquiring = (async () => {
    const session = await browser.newBrowserCDPSession();
    let profile: string | undefined;
    try {
      checkActive();
      const { arguments: args } = await session.send("Browser.getBrowserCommandLine");
      checkActive();
      profile = args.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
      assert.ok(profile, "Chromium profile missing");
    } finally {
      await session.detach();
    }
    while (performance.now() < deadline) {
      checkActive();
      try {
        phase = "port file";
        const port: string = (await readPortFile(`${profile}/DevToolsActivePort`, "utf8")).split("\n")[0] || "";
        checkActive();
        assert.match(port, /^[1-9]\d*$/);
        assert.ok(Number(port) <= 65535, "port out of range");
        phase = "loopback connection";
        const endpoint = `http://127.0.0.1:${port}`;
        const connection = await chromium.connectOverCDP(endpoint, {
          timeout: Math.max(1, deadline - performance.now()),
        });
        try {
          checkActive();
        } finally {
          await connection.close();
        }
        checkActive();
        return endpoint;
      } catch (error) {
        last = error;
        checkActive();
      }
      await delay(Math.min(25, Math.max(0, deadline - performance.now())));
    }
    throw last || new Error("acquisition deadline");
  })();
  try {
    return await Promise.race([acquiring, expired]);
  } catch (error) {
    cancelled = true;
    const diagnostics = browserDiagnostics(browser);
    await browser.close();
    throw new Error(
      `CDP acquisition failed phase=${phase}; cause=${String(last || error)}; browser diagnostics:\n${diagnostics}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}
