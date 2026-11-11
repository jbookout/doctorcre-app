import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { init, parse } from "es-module-lexer";
import { type Browser, chromium, type Page } from "playwright";
import { launchProofBrowser, proofFetch, readAppRelease } from "./app-release-reader.mjs";
import { CHROMIUM_SAFETY_ARGS } from "./chromium-safety-args.mjs";
import { requireContainingRelease } from "./containing-release.ts";

export async function assertQuietVendorBehavior(page: Page) {
  return page.evaluate(async () => {
    const { mountQuietVendors } = await import("/js/ui-quiet-vendors.generated.js");
    const assertions: string[] = [];
    function check(ok: unknown, name: string) {
      if (!ok) throw new Error(name);
      assertions.push(name);
    }
    const host = document.body.appendChild(document.createElement("div"));
    const row = {
      subject_type: "vendor",
      subject_id: "synthetic-vendor",
      ref: "V-SYNTHETIC",
      name: "Synthetic vendor",
      basis: "created_at",
      anchor_on: "2026-01-01",
      due_on: "2026-02-01",
      days_overdue: 1,
    };
    const good = () => ({
      cadence: { vendor_days: 14 },
      proposals: Array.from({ length: 7 }, (_, i) => ({
        ...row,
        owner: i < 6 ? "joe" : "dell",
        basis: i % 2 ? "last_contact" : "created_at",
        ref: `V-${i}`,
      })).concat({ ...row, owner: "joe", subject_type: "lead", name: "Hidden lead" }),
    });
    let reads = 0;
    let reject: (reason: Error) => void = () => {
      throw Error("No pending load");
    };
    let resolve: (value: unknown) => void = () => {
      throw Error("No pending load");
    };
    const opened: string[][] = [];
    const mounted = mountQuietVendors(host, {
      load: () => {
        reads++;
        return new Promise((done, fail) => {
          resolve = done;
          reject = fail;
        });
      },
      href: (id) => `/vendors?record=${id}`,
      open: (...args) => {
        opened.push(args);
      },
    });
    const button = (name: string) => [...host.querySelectorAll("button")].find((el) => el.textContent === name);
    const wait = async (predicate: () => boolean) => {
      const end = performance.now() + 3000;
      while (!predicate()) {
        if (performance.now() >= end) throw new Error("UI transition timed out");
        await new Promise((done) => setTimeout(done, 10));
      }
    };
    const click = async (name: string) => {
      const el = button(name);
      if (!el) throw new Error(`Missing ${name}`);
      el.click();
      await new Promise((done) => setTimeout(done, 0));
    };
    const finish = async (value: unknown) => {
      resolve(value);
      await wait(() => !button("Loading quiet vendors…"));
    };
    try {
      check(reads === 0, "opt-in loading");
      const invalid = [
        ...[{}, [], 1, true].map((owner) => ({ cadence: { vendor_days: 14 }, proposals: [{ ...row, owner }] })),
        ...["subject_type", "subject_id", "ref", "name", "basis", "anchor_on", "due_on", "days_overdue"].map((key) => {
          const broken: Record<string, unknown> = { ...row };
          delete broken[key];
          return { cadence: { vendor_days: 14 }, proposals: [broken] };
        }),
        ...[-1, 1.5, Infinity].map((vendor_days) => ({ cadence: { vendor_days }, proposals: [] })),
        null,
        {},
        { cadence: { vendor_days: 14 }, proposals: [null] },
        { cadence: null, proposals: [] },
        { cadence: { vendor_days: "14" }, proposals: [] },
        { cadence: { vendor_days: 0 }, proposals: [] },
        { cadence: { vendor_days: 14 }, proposals: [{ ...row, subject_id: "" }] },
        { cadence: { vendor_days: 14 }, proposals: [row, null] },
      ];
      for (const [index, value] of invalid.entries()) {
        await click(index === 0 ? "Show quiet vendors" : "Refresh quiet vendors");
        const before = reads;
        await click("Loading quiet vendors…");
        check(reads === before, `single pending read ${index}`);
        await finish(value);
        check(
          !!host.querySelector("[role=alert]") && !host.textContent.includes("No quiet vendors"),
          `malformed refusal ${index}`,
        );
        await click("Hide quiet vendors");
        check(document.activeElement === button("Show quiet vendors"), `refusal Hide focus ${index}`);
        await click("Show quiet vendors");
        check(!!host.querySelector("[role=alert]") && reads === before, `retained refusal ${index}`);
      }
      await click("Refresh quiet vendors");
      await finish({
        cadence: { vendor_days: 14 },
        proposals: Array.from({ length: 1000 }, (_, i) => ({ ...row, subject_id: `vendor-${i}`, ref: `V-${i}` })),
      });
      check(
        host.querySelectorAll("li").length === 5 && host.textContent?.includes("of 1000 quiet vendors"),
        "valid snapshot bounded at 1000 proposals",
      );
      await click("Refresh quiet vendors");
      await finish({ cadence: { vendor_days: 14 }, proposals: Array.from({ length: 1001 }, () => row) });
      check(!!host.querySelector("[role=alert]") && !host.querySelector("li"), "oversize snapshot refuses");
      await click("Refresh quiet vendors");
      reject(Error("Synthetic read refusal"));
      await wait(() => !!host.querySelector("[role=alert]"));
      check(!host.querySelector("li"), "rejected read clears stale rows");
      await click("Refresh quiet vendors");
      await finish(good());
      check(
        host.querySelectorAll("li").length === 5 && !host.textContent.includes("Hidden lead"),
        "recovery with five vendor rows",
      );
      await click("Next vendors");
      check(host.querySelectorAll("li").length === 2, "next page");
      await click("Next vendors");
      check(host.querySelectorAll("li").length === 2, "last page bounded");
      await click("Previous vendors");
      await click("Previous vendors");
      check(host.querySelectorAll("li").length === 5, "first page bounded");
      const link = host.querySelector("a");
      if (!link) throw Error("Missing vendor link");
      link.click();
      check(
        opened[0]?.[0]?.endsWith("/vendors?record=synthetic-vendor") && opened[0]?.[1] === "quiet-vendor-0",
        "navigation and focus-return port",
      );
      await click("Hide quiet vendors");
      check(document.activeElement === button("Show quiet vendors"), "ready Hide focus");
      const beforeReopen = reads;
      await click("Show quiet vendors");
      check(reads === beforeReopen && host.querySelectorAll("li").length === 5, "reopen without read");
      const select = async (index: number, value: string) => {
        const control = host.querySelectorAll("select")[index];
        if (!control) throw Error("Missing filter");
        control.value = value;
        control.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((done) => setTimeout(done, 0));
      };
      await select(0, "owner:joe");
      await select(1, "last_contact");
      check(host.querySelectorAll("li").length === 3, "owner and history intersection");
      await click("Refresh quiet vendors");
      await finish({ ...good(), proposals: [...good().proposals, null] });
      check(
        !!host.querySelector("[role=alert]") && host.querySelectorAll("li").length === 0,
        "filtered malformed refresh refuses without stale rows",
      );
      await click("Hide quiet vendors");
      await click("Show quiet vendors");
      await click("Refresh quiet vendors");
      await finish(good());
      check(
        host.querySelectorAll("select")[0]?.value === "owner:joe" &&
          host.querySelectorAll("select")[1]?.value === "last_contact" &&
          host.querySelectorAll("li").length === 3,
        "recovery retains owner and history",
      );
      await click("Refresh quiet vendors");
      await finish({ cadence: { vendor_days: 14 }, proposals: [] });
      check(
        host.textContent.includes("No quiet vendors in this server snapshot.") && !host.querySelector("[role=alert]"),
        "valid empty snapshot",
      );
      await click("Refresh quiet vendors");
      await click("Hide quiet vendors");
      await click("Show quiet vendors");
      const beforeDispose = reads;
      await click("Loading quiet vendors…");
      check(reads === beforeDispose, "pending Hide and reopen keep single read");
      mounted.dispose();
      resolve(good());
      await new Promise((done) => setTimeout(done, 30));
      check(host.innerHTML === "", "disposed ignores late read");
      for (const payload of [good(), { cadence: { vendor_days: 14 }, proposals: [null] }]) {
        const view = mountQuietVendors(host, { load: async () => payload, href: () => "/vendors", open() {} });
        const show = button("Show quiet vendors");
        if (!show) throw Error("Missing Show");
        for (let i = 0; i < 5; i++) show.click();
        await wait(() => !!host.querySelector("li, [role=alert]"));
        view.dispose();
        check(host.innerHTML === "", "ready or refused disposal removes panel");
      }
      return assertions;
    } finally {
      mounted.dispose();
      host.remove();
    }
  });
}

