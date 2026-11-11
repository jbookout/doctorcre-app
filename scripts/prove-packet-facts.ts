import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { packetFacts } from "../src/ui/packet-facts.ts";
import { comparePacketStops, observePdf } from "./packet-pdf-observation.ts";
import { prove as runProof } from "./prove-activity-attribution-panel.mjs";

export async function provePacket(options: {
  origin: string;
  expectedCommit: string;
  cdpUrl?: string | undefined;
  fixtureCase?: string | undefined;
  timeoutMs?: number;
}) {
  if (options.fixtureCase) {
    assert.ok(["pass", "near-miss"].includes(options.fixtureCase));
    const pdf = await observePdf(await readFile(new URL("../test/fixtures/packet-parity/packet.pdf", import.meta.url)));
    const fixture: unknown = JSON.parse(
      await readFile(new URL("../test/fixtures/packet-parity/packet.json", import.meta.url), "utf8"),
    );
    assert.ok(fixture && typeof fixture === "object" && "properties" in fixture && Array.isArray(fixture.properties));
    const share = fixture.properties.map((p: unknown) => {
      assert.ok(
        p &&
          typeof p === "object" &&
          "property_ref" in p &&
          "route_label" in p &&
          "name" in p &&
          "address" in p &&
          "suite" in p,
      );
      const { property_ref, route_label, name, address, suite } = p;
      assert.ok(
        typeof property_ref === "string" &&
          typeof route_label === "string" &&
          typeof name === "string" &&
          typeof address === "string" &&
          typeof suite === "string",
      );
      return {
        property: property_ref,
        label: route_label,
        name,
        address: `${address} - ${suite}`,
        facts: packetFacts(p).map(([, value]) => value),
      };
    });
    if (options.fixtureCase === "near-miss" && share[0]) share[0].facts[1] = "11600 SF";
    return runProof({
      ...options,
      readRelease: async () => ({ source_commit: options.expectedCommit }),
      contains: async () => {},
      engine: { launch: async () => ({ newPage: async () => ({}), close: async () => {} }) },
      observe: async () => {
        comparePacketStops(pdf, pdf, share);
        return { scope: "synthetic PDF extraction and exact fact comparison only" };
      },
    });
  }
  return runProof({
    ...options,
    observe: async (page, origin) => {
      if (!options.cdpUrl) throw Object.assign(Error("Signed-in browser required"), { exitCode: 78 });
      await page.goto(`${origin}/tours/route-editor.html`);
      const tour = page.locator(".tour-button").first();
      try {
        await tour.waitFor();
      } catch {
        throw Object.assign(Error("Populated tour session required"), { exitCode: 78 });
      }
      await tour.click();
      await page.locator("#tour-panel").waitFor({ state: "visible" });
      const preview = page.locator("#preview-pdf");
      if (!(await preview.isVisible())) throw Object.assign(Error("Approved preview unavailable"), { exitCode: 78 });
      const href = await preview.getAttribute("href");
      assert.ok(href, "Approved preview link required");
      assert.ok(href.startsWith("/tours/packet-preview.html?render_job_id="), "Approved packet preview required");
      const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/tours/pdf/download");
      await page.goto(new URL(href, origin).href);
      const previewBytes = await (await response).body();
      const previewStops = await observePdf(previewBytes);
      const downloading = page.waitForEvent("download");
      await page.getByRole("link", { name: "Download this PDF", exact: true }).click();
      const download = await downloading;
      const stream = await download.createReadStream();
      if (!stream) throw Object.assign(Error("PDF download unavailable"), { exitCode: 78 });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const downloaded = Buffer.concat(chunks);
      assert.deepEqual(previewBytes, downloaded, "Preview and download use exactly the same artifact bytes");
      for (const width of [1440, 390])
        for (const theme of ["light", "dark"]) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
            `${width} ${theme} overflow`,
          );
        }
      const candidates = page
        .context()
        .pages()
        .filter((candidate) => candidate !== page && new URL(candidate.url()).hostname === "reports.doctorcre.com")
        .slice(0, 10);
      const matching = await Promise.all(
        candidates.map(async (candidate) => {
          const refs = await candidate
            .locator(".report-item")
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-property-ref")));
          return refs.some((ref) => previewStops.some((stop) => stop.property === ref)) ? candidate : null;
        }),
      );
      const existing = matching.find((candidate) => candidate !== null);
      if (!existing)
        throw Object.assign(Error("Existing client share tab for this packet required for third rendering"), {
          exitCode: 78,
        });
      const shareState = await existing.evaluate(() => history.state);
      if (!shareState?.doctorcreShare || !shareState?.doctorcreShareContext)
        throw Object.assign(Error("Bound client share session required"), { exitCode: 78 });
      await page.goto("https://reports.doctorcre.com");
      await page.evaluate((state) => history.replaceState(state, ""), shareState);
      await page.reload();
      try {
        await page.locator(".report-item").first().waitFor();
      } catch {
        throw Object.assign(Error("Client share unavailable"), { exitCode: 78 });
      }
      const share = await page.locator(".report-item").evaluateAll((nodes) =>
        nodes.map((node) => ({
          property: node.getAttribute("data-property-ref") || "",
          label: node.querySelector(".route-label")?.textContent || "",
          name: node.querySelector("h3")?.textContent || "",
          address: node.querySelector("h3 + p")?.textContent || "",
          facts: Array.from(node.querySelectorAll("dd"), (fact) => fact.textContent || ""),
        })),
      );
      comparePacketStops(previewStops, await observePdf(downloaded), share);
      return {
        scope:
          "PDF bytes and current property facts only; map, times, notes, contacts and full branding are outside this partial proof",
        stops: share.length,
      };
    },
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      origin: { type: "string", default: "https://app.doctorcre.com" },
      "expected-commit": { type: "string" },
      "cdp-url": { type: "string" },
      "fixture-case": { type: "string" },
      "timeout-ms": { type: "string", default: "30000" },
    },
  });
  const result = await provePacket({
    origin: values.origin,
    expectedCommit: values["expected-commit"] || "",
    cdpUrl: values["cdp-url"],
    fixtureCase: values["fixture-case"],
    timeoutMs: Number(values["timeout-ms"]),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
