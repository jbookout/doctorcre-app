import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { type Browser, chromium } from "playwright";

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
  let connection: Browser | undefined;
  let last: unknown;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("acquisition deadline")), timeoutMs);
  });
  const acquiring = (async () => {
    const session = await browser.newBrowserCDPSession();
    let profile: string | undefined;
    try {
      const { arguments: args } = await session.send("Browser.getBrowserCommandLine");
      profile = args.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
      assert.ok(profile, "Chromium profile missing");
    } finally {
      await session.detach();
    }
    while (performance.now() < deadline) {
      assert.ok(browser.isConnected(), "fixture browser closed during acquisition");
      try {
        phase = "port file";
        const port: string = (await readPortFile(`${profile}/DevToolsActivePort`, "utf8")).split("\n")[0] || "";
        assert.match(port, /^[1-9]\d*$/);
        assert.ok(Number(port) <= 65535, "port out of range");
        phase = "loopback connection";
        const endpoint = `http://127.0.0.1:${port}`;
        connection = await chromium.connectOverCDP(endpoint, { timeout: Math.max(1, deadline - performance.now()) });
        await connection.close();
        connection = undefined;
        return endpoint;
      } catch (error) {
        last = error;
      }
      await delay(Math.min(25, Math.max(0, deadline - performance.now())));
    }
    throw last || new Error("acquisition deadline");
  })();
  try {
    return await Promise.race([acquiring, expired]);
  } catch (error) {
    await acquiring.catch(() => {});
    const diagnostics = String(last || error);
    await connection?.close();
    await browser.close();
    throw new Error(
      `CDP acquisition failed phase=${phase}; browser diagnostics (including Playwright stderr when supplied): ${diagnostics}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}
