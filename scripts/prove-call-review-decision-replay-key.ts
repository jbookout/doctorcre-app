import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { init, parse } from "es-module-lexer";
import type { Browser } from "playwright";
import { chromium } from "playwright";
import { launchProofBrowser, proofFetch, readAppRelease } from "./app-release-reader.mjs";
import { CHROMIUM_SAFETY_ARGS } from "./chromium-safety-args.mjs";
import { requireContainingRelease } from "./containing-release.ts";

// Recorded through executeRegisteredTool with synthetic database rows at CARR
// 8718a35562f8e4de62cf7322881383895f69dd64, tools.js prepareCaptureCandidate.
// Both registered resolvers share these skip and already-confirmed receipts.
export function resolverFixture(candidateId: string, accept: boolean) {
  return accept
    ? {
        ok: true,
        candidate_id: candidateId,
        already: "confirmed",
        ref: candidateId,
        note: "already dispositioned; nothing changed",
      }
    : { ok: true, candidate_id: candidateId, status: "skipped", ref: null };
}

export function checkResolverFixture(value: unknown, candidateId: string, accept: boolean) {
  const expected = resolverFixture(candidateId, accept);
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw new Error("Incompatible resolver fixture");
  return expected;
}

export async function exercise({
  fixtures,
}: {
  fixtures: {
    candidateId: string;
    confirmed: ReturnType<typeof resolverFixture>;
    skipped: ReturnType<typeof resolverFixture>;
  };
}) {
  const { mountCallReview } = await import("/js/" + "ui-call.generated.js");
  const { createLiveClient } = await import("/js/" + "live-client.js");
  function check(value: unknown, message: string): asserts value {
    if (!value) throw new Error(message);
  }
  check(typeof mountCallReview === "function", "Missing mountCallReview export");
  const assertions = [];
  for (const resolver of ["resolve-post-call-candidate", "resolve-candidate"]) {
    const node = document.createElement("main");
    document.body.replaceChildren(node);
    const writes: Record<string, unknown>[] = [];
    const rows = [
      {
        session_id: "synthetic-call",
        call_date: "2026-10-01",
        applied: [],
        open_cards: [
          {
            candidate_id: fixtures.candidateId,
            kind: resolver === "resolve-candidate" ? "next_step" : "assigned_action",
            resolver,
            payload: { action: "Synthetic task" },
          },
        ],
      },
    ];
    const accept = resolver === "resolve-post-call-candidate";
    const mcp = (value: unknown) =>
      Response.json({ result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
    const client = createLiveClient({
      fetchImpl: async (path: string, init: { body: string }) => {
        if (path === "/auth/session") return Response.json({ actor: { slug: "joe" }, csrf_token: "synthetic" });
        const { name, arguments: args } = JSON.parse(init.body).params;
        if (name === "read-call-outcomes")
          return mcp({ schema_version: "call-outcomes.v1", calls: structuredClone(rows), send: false });
        check(name === resolver, "Expected registered resolver");
        writes.push(structuredClone(args));
        if (writes.length === 1) return new Response("Unconfirmed", { status: 409 });
        check(writes.length === 2, "Synthetic write cap exceeded");
        const row = rows[0];
        check(row, "Missing call");
        row.open_cards = [];
        return mcp(accept ? fixtures.confirmed : fixtures.skipped);
      },
    });
    const view = mountCallReview(node, {
      sessionId: "synthetic-call",
      describe: () => "Task",
      undoRefusal: () => "",
      client: () => client,
    });
    const button = (name: string) => [...node.querySelectorAll("button")].find((row) => row.textContent === name);
    const click = async (name: string) => {
      const target = button(name);
      check(target && !target.disabled, `Enabled ${name}`);
      target.click();
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (let attempt = 0; attempt < 100 && button("Refresh call review")?.disabled; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
    };
    try {
      await view.refresh();
      await click("Approve or fix this item");
      await click(accept ? "Approve item" : "Skip item");
      check(Number(writes.length) === 1, "No automatic write retry");
      assertions.push(resolver + ":no-automatic-write-retry");
      check(button("Approve item")?.disabled && button("Skip item")?.disabled, "HTTP uncertainty blocks new decisions");
      assertions.push(resolver + ":http-uncertainty-blocks-new-decisions");
      await click("Check outcome");
      check(
        writes.length === 2 && JSON.stringify(writes[0]) === JSON.stringify(writes[1]),
        "Exact original decision replay",
      );
      assertions.push(resolver + ":exact-original-decision-replay");
      const resolution = node.querySelector("[data-review-candidate] h3 + .call-review-meta")?.textContent;
      check(resolution === "No longer pending", `Authoritative readback resolves item: ${JSON.stringify(resolution)}`);
      assertions.push(resolver + ":authoritative-resolution");
    } finally {
      view.dispose();
    }
  }
  return assertions;
}

export async function prove({
  origin,
  commit,
  timeoutMs = 30000,
}: {
  origin: string;
  commit: string | undefined;
  timeoutMs?: number;
}) {
  if (!commit || !/^[a-f0-9]{40}$/.test(commit) || /^0+$/.test(commit))
    throw new Error("--commit requires the expected merge commit");
  const target = new URL(origin);
  if (!["http:", "https:"].includes(target.protocol) || target.origin !== origin || target.username || target.password)
    throw new Error("Supply an HTTP origin without path or credentials");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new Error("timeout-ms must be 1 to 30000");
  const controller = new AbortController();
  const owner: { browser?: Browser } = {};
  let requests = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unavailable = (message: string) => Object.assign(new Error(message), { exitCode: 78 });
  const fetchBytes = async (path: string) => {
    if (++requests > 64) throw new Error("64 HTTP request cap exceeded");
    try {
      const response = await proofFetch(new URL(path, origin), { signal: controller.signal, redirect: "error" });
      if (!response.ok) throw unavailable("Release or asset unavailable");
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > 8_000_000) throw new Error("Asset exceeds byte cap");
      return data;
    } catch (error) {
      if (error instanceof Error && ("exitCode" in error || error.message === "Asset exceeds byte cap")) throw error;
      throw unavailable("Release or asset unavailable");
    }
  };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(unavailable("Proof timed out"));
      reject(unavailable("Proof timed out"));
      void owner.browser?.close();
    }, timeoutMs);
  });
  const run = async () => {
    const release = await readAppRelease(origin, async () => ({
      type: "application/json",
      body: await fetchBytes("/app-release"),
    }));
    await requireContainingRelease(commit, release.source_commit, { signal: controller.signal });
    if (release.service !== "doctorcre-app" || !/^[a-f0-9]{40}$/.test(release.source_commit))
      throw unavailable("Release identity unavailable");
    const manifest: {
      schema: string;
      source_commit: string;
      files: { path: string; bytes: number; sha256: string }[];
    } = JSON.parse((await fetchBytes("/artifact-manifest.json")).toString());
    if (
      manifest.schema !== "doctorcre-static-artifact.v1" ||
      manifest.source_commit !== release.source_commit ||
      !Array.isArray(manifest.files)
    )
      throw new Error("Manifest identity mismatch");
    const assets = new Map<string, Buffer>(),
      hashes: Record<string, string> = {};
    await init;
    async function load(path: string) {
      if (assets.has(path)) return;
      if (!/^\/js\/[a-zA-Z0-9_.-]+\.(?:js|mjs)$/.test(path)) throw new Error("Asset outside admitted graph: " + path);
      const entries = manifest.files.filter((row) => row.path === path.slice(1));
      if (entries.length !== 1) throw new Error("Asset missing or duplicated in manifest");
      const bytes = await fetchBytes(path),
        sha = createHash("sha256").update(bytes).digest("hex");
      const entry = entries[0];
      if (!entry || sha !== entry.sha256 || bytes.length !== entry.bytes) throw new Error("Asset hash mismatch");
      assets.set(path, bytes);
      hashes[path] = sha;
      for (const entry of parse(bytes.toString())[0]) {
        if (entry.d !== -1) continue;
        if (!entry.n) throw new Error("Unbounded module import");
        const url = new URL(entry.n, origin + path);
        if (url.origin !== origin || url.search || url.hash) throw new Error("Cross-origin asset");
        await load(url.pathname);
      }
    }
    await load("/js/ui-call.generated.js");
    await load("/js/live-client.js");
    const browser = await launchProofBrowser(
      chromium,
      { args: [...CHROMIUM_SAFETY_ARGS], timeout: timeoutMs },
      { signal: controller.signal },
    );
    owner.browser = browser;
    if (controller.signal.aborted) {
      await browser.close();
      throw unavailable("Proof timed out");
    }
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || route.request().method() !== "GET") return route.abort();
      if (url.pathname === "/__call-review-proof__")
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" });
      const bytes = assets.get(url.pathname);
      return bytes ? route.fulfill({ contentType: "text/javascript", body: bytes }) : route.abort();
    });
    const page = await context.newPage();
    await page.goto(origin + "/__call-review-proof__");
    const candidateId = "10000000-0000-4000-8000-000000000001";
    const fixtures = {
      candidateId,
      confirmed: checkResolverFixture(resolverFixture(candidateId, true), candidateId, true),
      skipped: checkResolverFixture(resolverFixture(candidateId, false), candidateId, false),
    };
    const assertions = await page.evaluate(exercise, {
      fixtures,
    });
    return { release, assets: hashes, assertions, requests, max_requests: 64, synthetic: true };
  };
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await owner.browser?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        origin: { type: "string" },
        commit: { type: "string" },
        "timeout-ms": { type: "string", default: "30000" },
      },
    });
    if (!values.origin) throw new Error("--origin required");
    process.stdout.write(
      JSON.stringify(
        await prove({ origin: values.origin, commit: values.commit, timeoutMs: Number(values["timeout-ms"]) }),
      ) + "\n",
    );
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exitCode =
      error instanceof Error && "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : 1;
  }
}
