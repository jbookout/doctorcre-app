import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Page } from "playwright";
import { visibleLeads } from "../js/leads-model.js";
import { parseReachability, reachabilityText } from "../src/ui/lead-reachability.ts";
import { proofFetch, readAppRelease } from "./app-release-reader.mjs";
import { requireContainingRelease } from "./containing-release.ts";
import { prove as runProof } from "./prove-activity-attribution-panel.mjs";

const unavailable = (message: string) => Object.assign(Error(message), { exitCode: 78 });
export function compareReachability(expected: unknown, displayed: string) {
  assert.equal(displayed, reachabilityText(expected), "Exact displayed classification and reasons");
}
async function observe(page: Page, origin: string) {
  await page.goto(`${origin}/leads`);
  await page.locator('#leadBoard[aria-busy="false"]').waitFor();
  const snapshot = await page.evaluate(async () => {
    const path = "/js/leads-client.js";
    const { createLeadBoardClient } = await import(path);
    return createLeadBoardClient().getWorkspace();
  });
  const leads: { id: string; reachability?: unknown }[] = snapshot.leads;
  leads.forEach((lead) => {
    parseReachability(lead.reachability);
  });
  if (!leads.some((lead) => parseReachability(lead.reachability)?.classification === "reachable"))
    throw unavailable("Natural reachable lead required");
  if (!leads.some((lead) => parseReachability(lead.reachability)?.classification === "research"))
    throw unavailable("Natural research lead required");
  await page.locator("#showTerritory").click();
  await page.locator("#territoryMap canvas").waitFor();
  await page.waitForFunction(
    () => !document.querySelector("#mapLeadMembers summary")?.textContent?.includes("not checked"),
  );
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      for (const view of ["reachable", "research"]) {
        await page.locator("#reachabilityFilter").selectOption(view);
        const expected = visibleLeads(leads, { reachability: view });
        const cohort = visibleLeads(leads);
        const reachable = cohort.filter(
          (lead) => parseReachability(lead.reachability)?.classification === "reachable",
        ).length;
        assert.equal(
          await page.locator("#reachabilitySummary").textContent(),
          `${reachable} Reachable · ${cohort.length - reachable} Research`,
        );
        assert.equal(
          await page.locator("#filterSummary").textContent(),
          `${expected.length} matching ${expected.length === 1 ? "lead" : "leads"}`,
        );
        const members = await page
          .locator("#mapLeadMembers [data-lead-id]")
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-lead-id")).sort());
        assert.deepEqual(members, expected.map((lead) => lead.id).sort());
        const markers = await page
          .locator(".market-marker")
          .evaluateAll((nodes) => nodes.flatMap((node) => JSON.parse(node.getAttribute("data-lead-ids") || "[]")));
        const unlocated = await page
          .locator("#mapLeadMembers [data-lead-id]")
          .evaluateAll((nodes) =>
            nodes
              .filter((node) => node.textContent?.includes("No location"))
              .map((node) => node.getAttribute("data-lead-id")),
          );
        assert.deepEqual([...markers, ...unlocated].sort(), members);
        const first = expected[0];
        if (!first) throw unavailable("Displayed positive cohort required");
        const card = page.locator(".lead-card").filter({ has: page.locator(`[data-open="${first.id}"]`) });
        compareReachability(first.reachability, (await card.locator(".lead-reachability").textContent()) || "");
        await card.locator(".lead-open").click();
        await page.locator("#leadDetail[open]").waitFor();
        await page.locator("#closeDetail").click();
        const market = await page.locator("#marketFilter option").nth(1).getAttribute("value");
        if (market) {
          await page.locator("#marketFilter").selectOption(market);
          const filtered = visibleLeads(leads, { reachability: view, market });
          assert.equal(
            await page.locator("#filterSummary").textContent(),
            `${filtered.length} matching ${filtered.length === 1 ? "lead" : "leads"}`,
          );
          await page.locator("#marketFilter").selectOption("");
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
    }
  return { scope: "read-only lead views, reasons and exact map membership", leads: leads.length };
}
export async function proveReachability(options: {
  origin: string;
  expectedCommit: string;
  producerOrigin: string;
  producerCommit: string;
  producerRepository: string;
  cdpUrl?: string | undefined;
  timeoutMs?: number;
  fixtureCase?: string | undefined;
}) {
  const deadline = Date.now() + (options.timeoutMs || 30000);
  const signal = () => AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  if (options.fixtureCase) {
    const recording = JSON.parse(
      await readFile(new URL("../test/fixtures/lead-reachability/producer.json", import.meta.url), "utf8"),
    );
    const value = recording.cases.reachable.reachability;
    const settings = {
      origin: options.origin,
      expectedCommit: options.expectedCommit,
      timeoutMs: options.timeoutMs,
      readRelease: async () => ({ source_commit: options.expectedCommit }),
      contains: async () => {},
      engine: { launch: async () => ({ newPage: async () => ({}), close: async () => {} }) },
      observe: async () => {
        compareReachability(
          value,
          options.fixtureCase === "pass" ? reachabilityText(value) : `${reachabilityText(value)} changed`,
        );
        return { scope: "synthetic fixture only" };
      },
    };
    return runProof(settings);
  }
  const settings = {
    ...options,
    observe,
    readRelease: async () => {
      if (!/^[a-f0-9]{40}$/.test(options.producerCommit)) throw unavailable("Producer merge commit required");
      const response = await proofFetch(new URL("/release", options.producerOrigin), {
        signal: signal(),
        cache: "no-store",
      });
      if (!response.ok) throw unavailable("Producer release unavailable");
      const release = await response.json();
      if (!/^[a-f0-9]{40}$/.test(release.git_sha || "")) throw unavailable("Producer identity unavailable");
      await requireContainingRelease(options.producerCommit, release.git_sha, {
        cwd: options.producerRepository,
        signal: signal(),
      });
      return readAppRelease(options.origin, async (url) => {
        const result = await proofFetch(url, { signal: signal(), cache: "no-store" });
        return { type: result.headers.get("content-type") || "", body: Buffer.from(await result.arrayBuffer()) };
      });
    },
  };
  return runProof(settings);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      origin: { type: "string", default: "https://app.doctorcre.com" },
      "expected-commit": { type: "string" },
      "producer-origin": { type: "string" },
      "producer-commit": { type: "string" },
      "producer-repository": { type: "string" },
      "cdp-url": { type: "string" },
      "timeout-ms": { type: "string" },
      "fixture-case": { type: "string" },
    },
  });
  const result = await proveReachability({
    origin: values.origin,
    expectedCommit: values["expected-commit"] || "",
    producerOrigin: values["producer-origin"] || "",
    producerCommit: values["producer-commit"] || "",
    producerRepository: values["producer-repository"] || "",
    cdpUrl: values["cdp-url"],
    timeoutMs: Number(values["timeout-ms"] || 30000),
    fixtureCase: values["fixture-case"],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
