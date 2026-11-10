import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Page } from "playwright";
import type { Material } from "../src/ui/share-contract.ts";
import { parseAttachment } from "../src/ui/share-contract.ts";
import { prove as runProof } from "./prove-activity-attribution-panel.mjs";

const unavailable = (message: string) => Object.assign(Error(message), { exitCode: 78 });
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function material(value: unknown): Material {
  if (
    !record(value) ||
    typeof value.deal_id !== "string" ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.deal_id) ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    typeof value.filename !== "string" ||
    !value.filename ||
    value.filename.length > 255 ||
    typeof value.mime !== "string" ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > 26214400
  )
    throw unavailable("Expected receipt material required");
  return {
    deal_id: value.deal_id,
    sha256: value.sha256,
    filename: value.filename,
    mime: value.mime,
    bytes: value.bytes,
  };
}
function documents(value: unknown) {
  if (
    !record(value) ||
    value.ok !== true ||
    value.schema_version !== "deal-documents.v1" ||
    !Array.isArray(value.documents)
  )
    throw unavailable("Document list unavailable");
  return value.documents;
}
export async function proveShare({
  origin,
  expectedCommit,
  cdpUrl,
  expected,
  attachmentId,
  fixtureCase,
}: {
  origin: string;
  expectedCommit: string;
  cdpUrl?: string;
  expected?: Material;
  attachmentId?: string;
  fixtureCase?: string;
}) {
  if (fixtureCase) {
    if (!["pass", "fail", "insufficient"].includes(fixtureCase)) throw unavailable("Unknown fixture case");
    const fixture: unknown = JSON.parse(
      await readFile(new URL("../contracts/fixtures/deal-document-intake.v1.json", import.meta.url), "utf8"),
    );
    if (!record(fixture) || !record(fixture.finalize)) throw unavailable("Producer fixture unavailable");
    const finalize = fixture.finalize,
      expected = material(finalize.attachment),
      list = documents(fixture.list);
    return runProof({
      origin,
      expectedCommit,
      readRelease: async () => ({ source_commit: fixtureCase === "insufficient" ? "0".repeat(40) : expectedCommit }),
      contains: async (commit: string, observed: string) => {
        if (commit !== observed) throw unavailable("Containing release unavailable");
      },
      engine: { launch: async () => ({ newPage: async () => ({}), close: async () => {} }) },
      observe: async () => {
        const receipt = parseAttachment(finalize, expected);
        const documents = fixtureCase === "fail" ? [] : list;
        assert.ok(
          documents.some(
            (row: unknown) => record(row) && row.id === receipt.attachment_id && row.content_hash === receipt.sha256,
          ),
          "Canonical attachment appears in document list",
        );
        return { receipt, scope: "contract fixture only; no phone share-sheet proof" };
      },
    });
  }
  return runProof({
    origin,
    expectedCommit,
    cdpUrl,
    observe: async (page: Page) => {
      if (!cdpUrl || !expected || !attachmentId)
        throw unavailable("Attended phone share receipt and signed-in browser required");
      if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(attachmentId))
        throw unavailable("Exact attachment UUID required");
      material(expected);
      await page.goto(new URL("/share-intake.html", origin).href);
      const observed = await page.evaluate(
        async ({ expected, attachmentId }) => {
          const { sessionFetch } = await import(String("/js/private-session.js"));
          const receiptResponse = await sessionFetch(
            `/api/v1/deal-deliverables/${expected.deal_id}/${attachmentId}/receipt`,
            {
              cache: "no-store",
              credentials: "same-origin",
            },
          );
          if ([401, 403].includes(receiptResponse.status)) return null;
          const receipt: unknown = await receiptResponse.json();
          const response = await sessionFetch("/mcp", {
            method: "POST",
            cache: "no-store",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: "share-proof",
              method: "tools/call",
              params: { name: "list-deal-documents", arguments: { deal_id: expected.deal_id, limit: 50 } },
            }),
          });
          if (!response.ok || !receiptResponse.ok) return null;
          const envelope: unknown = await response.json();
          return { receipt, envelope };
        },
        { expected, attachmentId },
      );
      if (!observed) throw unavailable("Authenticated attachment read unavailable");
      const receipt = parseAttachment(observed.receipt, expected);
      assert.equal(receipt.attachment_id, attachmentId);
      const envelope = observed.envelope;
      if (
        !record(envelope) ||
        !record(envelope.result) ||
        envelope.result.isError ||
        !Array.isArray(envelope.result.content)
      )
        throw unavailable("Document list unavailable");
      const text = envelope.result.content.find((row: unknown) => record(row) && row.type === "text");
      if (!record(text) || typeof text.text !== "string") throw unavailable("Document list unavailable");
      const listed: unknown = JSON.parse(text.text);
      const rows = documents(listed);
      const found = rows.some(
        (row: unknown) =>
          record(row) &&
          row.id === receipt.attachment_id &&
          row.content_hash === expected.sha256 &&
          row.display_name === expected.filename,
      );
      if (!found && record(listed) && listed.has_more === true)
        throw unavailable("Attachment not on first document page. More evidence required.");
      assert.ok(found, "Canonical attachment readback");
      return { receipt, scope: "attachment receipt and document list; phone OS observation remains attended evidence" };
    },
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        origin: { type: "string", default: "https://app.doctorcre.com" },
        "expected-commit": { type: "string" },
        "cdp-url": { type: "string" },
        "expected-json": { type: "string" },
        "attachment-id": { type: "string" },
        "fixture-case": { type: "string" },
      },
    });
    const expected = values["expected-json"]
      ? material(JSON.parse(await readFile(values["expected-json"], "utf8")))
      : undefined;
    const result = await proveShare({
      origin: values.origin,
      expectedCommit: values["expected-commit"] ?? "",
      ...(values["cdp-url"] ? { cdpUrl: values["cdp-url"] } : {}),
      ...(expected ? { expected } : {}),
      ...(values["attachment-id"] ? { attachmentId: values["attachment-id"] } : {}),
      ...(values["fixture-case"] ? { fixtureCase: values["fixture-case"] } : {}),
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.log(
      JSON.stringify({
        status: "insufficient_evidence",
        error: error instanceof Error ? error.message : "Proof unavailable",
      }),
    );
    process.exitCode = 78;
  }
}
