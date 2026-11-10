import assert from "node:assert/strict";
import test from "node:test";
import { joinQuoteContinuation, quoteBlock, selectLines } from "../src/ui/document-quote.ts";

const source = {
  deal_id: "deal",
  attachment_id: "attachment",
  content_hash: "a".repeat(64),
  text_hash: "b".repeat(64),
  text_format_version: "page-text.v1" as const,
  filename: "Lease.pdf",
};
const lines = [
  { page: 1, line: 1, text: "  rent 😀  " },
  { page: 1, line: 2, text: "" },
  { page: 1, line: 3, text: "<script>inert</script>" },
];
test("whole same-page ranges preserve spaces, blank lines and inert text", () => {
  const quote = selectLines(lines, 1, 1, 3);
  assert.equal(quote, "  rent 😀  \n\n<script>inert</script>");
  const block = quoteBlock(source, 1, 1, 3, quote, "Keep comment");
  for (const value of [source.content_hash, source.text_hash, "page-text.v1", "Lease.pdf", "Keep comment", quote])
    assert.ok(block.includes(value));
});
test("invalid, incomplete, blank and oversized ranges refuse without truncation", () => {
  const invalid: [number, number, number][] = [
    [1, 3, 1],
    [1, 1, 4],
    [2, 1, 1],
    [1, 2, 2],
  ];
  for (const args of invalid) assert.throws(() => selectLines(lines, ...args));
  assert.throws(() => selectLines([{ page: 1, line: 1, text: "x".repeat(4001) }], 1, 1, 1));
  assert.throws(() => quoteBlock(source, 1, 1, 1, "a", "😀".repeat(2001)));
});

test("Unicode continuation only becomes selectable after the exact complete suffix", () => {
  const head = { page: 1, line: 1, offset: 0, text: "a😀", end_of_line: false };
  const suffix = { page: 1, line: 1, offset: 2, text: " b", end_of_line: true };
  assert.deepEqual(joinQuoteContinuation(head, [suffix]), [{ ...suffix, offset: 0, text: "a😀 b" }]);
  assert.deepEqual(joinQuoteContinuation(head, [{ ...suffix, offset: 3 }]), [{ ...suffix, offset: 3 }]);
});