async function prove({
  origin,
  expectedCommit,
  timeoutMs,
}: {
  origin: string;
  expectedCommit: string | undefined;
  timeoutMs: number;
}) {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let browser: Browser | undefined;
  let release: Awaited<ReturnType<typeof readAppRelease>> | undefined;
  const assets = new Map<string, Buffer>();
  const hashes: { path: string; sha256: string }[] = [];
  let requests = 0;
  const unavailable = (message: string) => Object.assign(new Error(message), { exitCode: 78 });
  async function read(path: string) {
    if (++requests > 20) throw new Error("Asset request budget exceeded");
    let response: Response;
    try {
      response = await proofFetch(new URL(path, origin), { signal: controller.signal, redirect: "manual" });
    } catch {
      if (controller.signal.aborted) throw new Error("Total proof deadline exceeded");
      throw unavailable(`Asset unavailable ${path}`);
    }
    if (response.status !== 200) throw unavailable(`Asset unavailable ${path} (${response.status})`);
    const chunks = [];
    let size = 0;
    if (!response.body) throw unavailable("Missing asset body");
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        controller.abort();
        throw new Error("Asset exceeds byte budget");
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    hashes.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
    return bytes;
  }
  try {
    release = await readAppRelease(origin, async () => ({
      type: "application/json",
      body: await read("/app-release"),
    }));
    if (!expectedCommit || !/^[a-f0-9]{40}$/.test(expectedCommit) || /^0+$/.test(expectedCommit))
      throw unavailable("Expected merge commit required");
    if (release.source_commit !== expectedCommit)
      await requireContainingRelease(expectedCommit, release.source_commit, { signal: controller.signal });
    await init;
    const pending = ["/js/ui-quiet-vendors.generated.js"];
    while (pending.length) {
      const path = pending.shift();
      if (!path) break;
      if (assets.has(path)) continue;
      const bytes = await read(path);
      assets.set(path, bytes);
      const [imports] = parse(bytes.toString());
      for (const item of imports) {
        if (!item.n) throw new Error("Unresolved module import");
        const url = new URL(item.n, new URL(path, origin));
        if (
          url.origin !== origin ||
          !/^\/js\/ui-shared-[A-Z0-9]+\.generated\.js$/.test(url.pathname) ||
          url.search ||
          url.hash
        )
          throw new Error("Module outside finite asset allowlist");
        if (!assets.has(url.pathname) && !pending.includes(url.pathname)) pending.push(url.pathname);
      }
      if (assets.size + pending.length > 19) throw new Error("Asset request budget exceeded");
    }
    browser = await launchProofBrowser(
      chromium,
      { args: [...CHROMIUM_SAFETY_ARGS], timeout: remaining() },
      { signal: controller.signal },
    );
    const page = await browser.newPage();
    page.setDefaultTimeout(remaining());
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "https://proof.invalid") return route.abort();
      if (url.pathname === "/")
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" });
      const bytes = assets.get(url.pathname);
      return bytes ? route.fulfill({ contentType: "text/javascript", body: bytes }) : route.abort();
    });
    await page.goto("https://proof.invalid/");
    const assertions = await Promise.race([
      assertQuietVendorBehavior(page),
      new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("Total proof deadline exceeded")), {
          once: true,
        });
        if (controller.signal.aborted) reject(new Error("Total proof deadline exceeded"));
      }),
    ]);
    if (errors.length) throw new Error(errors.join("; "));
    return { exitCode: 0, release, assets: hashes, assertions };
  } catch (error) {
    return {
      exitCode:
        error instanceof Error && "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1,
      release,
      assets: hashes,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    await browser?.close();
  }
}

async function main(args: string[]) {
  try {
    if (
      ![4, 6].includes(args.length) ||
      args[0] !== "--origin" ||
      (args.length === 6 && args[2] !== "--commit") ||
      args[args.length - 2] !== "--timeout-ms"
    )
      throw new Error("Expected --origin URL --commit SHA --timeout-ms INTEGER");
    const url = new URL(args[1] || "");
    const timeoutMs = Number(args[args.length - 1]);
    const expectedCommit = args.length === 6 ? args[3] : undefined;
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30000
    )
      throw new Error("Invalid origin or timeout");
    const result = await prove({ origin: url.origin, expectedCommit, timeoutMs });
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
