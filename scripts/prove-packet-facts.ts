import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readPacketPresentation } from "../src/ui/packet-facts.ts";
import { packetFixturePdf } from "./packet-fixture.ts";
import { comparePacketStops, observePdf } from "./packet-pdf-observation.ts";
import { prove as runProof } from "./prove-activity-attribution-panel.mjs";

export async function provePacket(options: {
  origin: string;
  expectedCommit: string;
  cdpUrl?: string | undefined;
  fixtureCase?: string | undefined;
  timeoutMs?: number;
}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    return { status: "insufficient_evidence", exitCode: 78, error: "Deadline must be 1 to 30000 milliseconds" };
  if (options.fixtureCase) {
    if (options.fixtureCase === "unavailable")
      return {
        status: "insufficient_evidence",
        exitCode: 78,
        error: "Approved packet and bound client share evidence required",
      };
    const mutation = options.fixtureCase.replace(/^near-miss-/, "");
    assert.ok(
      [
        "pass",
        "near-miss",
        "brand",
        "asOf",
        "appointment",
        "note",
        "property",
        "label",
        "name",
        "address",
        "fact-0",
        "fact-1",
        "fact-2",
        "fact-3",
        "fact-4",
      ].includes(mutation),
    );
    const pdf = await observePdf(await packetFixturePdf());
    const fixture: unknown = JSON.parse(
      await readFile(new URL("../test/fixtures/packet-parity/share.json", import.meta.url), "utf8"),
    );
    const presentation = readPacketPresentation(fixture);
    assert.ok(presentation);
    const share = presentation.stops.map((p) => ({
      property: p.property_ref,
      label: p.route_label,
      name: p.name,
      address: p.address,
      facts: p.facts.map((f) => f.value),
      brand: presentation.brand,
      asOf: "",
      appointment: p.appointment || "",
      note: p.public_packet_note || "",
    }));
    if (share[0]) {
      if (options.fixtureCase === "near-miss") share[0].facts[1] = "11600 SF";
      else if (mutation.startsWith("fact-")) share[0].facts[Number(mutation.slice(5))] += "x";
      else if (
        mutation === "brand" ||
        mutation === "asOf" ||
        mutation === "appointment" ||
        mutation === "note" ||
        mutation === "property" ||
        mutation === "label" ||
        mutation === "name" ||
        mutation === "address"
      )
        share[0][mutation] += "x";
    }
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
      await page.waitForFunction((count) => {
        const pages = Array.from(document.querySelectorAll("canvas[data-rendered=true]"));
        return (
          pages.length === count &&
          pages.every((canvas) => canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0)
        );
      }, previewStops.length);
      const downloading = page.waitForEvent("download");
      await page.getByRole("link", { name: "Download this PDF", exact: true }).click();
      const download = await downloading;
      const stream = await download.createReadStream();
      if (!stream) throw Object.assign(Error("PDF download unavailable"), { exitCode: 78 });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const downloaded = Buffer.concat(chunks);
      assert.ok(previewBytes.equals(downloaded), "Preview and download artifact bytes differ");
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
          brand: node.ownerDocument.querySelector(".masthead > .eyebrow")?.textContent || "",
          appointment: node.querySelector(".packet-appointment")?.textContent || "",
          note: node.querySelector(".packet-public-note")?.textContent || "",
          asOf: node.querySelector(".packet-as-of")?.textContent || "",
        })),
      );
      comparePacketStops(previewStops, await observePdf(downloaded), share);
      return {
        scope: "PDF bytes, ordered stops, recorded appointments and explicit public notes",
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
