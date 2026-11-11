import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { packetMapPoints, parsePublicTourPacket } from "../src/ui/public-tour-packet.ts";
import { packetProofPdf } from "../test/packet-pdf.fixture.ts";
import { presentedPacket } from "../test/packet-presentation.fixture.ts";
import { proofFetch } from "./app-release-reader.mjs";
import { requireContainingRelease } from "./containing-release.ts";
import { prove as runProof } from "./prove-activity-attribution-panel.mjs";
import { assertPublishedPacketPdf } from "./public-tour-pdf-proof.ts";
import { requireTourEvidence } from "./tour-proof-evidence.ts";

const unavailable = (message: string) => Object.assign(Error(message), { exitCode: 78 });
export async function proveTourPacket({
  origin,
  expectedCommit,
  shareUrlFile,
  fixtureCase,
  pdfUrlFile,
  cdpUrl,
}: {
  origin: string;
  expectedCommit: string;
  shareUrlFile?: string;
  fixtureCase?: string;
  pdfUrlFile?: string;
  cdpUrl?: string;
}) {
  if (fixtureCase) {
    if (!["pass", "fail", "insufficient"].includes(fixtureCase)) throw unavailable("Unknown fixture case");
    const stops = [1, 2, 3].map((n) => ({
      property_ref: `property:public:synthetic_stop_000${n}`,
      route_sequence: n,
      route_label: String(n),
      name: `Example ${n}`,
      address: `${n} Example Street`,
    }));
    if (fixtureCase === "insufficient") return { status: "insufficient_evidence", exitCode: 78 };
    const packet = parsePublicTourPacket(presentedPacket(stops));
    try {
      await assertPublishedPacketPdf(await packetProofPdf(packet, fixtureCase === "fail"), packet);
      return { status: "passed", exitCode: 0 };
    } catch {
      return { status: "failed", exitCode: 1 };
    }
  }
  return runProof({
    origin,
    expectedCommit,
    contains: requireContainingRelease,
    ...(cdpUrl ? { cdpUrl } : {}),
    observe: async (page) => {
      if (!shareUrlFile) throw unavailable("Approved share URL file required");
      if (!pdfUrlFile) throw unavailable("Published server PDF URL file required");
      const url = new URL((await readFile(shareUrlFile, "utf8")).trim());
      if (
        url.origin !== new URL(origin).origin ||
        url.pathname !== "/share" ||
        !url.hash ||
        url.username ||
        url.password
      )
        throw unavailable("Approved share URL on the target origin required");
      await page.goto(url.href);
      const open = page.getByRole("button", { name: "Open tour", exact: true });
      if (!(await open.isVisible())) throw unavailable("Share session unavailable");
      const reads = Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === "/api/share/report"),
        page.waitForResponse((response) => new URL(response.url()).pathname === "/api/share/map"),
      ]);
      void reads.catch(() => {});
      await open.click();
      const [reportResponse, mapResponse] = await reads;
      if (!reportResponse.ok() || !mapResponse.ok()) throw unavailable("Packet reads unavailable");
      await page.waitForFunction(() => /loaded|unavailable/.test(document.querySelector("#status")?.textContent || ""));
      if ((await page.locator("#status").textContent()) !== "Report and map loaded.")
        throw unavailable("Approved packet with map required");
      let values: { report: { data: unknown }; map: { data: unknown } };
      try {
        values = { report: await reportResponse.json(), map: await mapResponse.json() };
      } catch {
        throw unavailable("Unreadable packet evidence");
      }
      const pdfUrl = new URL((await readFile(pdfUrlFile, "utf8")).trim());
      if (
        pdfUrl.origin !== new URL(origin).origin ||
        pdfUrl.pathname !== "/api/tours/pdf/download" ||
        !pdfUrl.searchParams.get("render_job_id") ||
        pdfUrl.username ||
        pdfUrl.password ||
        pdfUrl.hash
      )
        throw unavailable("Approved server PDF download URL required");
      const cookies = await page.context().cookies(pdfUrl.href);
      const response = await proofFetch(pdfUrl.href, {
        signal: AbortSignal.timeout(5000),
        headers: { cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") },
      });
      if ([401, 403, 404].includes(response.status)) throw unavailable("Reviewed server PDF unavailable");
      const bytes = Buffer.from(await response.arrayBuffer());
      await requireTourEvidence("containing", [
        { kind: "json", value: values.report?.data },
        { kind: "pdf", value: bytes },
      ]);
      const packet = parsePublicTourPacket(values.report?.data);
      const points = packetMapPoints(packet, values.map.data);
      assert.equal(response.ok, true);
      assert.ok(response.headers.get("content-type")?.startsWith("application/pdf"));
      await assertPublishedPacketPdf(bytes, packet);
      for (const width of [1440, 390])
        for (const theme of ["light", "dark"] as const) {
          await page.setViewportSize({ width, height: 1000 });
          await page.emulateMedia({ colorScheme: theme, media: "screen" });
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          assert.deepEqual(
            await page.locator(".report-item h3").allTextContents(),
            packet.map((stop) => stop.name),
          );
          assert.deepEqual(
            await page.locator(".report-item dd").allTextContents(),
            packet.flatMap((stop) => stop.facts.map((fact) => fact.value)),
          );
          assert.deepEqual(
            await page.locator(".maplibregl-marker").allTextContents(),
            points.map((point) => point.route_label),
          );
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.emulateMedia({ media: "print" });
          assert.equal(await page.locator(".packet-notes:visible").count(), packet.length);
          assert.equal(await page.locator(".maplibregl-marker:visible").count(), packet.length);
        }
      return {
        propertyCount: packet.length,
        assertions: [
          "ordered properties",
          "fixed facts",
          "map labels",
          "downloaded server PDF exact template and facts",
          "print layout",
          "phone overflow",
          "four theme and width combinations",
        ],
      };
    },
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        origin: { type: "string" },
        "expected-commit": { type: "string" },
        "share-url-file": { type: "string" },
        "fixture-case": { type: "string" },
        "pdf-url-file": { type: "string" },
        "cdp-url": { type: "string" },
      },
    });
    const result = await proveTourPacket({
      origin: values.origin || "https://app.doctorcre.com",
      expectedCommit: values["expected-commit"] || "",
      ...(values["share-url-file"] ? { shareUrlFile: values["share-url-file"] } : {}),
      ...(values["pdf-url-file"] ? { pdfUrlFile: values["pdf-url-file"] } : {}),
      ...(values["cdp-url"] ? { cdpUrl: values["cdp-url"] } : {}),
      ...(values["fixture-case"] ? { fixtureCase: values["fixture-case"] } : {}),
    });
    process.stdout.write(
      `${JSON.stringify({ status: result.status, exitCode: result.exitCode, ...(result.error ? { error: result.exitCode === 78 ? result.error : "Packet assertion failed" } : {}) })}\n`,
    );
    process.exitCode = result.exitCode;
  } catch {
    process.stdout.write('{"status":"insufficient_evidence","exitCode":78}\n');
    process.exitCode = 78;
  }
}
