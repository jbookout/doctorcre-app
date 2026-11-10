export type CompleteLine = { page: number; line: number; text: string };
export type QuoteSource = {
  deal_id: string;
  attachment_id: string;
  content_hash: string;
  text_hash: string;
  text_format_version: "page-text.v1";
  filename: string;
};
export function selectLines(lines: CompleteLine[], page: number, start: number, end: number): string {
  if (start > end || end - start > lines.length) throw Error("Select a complete same-page line range.");
  const selected = lines.filter((line) => line.page === page && line.line >= start && line.line <= end);
  if (selected.length !== end - start + 1 || selected.some((line, index) => line.line !== start + index))
    throw Error("Load complete lines before selecting this range.");
  const text = selected.map((line) => line.text).join("\n");
  if (!text.trim()) throw Error("Select a range containing text.");
  if (Array.from(text).length > 4000) throw Error("Select up to 4,000 characters. The excerpt has not been shortened.");
  return text;
}
export function quoteBlock(
  source: QuoteSource,
  page: number,
  start: number,
  end: number,
  excerpt: string,
  comment: string,
): string {
  if (Array.from(comment).length > 2000) throw Error("Write a comment of up to 2,000 characters.");
  return [
    `Document excerpt: ${source.filename}`,
    `Deal: ${source.deal_id}`,
    `Attachment: ${source.attachment_id}`,
    `Content hash: ${source.content_hash}`,
    `Text hash: ${source.text_hash}`,
    `Text format: ${source.text_format_version}`,
    `Extracted page ${page}, lines ${start}-${end}`,
    "Excerpt:",
    excerpt,
    "Comment:",
    comment,
  ].join("\n");
}
export type QuoteFragment = CompleteLine & { offset: number; end_of_line: boolean };
export function joinQuoteContinuation(previous: QuoteFragment | null, fragments: QuoteFragment[]): QuoteFragment[] {
  const first = fragments[0];
  if (
    !previous ||
    !first ||
    previous.end_of_line ||
    previous.page !== first.page ||
    previous.line !== first.line ||
    first.offset !== previous.offset + Array.from(previous.text).length
  )
    return fragments;
  return [{ ...first, offset: previous.offset, text: previous.text + first.text }, ...fragments.slice(1)];
}
