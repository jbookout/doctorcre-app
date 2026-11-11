import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Browser, LaunchOptions, Response } from "playwright";
import { chromium } from "playwright";
import { parsePublicTourPacket, UnsupportedPublicTourPacketError } from "../src/ui/public-tour-packet.ts";
import { launchProofBrowser, proofFetch, readAppRelease } from "./app-release-reader.mjs";
import { CHROMIUM_SAFETY_ARGS } from "./chromium-safety-args.mjs";
import { requireContainingRelease } from "./containing-release.ts";

type Row = { propertyRef: string; label: string; name: string; detail: string };
type Evidence = { active: string; revoked: string; viewOnly: string; rows: Row[]; pdfSha256: string };
type Options = {
  origin: string;
  commit: string;
  evidence?: Evidence;
  timeoutMs?: number;
  cwd?: string;
  engine?: { launch(options: LaunchOptions): Promise<Browser> };
};
const insufficient = (message: string) => Object.assign(Error(message), { exitCode: 78 });
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseEvidence(value: unknown, origin: string): Evidence {
  if (!object(value) || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > 100)
    throw insufficient("Exact client rows required");
  const links = [value.active, value.revoked, value.viewOnly].map((link) => {
    if (typeof link !== "string") throw insufficient("Three existing client links required");
    const url = new URL(link);
    if (
      (url.origin !== origin && url.origin !== "https://reports.doctorcre.com") ||
      url.pathname !== "/share" ||
      url.search ||
      !/^#(?:token=)?[A-Za-z0-9_-]{43}$/.test(url.hash) ||
      url.username ||
      url.password
    )
      throw insufficient("Same-origin fragment client links required");
    url.hash = url.hash.replace(/^#token=/, "#");
    return url.href;
  });
  const [active, revoked, viewOnly] = links;
  if (
    !active ||
    !revoked ||
    !viewOnly ||
    new Set(links.map((link) => new URL(link).origin)).size !== 1 ||
    new Set(links).size !== 3 ||
    typeof value.pdfSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.pdfSha256)
  )
    throw insufficient("Distinct grants and reviewed PDF digest required");
  const rows = value.rows.map((row) => {
    if (
      !object(row) ||
      typeof row.propertyRef !== "string" ||
      !/^property:public:[A-Za-z0-9_-]{16,128}$/.test(row.propertyRef) ||
      typeof row.label !== "string" ||
      typeof row.name !== "string" ||
      typeof row.detail !== "string"
    )
      throw insufficient("Exact displayed row fields required");
    return { propertyRef: row.propertyRef, label: row.label, name: row.name, detail: row.detail };
  });
  return { active, revoked, viewOnly, rows, pdfSha256: value.pdfSha256 };
}

export function packetSummary(packet: unknown, rowCount: number): string {
  const parsed = parsePublicTourPacket(packet);
  const count = parsed.length;
  assert.equal(count, rowCount, "packet stop count matches independent rows");
  const quantity = `${count} ${count === 1 ? "property" : "properties"}`;
  const summary = parsed.template.summary;
  assert.equal(
    summary.match(/^\d+ (?:property|properties)\b/)?.[0],
    quantity,
    "packet summary agrees with its stop count",
  );
  return summary;
}

