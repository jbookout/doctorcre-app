import type { Browser } from "playwright";
import { chromium } from "playwright";
import { launchProofBrowser, proofFetch, readAppRelease } from "./app-release-reader.mjs";
import { CHROMIUM_SAFETY_ARGS } from "./chromium-safety-args.mjs";
import { requireContainingRelease } from "./containing-release.ts";

const usage = "Usage: node scripts/prove-reply-draft-recipient-race.ts --origin URL --timeout-ms 30000 --commit SHA";
function options(args: string[]) {
  if (args.length === 1 && args[0] === "--help") return null;
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (!key || !value || !["--origin", "--timeout-ms", "--commit"].includes(key) || values.has(key))
      throw Error(usage);
    values.set(key, value);
  }
  if (values.size !== 3) throw Error(usage);
  const url = new URL(values.get("--origin") || "");
  const timeout = Number(values.get("--timeout-ms"));
  const commit = values.get("--commit") || "";
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^[a-f0-9]{40}$/.test(commit) ||
    /^0+$/.test(commit) ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 30000
  )
    throw Error(usage);
  return { origin: url.origin, timeout, commit };
}

async function prove({ origin, timeout, commit }: { origin: string; timeout: number; commit: string }) {
  let browser: Browser | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    expired = false;
  const controller = new AbortController();
  const work = async () => {
    const release = await readAppRelease(origin, { timeoutMs: timeout });
    await requireContainingRelease(commit, release.source_commit, { signal: controller.signal });
    browser = await launchProofBrowser(
      chromium,
      { args: [...CHROMIUM_SAFETY_ARGS], timeout },
      { signal: controller.signal },
    );
    if (expired) {
      await browser.close();
      throw Error("Proof timeout");
    }
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    const modules = new Set<string>();
    let requests = 0,
      violation: string | undefined;
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (
        request.method() !== "GET" ||
        url.origin !== origin ||
        ++requests > 64 ||
        !(
          url.pathname === "/__reply-draft-proof" ||
          url.pathname === "/app-release" ||
          /^\/js\/[\w./-]+\.js$/.test(url.pathname)
        )
      ) {
        violation = "Proof refused an outbound request";
        return route.abort();
      }
      if (url.pathname === "/__reply-draft-proof")
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Reply draft proof</title>" });
      try {
        const response = await proofFetch(url, { signal: controller.signal });
        if (!response.ok) throw Error(`Protected or unavailable asset ${url.pathname} (${response.status})`);
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > 1048576) throw Error("Proof asset exceeds 1 MiB");
        if (url.pathname.endsWith(".js")) modules.add(url.href);
        await route.fulfill({ status: response.status, contentType: response.headers.get("content-type") || "", body });
      } catch (error) {
        violation = error instanceof Error ? error.message : String(error);
        await route.abort();
      }
    });
    await page.goto(`${origin}/__reply-draft-proof`);
    const result = await page.evaluate(async () => {
      const check = (condition: boolean, message: string) => {
        if (!condition) throw Error(message);
      };
      const { createReplyDeviceDrafts } = await import("/js/" + "ui-email-actions.generated.js");
      check(typeof createReplyDeviceDrafts === "function", "Missing createReplyDeviceDrafts export");
      const data = new Map<string, string>();
      const storage = {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => data.set(key, value),
        removeItem: (key: string) => data.delete(key),
      };
      const row = {
        id: "synthetic-proposal",
        version: 3,
        reply_draft: { subject: "Synthetic", body: "Synthetic reply", to: ["a@example.test"], cc: ["b@example.test"] },
      };
      const snapshot = { baseVersion: 3, ...row.reply_draft };
      const drafts = createReplyDeviceDrafts(storage, "synthetic-actor");
      const assertions = [];
      for (const field of ["to", "cc"] as const) {
        const newer = { ...snapshot, [field]: ["new@example.test"] };
        check(drafts.save(row.id, snapshot) && drafts.save(row.id, newer), "Synthetic persistence failed");
        drafts.remove(row.id, snapshot);
        check(
          JSON.stringify(drafts.restore(row)?.[field]) === JSON.stringify(newer[field]),
          `${field}-only edit lost after late receipt`,
        );
        assertions.push(`${field}-only edit retained`);
        check(createReplyDeviceDrafts(storage, "other-actor").restore(row) === null, "Actor isolation failed");
        check(drafts.restore({ ...row, id: "other-proposal" }) === null, "Proposal isolation failed");
        drafts.remove(row.id, newer);
        check(drafts.restore(row) === null, "Matching snapshot was not removed");
      }
      assertions.push("matching snapshot removed", "actor and proposal isolated");
      return { assertions };
    });
    const after = await readAppRelease(origin, { timeoutMs: Math.max(1, timeout) });
    if (after.source_commit !== release.source_commit) throw Error("Release changed during proof");
    if (violation) throw Error(violation);
    return {
      origin,
      release,
      fixture: ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname),
      ...result,
      loaded_module_urls: [...modules].sort(),
      requests,
      evidence: "synthetic deployed-module behavior; no natural records read",
    };
  };
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          const error = Object.assign(Error("Proof timeout"), { exitCode: 78 });
          controller.abort(error);
          reject(error);
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await browser?.close();
  }
}

try {
  const config = options(process.argv.slice(2));
  if (!config) console.log(usage);
  else {
    const receipt = JSON.stringify(await prove(config));
    if (Buffer.byteLength(receipt) > 65536) throw Error("Receipt exceeds 64 KiB");
    console.log(receipt);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode =
    error instanceof Error && "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1;
}
