import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, webkit } from "playwright";

export function verifyProducerPython(expected: string, observed: string) {
  assert.match(expected, /^\d+\.\d+$/);
  assert.equal(observed.match(/^Python (\d+\.\d+)\.\d+/)?.[1], expected, "image Python must match the pinned producer");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  assert.equal(process.version, "v26.12.1");
  assert.equal(lock.packages["node_modules/playwright"].version, "1.64.1");
  assert.equal(lock.packages["node_modules/@playwright/test"].version, "1.64.1");
  assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, "/ms-playwright");
  for (const engine of [chromium, webkit]) {
    assert.ok(engine.executablePath().startsWith("/ms-playwright/"));
  }
  if (process.argv[2]) {
    verifyProducerPython(
      readFileSync(resolve(process.argv[2], ".python-version"), "utf8").trim(),
      execFileSync("python3", ["--version"], { encoding: "utf8", timeout: 10_000 }).trim(),
    );
  }
  console.log("Locked runtimes match the prebuilt app image");
}