export async function prove({ origin, commit, evidence, timeoutMs = 30000, cwd, engine = chromium }: Options) {
  const lifetime = new AbortController();
  const timer = setTimeout(() => lifetime.abort(insufficient("Total client proof deadline exceeded")), timeoutMs);
  let browser: Browser | undefined;
  let acquisition: Promise<Browser> | undefined;
  const get = async (url: URL) => {
    const response = await proofFetch(url, { signal: lifetime.signal, cache: "no-store" });
    return { type: response.headers.get("content-type") || "", body: Buffer.from(await response.arrayBuffer()) };
  };
  try {
    const release = await readAppRelease(origin, get);
    if (!/^[a-f0-9]{40}$/.test(commit || "") || /^0+$/.test(commit))
      throw insufficient("Expected merge commit required");
    await requireContainingRelease(commit, release.source_commit, { signal: lifetime.signal, ...(cwd ? { cwd } : {}) });
    if (!evidence) throw insufficient("Client link evidence required");
    const expected = parseEvidence(evidence, origin);
    const clientOrigin = new URL(expected.active).origin;
    browser = await launchProofBrowser(
      {
        launch(options: LaunchOptions) {
          acquisition = engine.launch({ ...options, args: [...CHROMIUM_SAFETY_ARGS, ...(options.args || [])] });
          return acquisition;
        },
      },
      { timeout: timeoutMs },
      { signal: lifetime.signal },
    );
    let requests = 0;
    for (const width of [1440, 390])
      for (const colorScheme of ["light", "dark"] as const) {
        for (const kind of ["active", "revoked", "viewOnly"] as const) {
          const context = await browser.newContext({
            viewport: { width, height: 900 },
            colorScheme,
            acceptDownloads: true,
            serviceWorkers: "block",
          });
          let packetResponse: Promise<{ response: Response } | { error: unknown }> | undefined;
          try {
            const page = await context.newPage();
            let violation = false;
            await page.route("**/*", async (route) => {
              const req = route.request(),
                url = new URL(req.url());
              if (url.origin !== clientOrigin) return route.abort();
              if (
                ++requests > 512 ||
                (!["GET", "HEAD"].includes(req.method()) &&
                  !(req.method() === "POST" && url.pathname === "/api/share/exchange"))
              ) {
                violation = true;
                return route.abort();
              }
              return route.fallback();
            });
            await page.goto(expected[kind]);
            packetResponse =
              kind === "revoked"
                ? undefined
                : page
                    .waitForResponse((response) => {
                      const url = new URL(response.url());
                      return url.origin === clientOrigin && url.pathname === "/api/share/report";
                    })
                    .then(
                      (response) => ({ response }),
                      (error: unknown) => ({ error }),
                    );
            await page.getByRole("button", { name: "Open tour", exact: true }).click();
            await page.waitForFunction(() => {
              const status = document.querySelector("#status")?.textContent;
              return (
                status === "This shared report is unavailable." ||
                status === "Report loaded." ||
                status === "Report and map loaded."
              );
            });
            assert.equal(await page.evaluate(() => location.hash), "", "bearer scrubbed");
            if (kind === "revoked") {
              assert.equal(await page.locator("#status").textContent(), "This shared report is unavailable.");
              assert.equal(await page.locator(".report-item").count(), 0);
            } else {
              const packet = await packetResponse;
              assert.ok(packet, "packet response required");
              if ("error" in packet) throw packet.error;
              const { response } = packet;
              assert.ok(response.ok(), "packet response available");
              const envelope: unknown = await response.json();
              assert.ok(object(envelope), "packet envelope required");
              assert.equal(
                await page.locator("#report-summary").textContent(),
                packetSummary(envelope.data, expected.rows.length),
              );
              const rows = await page.locator(".report-item").evaluateAll((nodes) =>
                nodes.map((node) => ({
                  propertyRef: node.getAttribute("data-property-ref"),
                  label: node.querySelector(".route-label")?.textContent,
                  name: node.querySelector("h3")?.textContent,
                  detail: node.querySelector(":scope > p:not(.route-label)")?.textContent,
                })),
              );
              assert.deepEqual(rows, expected.rows, "exact independently supplied displayed values");
            }
            assert.equal(
              await page.getByRole("button", { name: "Download PDF", exact: true }).count(),
              kind === "active" ? 1 : 0,
              "download control matches the producer capability",
            );
            const cookies = await context.cookies(clientOrigin);
            const response = await proofFetch(new URL("/api/share/download", clientOrigin), {
              signal: lifetime.signal,
              headers: { cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") },
              cache: "no-store",
            });
            const chunks: Uint8Array[] = [];
            let length = 0;
            if (response.body)
              for await (const chunk of response.body) {
                length += chunk.length;
                if (length > 20 * 1024 * 1024) throw insufficient("PDF exceeds evidence budget");
                chunks.push(chunk);
              }
            const download = {
              status: response.status,
              type: response.headers.get("content-type"),
              digest: createHash("sha256").update(Buffer.concat(chunks)).digest("hex"),
            };
            if (kind === "active") {
              assert.equal(download.status, 200);
              assert.equal(download.type, "application/pdf");
              assert.equal(download.digest, expected.pdfSha256);
              await page.getByRole("button", { name: "Download PDF", exact: true }).click();
              await page.getByText("PDF downloaded.", { exact: true }).waitFor();
            } else {
              assert.ok([401, 403, 404].includes(download.status), "server refuses download without permission");
            }
            assert.equal(violation, false, "bounded read-only client journey");
            assert.equal(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              true,
              "no horizontal overflow",
            );
          } finally {
            try {
              await context.close();
            } finally {
              await packetResponse;
            }
          }
        }
      }
    assert.deepEqual(await readAppRelease(origin, get), release, "release remained stable");
    return { status: "passed", release, layouts: 4, grants: 3, requests };
  } catch (error) {
    if (lifetime.signal.aborted) throw lifetime.signal.reason;
    if (
      error instanceof assert.AssertionError ||
      error instanceof UnsupportedPublicTourPacketError ||
      (object(error) && error.exitCode === 78)
    )
      throw error;
    throw insufficient("Client journey evidence unavailable");
  } finally {
    clearTimeout(timer);
    lifetime.abort();
    if (browser) await browser.close();
    else if (acquisition)
      await acquisition.then(
        (value) => value.close(),
        () => {},
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        origin: { type: "string" },
        commit: { type: "string" },
        "evidence-file": { type: "string" },
        "timeout-ms": { type: "string", default: "30000" },
      },
    });
    const url = new URL(values.origin || "https://app.doctorcre.com");
    const timeoutMs = Number(values["timeout-ms"]);
    if (
      url.href !== `${url.origin}/` ||
      url.username ||
      url.password ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120000
    )
      throw insufficient("Valid origin and bounded deadline required");
    const evidence = values["evidence-file"]
      ? parseEvidence(JSON.parse(await readFile(values["evidence-file"], "utf8")), url.origin)
      : undefined;
    console.log(
      JSON.stringify(
        await prove({ origin: url.origin, commit: values.commit || "", timeoutMs, ...(evidence ? { evidence } : {}) }),
      ),
    );
  } catch (error) {
    const exitCode =
      error instanceof assert.AssertionError || error instanceof UnsupportedPublicTourPacketError
        ? 1
        : object(error) && typeof error.exitCode === "number"
          ? error.exitCode
          : 78;
    console.log(
      JSON.stringify({
        status: exitCode === 78 ? "insufficient_evidence" : "failed",
        error:
          error instanceof UnsupportedPublicTourPacketError
            ? error.message
            : exitCode === 1
              ? "Client link assertion failed"
              : "Client proof evidence unavailable",
      }),
    );
    process.exitCode = exitCode;
  }
}
