import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseDocumentText } from "../src/ui/deal-document-text.ts";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/deal-document-text/${name}.json`, import.meta.url), "utf8"));
const produced = fixture("produced");
const identity = {
  deal_id: produced.deal_id,
  attachment_id: produced.attachment_id,
  content_hash: produced.content_hash,
};
test("registered responses pass through the production parser", () => {
  for (const name of ["produced", "not-produced", "no_text", "unavailable"]) {
    const value = fixture(name);
    assert.equal(parseDocumentText(value, { ...identity, content_hash: value.content_hash }).status, value.status);
  }
});
test("identity, schema, status, gaps, overlaps and nonadvancing cursors refuse", () => {
  for (const change of [
    { deal_id: "00000000-0000-4000-8000-000000000099" },
    { schema_version: "unknown" },
    { status: "no_text" },
    { lines: [{ ...produced.lines[0], offset: 1 }] },
    { lines: [...produced.lines, produced.lines[0]] },
    { next: { ...produced.next, line: 1 } },
    { next: { ...produced.next, line: 3 } },
    { text_hash: null },
    { reason: "not_produced" },
  ])
    assert.throws(() => parseDocumentText({ ...produced, ...change }, identity));
});

test("pinned producer schema checks every registered response", async () => {
  const { Ajv } = await import("ajv");
  const { createHash } = await import("node:crypto");
  const bytes = readFileSync(new URL("../contracts/deal-document-text.v1/response.schema.json", import.meta.url));
  const pin = JSON.parse(
    readFileSync(new URL("../contracts/deal-document-text.v1/provenance.json", import.meta.url), "utf8"),
  );
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.schema_sha256);
  for (const [name, digest] of Object.entries(pin.recorded_response_sha256))
    assert.equal(
      createHash("sha256")
        .update(readFileSync(new URL(`./fixtures/deal-document-text/${name}`, import.meta.url)))
        .digest("hex"),
      digest,
    );
  const validate = new Ajv({ strict: false, formats: { uuid: true } }).compile(JSON.parse(bytes.toString()));
  for (const name of [
    "produced",
    "not-produced",
    "no_text",
    "unavailable",
    "full",
    "split",
    "continuation",
    "second-page",
    "second-document",
    "no-text-current",
    "unsupported-current",
    "no-text-second",
  ]) {
    const value = fixture(name);
    assert.equal(validate(value), true);
    parseDocumentText(value, {
      deal_id: value.deal_id,
      attachment_id: value.attachment_id,
      content_hash: value.content_hash,
      ...(value.lines[0]
        ? { page: value.lines[0].page, line: value.lines[0].line, offset: value.lines[0].offset }
        : {}),
    });
  }
});
test("registered cross-page and Unicode continuation retain exact addresses", () => {
  const full = parseDocumentText(fixture("full"), identity);
  assert.equal(full.status, "produced");
  assert.deepEqual(
    full.lines.map((line) => [line.page, line.line, line.text]),
    [
      [1, 1, "first"],
      [1, 2, ""],
      [1, 3, "last"],
      [1, 4, ""],
      [2, 1, "😀second"],
    ],
  );
  const split = parseDocumentText(fixture("split"), { ...identity, page: 2, line: 1, offset: 0, max_characters: 1 });
  assert.deepEqual(split.next, { content_hash: identity.content_hash, page: 2, line: 1, offset: 1 });
  const continued = parseDocumentText(fixture("continuation"), { ...identity, page: 2, line: 1, offset: 1 });
  assert.equal(continued.lines[0]?.text, "second");
  assert.throws(() => parseDocumentText(fixture("split"), { ...identity, page: 2, line: 1, offset: 1 }));
  assert.throws(() =>
    parseDocumentText(fixture("continuation"), { ...identity, page: 2, line: 1, offset: 1 }, "b".repeat(64)),
  );
});
