import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { init, parse } from "es-module-lexer";
import type { Browser } from "playwright";
import { launchProofBrowser, proofFetch, readAppRelease } from "./app-release-reader.mjs";
import { CHROMIUM_SAFETY_ARGS } from "./chromium-safety-args.mjs";
import { requireContainingRelease } from "./containing-release.ts";
import { chromium } from "./proof-browser.mjs";

export async function prove({
  origin,
  timeoutMs,
  expectedCommit,
}: {
  origin: string;
  timeoutMs: number;
  expectedCommit: string;
}) {
  const base = new URL(origin);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30000
  )
    throw new Error("Expected origin and timeout 1..30000");
  const assets = new Map<string, Buffer>();
  const hashes: { path: string; sha256: string }[] = [];
  const assertions: { name: string; passed: boolean }[] = [];
  const controller = new AbortController();
  let release: Awaited<ReturnType<typeof readAppRelease>> | undefined;
  let browser: Browser | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unavailable = (message: string) => Object.assign(new Error(message), { exitCode: 78 });
  const work = async () => {
    const read = async (url: URL) => {
      let response: Response;
      try {
        response = await proofFetch(url, { signal: controller.signal, redirect: "error" });
      } catch {
        throw unavailable("Read unavailable");
      }
      if (!response.ok || !response.body) throw unavailable(`Read unavailable ${url.pathname}`);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) throw unavailable("Response byte cap exceeded");
        chunks.push(chunk);
      }
      return { body: Buffer.concat(chunks), type: response.headers.get("content-type") || "" };
    };
    release = await readAppRelease(base, read);
    if (!/^[a-f0-9]{40}$/.test(expectedCommit || "") || /^0+$/.test(expectedCommit))
      throw unavailable("Expected merge commit required");
    await requireContainingRelease(expectedCommit, release.source_commit, { signal: controller.signal });
    await init;
    const queue = ["/js/invoice-tracker-model.js", "/js/invoice-tracker-fixture.js"];
    for (const path of queue) {
      const response = await read(new URL(path, base));
      if (!/javascript/.test(response.type)) throw unavailable("Module content type unavailable");
      const bytes = response.body;
      assets.set(path, bytes);
      hashes.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
      for (const entry of parse(bytes.toString())[0]) {
        if (entry.d === -2) continue;
        if (!entry.n) throw unavailable("Uninspectable module import");
        const url = new URL(entry.n, new URL(path, base));
        if (url.origin !== base.origin || !url.pathname.startsWith("/js/") || url.search || url.hash)
          throw unavailable("Module import outside same-origin js");
        if (!queue.includes(url.pathname)) {
          if (queue.length >= 20) throw unavailable("Module cap exceeded");
          queue.push(url.pathname);
        }
      }
    }
    try {
      browser = await launchProofBrowser(
        chromium,
        { headless: true, args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs },
        { signal: controller.signal },
      );
    } catch {
      throw unavailable("Browser unavailable");
    }
    if (controller.signal.aborted) throw unavailable("Total proof timeout");
    const page = await browser.newPage({ serviceWorkers: "block" });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== base.origin || url.search || url.hash) return route.abort();
      if (url.pathname === "/__invoice_chronology_proof__")
        return route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Synthetic invoice proof</title>",
        });
      const bytes = assets.get(url.pathname);
      return bytes ? route.fulfill({ contentType: "text/javascript", body: bytes }) : route.abort();
    });
    await page.goto(new URL("/__invoice_chronology_proof__", base).href, { timeout: timeoutMs });
    const results = await page.evaluate(async () => {
      const { invoiceTrackerFixture } = await import("/js/invoice-tracker-fixture.js");
      const fixture = invoiceTrackerFixture("2026-10-02");
      const { projectInvoices, validInvoiceTracker } = await import("/js/invoice-tracker-model.js");
      const results: { name: string; passed: boolean }[] = [];
      const check = (name: string, passed: unknown) => {
        results.push({ name, passed: Boolean(passed) });
      };
      const today = "2026-10-02";
      check("invoice-tracker.v1 fixture admitted", validInvoiceTracker(fixture));
      const rows = projectInvoices(fixture, { today });
      check("ordinary paid interval remains 16", rows?.find((row) => row.status === "paid")?.age === 16);
      check(
        "unpaid aging and explicit due date preserved",
        rows?.some((row) => row.age === 104 && row.overdue && row.canMarkPaid),
      );
      check(
        "awaiting invoice remains unavailable age",
        rows?.some((row) => row.status === "awaiting" && row.age === null && !row.canMarkPaid),
      );
      const paid = fixture.entries.find((row) => row.status === "received");
      if (!paid) throw Error("Paid fixture missing");
      paid.received_on = paid.commission_invoiced_on;
      check(
        "genuine same-day remains zero",
        validInvoiceTracker(fixture) &&
          projectInvoices(fixture, { today })?.find((row) => row.key === paid.commission_id)?.age === 0,
      );
      paid.received_on = "2026-03-01";
      paid.commission_invoiced_on = "2026-03-05";
      const reversed = projectInvoices(fixture, { today });
      check("reversed chronology refused before display", !validInvoiceTracker(fixture) && reversed === null);
      return results;
    });
    assertions.push(...results);
    const after = await readAppRelease(base, read);
    if (JSON.stringify(release) !== JSON.stringify(after)) throw unavailable("Release changed during proof");
    if (assertions.some((result) => !result.passed)) throw new Error("Invoice chronology contradiction");
    return {
      service: release.service,
      environment: release.environment,
      source_commit: release.source_commit,
      release,
      assets: hashes,
      assertions,
      scope: "Deployed synthetic module behavior only. No natural signed-in journey.",
    };
  };
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = unavailable("Total proof timeout");
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } catch (caught) {
    const error = Object.assign(caught instanceof Error ? caught : Error(String(caught)), { receipt: {} });
    error.receipt = { release, assets: hashes, assertions, error: error.message };
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    await browser?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const options: Record<string, string> = {};
    const names: Record<string, string> = {
      "--origin": "origin",
      "--timeout-ms": "timeoutMs",
      "--expected-commit": "expectedCommit",
    };
    for (let i = 0; i < args.length; i += 2) {
      const name = names[args[i] || ""];
      const value = args[i + 1];
      if (!name || !value || Object.hasOwn(options, name))
        throw Error("Usage: --origin URL --timeout-ms MILLISECONDS --expected-commit SHA");
      options[name] = value;
    }
    console.log(
      JSON.stringify(
        await prove({
          origin: options.origin || "",
          expectedCommit: options.expectedCommit || "",
          timeoutMs: Number(options.timeoutMs),
        }),
      ),
    );
  } catch (error) {
    console.log(
      JSON.stringify(error instanceof Error && "receipt" in error ? error.receipt : { error: String(error) }),
    );
    process.exitCode =
      error instanceof Error && "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1;
  }
}
