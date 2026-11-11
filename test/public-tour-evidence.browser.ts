import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { PDFDocument } from "pdf-lib";
import { startFixture } from "../scripts/fixture-http.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { parsePublicTourPacket } from "../src/ui/public-tour-packet.ts";
import { packetProofPdf } from "./packet-pdf.fixture.ts";

const recorded = JSON.parse(await readFile(new URL("./fixtures/tour-packet/response.json", import.meta.url), "utf8"));
const packet = parsePublicTourPacket(recorded);
const commit = "1".repeat(40);
for (const [version, nearMiss] of [
  ["2.0.0", false],
  ["2.0.0", true],
  ["1.1.0", true],
  ["1.1.0", false],
  ["missing", false],
] as const)
  test(`public packet CLI ${version} near miss ${nearMiss}`, async (t) => {
    const doc = await PDFDocument.load(await packetProofPdf(packet, nearMiss));
    if (version !== "missing") doc.setSubject(`Tour template ${version}`);
    else doc.setSubject("");
    doc.setProducer(`CARR deterministic PDF renderer ${version}`);
    doc.setCreator(`CARR Tour Operations ${version}`);
    const pdf = Buffer.from(await doc.save());
    const server = await startFixture({
      routes: new Map([
        [
          "/app-release",
          {
            contentType: "application/json",
            body: JSON.stringify({ service: "doctorcre-app", environment: "production", source_commit: commit }),
          },
        ],
        ["/api/tours/pdf/download", { contentType: "application/pdf", body: pdf }],
      ]),
    });
    const root = `${temporaryDirectory("packet-evidence-cli-", t)}/`;
    await writeFile(`${root}share.txt`, `${server.origin}/share#${"a".repeat(43)}`);
    await writeFile(`${root}pdf.txt`, `${server.origin}/api/tours/pdf/download?render_job_id=synthetic`);
    await writeFile(
      `${root}preload.mjs`,
      `import {chromium} from ${JSON.stringify(import.meta.resolve("playwright"))};
 const report=${JSON.stringify(recorded)};
 const packet=${JSON.stringify(packet)}; const points=report.stops.map(s=>({...s,latitude:30.4,longitude:-87.2})).sort((a,b)=>a.route_sequence-b.route_sequence);
 let read=0;
 const page={goto:async()=>{},getByRole:()=>({isVisible:async()=>true,click:async()=>{}}),waitForResponse:async()=>({ok:()=>true,json:async()=>({data:read++===0?report:{points}})}),waitForFunction:async()=>{},locator:s=>({textContent:async()=> 'Report and map loaded.',allTextContents:async()=>s.includes('h3')?packet.map(x=>x.name):s.includes('dd')?packet.flatMap(x=>x.facts.map(f=>f.value)):points.map(x=>x.route_label),count:async()=>packet.length}),setViewportSize:async()=>{},emulateMedia:async()=>{},evaluate:async()=>true,context:()=>({cookies:async()=>[]})};
 chromium.launch=async()=>({newPage:async()=>page,close:async()=>{}});`,
    );
    try {
      const result = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          `${root}preload.mjs`,
          "scripts/prove-public-tour-packet.ts",
          "--origin",
          server.origin,
          "--expected-commit",
          commit,
          "--share-url-file",
          `${root}share.txt`,
          "--pdf-url-file",
          `${root}pdf.txt`,
        ],
        { timeout: 40000 },
      ).then(
        (result) => ({ code: 0, stdout: result.stdout }),
        (error: { code: number; stdout: string }) => ({ code: error.code, stdout: error.stdout }),
      );
      const expected = version !== "2.0.0" ? 78 : nearMiss ? 1 : 0;
      assert.equal(result.code, expected, result.stdout);
      const receipt = JSON.parse(result.stdout);
      assert.equal(receipt.status, expected === 78 ? "insufficient_evidence" : expected === 1 ? "failed" : "passed");
      if (expected === 78) assert.match(receipt.error, /PDF template/);
    } finally {
      await server.close();
    }
  });

test("public packet CLI unreachable CDP is insufficient on a containing release", async () => {
  const server = await startFixture({
    routes: new Map([
      [
        "/app-release",
        {
          contentType: "application/json",
          body: JSON.stringify({ service: "doctorcre-app", environment: "production", source_commit: commit }),
        },
      ],
    ]),
  });
  try {
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          "scripts/prove-public-tour-packet.ts",
          "--origin",
          server.origin,
          "--expected-commit",
          commit,
          "--cdp-url",
          "http://127.0.0.1:1",
        ],
        { timeout: 40000 },
      ),
      (error: unknown) => {
        assert.ok(error && typeof error === "object" && "code" in error && "stdout" in error);
        assert.equal(error.code, 78);
        const receipt = JSON.parse(String(error.stdout));
        assert.equal(receipt.status, "insufficient_evidence");
        assert.match(receipt.error, /Browser session unavailable/);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});
