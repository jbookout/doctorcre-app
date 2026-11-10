export type TextIdentity = { deal_id: string; attachment_id: string; content_hash: string };
export type TextPosition = { page: number; line: number; offset: number };
export type TextRequest = TextIdentity & Partial<TextPosition> & { max_characters?: number };
type TextFragment = TextPosition & { text: string; end_of_line: boolean };
export type TextChunk = TextIdentity & {
  schema_version: "deal-document-text.v1";
  text_format_version: "page-text.v1";
  ok: true;
} & (
    | {
        status: "produced";
        text_hash: string;
        page_count: number;
        lines: TextFragment[];
        next: (TextPosition & { content_hash: string }) | null;
      }
    | {
        status: "no_text" | "unavailable";
        reason: "not_produced" | "no_text_layer" | "unsupported_or_limits";
        text_hash: string | null;
        page_count: number | null;
        lines: [];
        next: null;
      }
  );
export type DocumentTextClient = {
  readDealDocumentText(args: TextRequest, options: { signal: AbortSignal }): Promise<unknown>;
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
function position(value: Record<string, unknown>): TextPosition {
  if (!integer(value.page, 1, 1000) || !integer(value.line, 1, 500001) || !integer(value.offset, 0, 500000))
    throw Error("Invalid text address");
  return { page: value.page, line: value.line, offset: value.offset };
}
function follows(previous: TextFragment, next: TextPosition) {
  return previous.end_of_line
    ? next.offset === 0 &&
        ((next.page === previous.page && next.line === previous.line + 1) ||
          (next.page === previous.page + 1 && next.line === 1))
    : next.page === previous.page &&
        next.line === previous.line &&
        next.offset === previous.offset + Array.from(previous.text).length;
}
export function parseDocumentText(value: unknown, request: TextRequest, textHash?: string): TextChunk {
  if (
    !record(value) ||
    !keys(value, [
      "ok",
      "schema_version",
      "text_format_version",
      "deal_id",
      "attachment_id",
      "content_hash",
      "text_hash",
      "status",
      "page_count",
      "lines",
      "next",
      "reason",
    ]) ||
    value.ok !== true ||
    value.schema_version !== "deal-document-text.v1" ||
    value.text_format_version !== "page-text.v1" ||
    value.deal_id !== request.deal_id.toLowerCase() ||
    value.attachment_id !== request.attachment_id.toLowerCase() ||
    value.content_hash !== request.content_hash ||
    !hash(value.content_hash) ||
    (textHash !== undefined && value.text_hash !== textHash) ||
    !Array.isArray(value.lines) ||
    value.lines.length > 200
  )
    throw Error("Invalid document text response");
  const identity: TextIdentity & {
    ok: true;
    schema_version: "deal-document-text.v1";
    text_format_version: "page-text.v1";
  } = {
    ok: true,
    schema_version: "deal-document-text.v1",
    text_format_version: "page-text.v1",
    deal_id: request.deal_id.toLowerCase(),
    attachment_id: request.attachment_id.toLowerCase(),
    content_hash: request.content_hash,
  };
  if (value.status === "unavailable" && value.reason === "not_produced") {
    if (value.text_hash !== null || value.page_count !== null || value.lines.length || value.next !== null)
      throw Error("Invalid availability");
    return {
      ...identity,
      status: "unavailable",
      reason: "not_produced",
      text_hash: null,
      page_count: null,
      lines: [],
      next: null,
    };
  }
  if (!hash(value.text_hash) || !integer(value.page_count, 0, 1000)) throw Error("Invalid retained identity");
  if (value.status === "no_text" || value.status === "unavailable") {
    const reason = value.status === "no_text" ? "no_text_layer" : "unsupported_or_limits";
    if (value.reason !== reason || value.lines.length || value.next !== null) throw Error("Invalid availability");
    return {
      ...identity,
      status: value.status,
      reason,
      text_hash: value.text_hash,
      page_count: value.page_count,
      lines: [],
      next: null,
    };
  }
  if (value.status !== "produced" || "reason" in value || !value.lines.length || !value.page_count)
    throw Error("Invalid produced text");
  const lines: TextFragment[] = [];
  let size = 0;
  for (const fragment of value.lines) {
    if (
      !record(fragment) ||
      !keys(fragment, ["page", "line", "offset", "text", "end_of_line"]) ||
      typeof fragment.text !== "string" ||
      fragment.text.includes("\n") ||
      typeof fragment.end_of_line !== "boolean"
    )
      throw Error("Invalid text fragment");
    const address = position(fragment);
    const length = Array.from(fragment.text).length;
    size += length;
    const previous = lines.at(-1);
    if (
      address.page > value.page_count ||
      address.offset + length > 500000 ||
      (!fragment.end_of_line && !length) ||
      (previous
        ? !follows(previous, address)
        : address.page !== (request.page ?? 1) ||
          address.line !== (request.line ?? 1) ||
          address.offset !== (request.offset ?? 0))
    )
      throw Error("Invalid text continuity");
    lines.push({ ...address, text: fragment.text, end_of_line: fragment.end_of_line });
  }
  const last = lines.at(-1);
  if (!last || size > (request.max_characters ?? 16000)) throw Error("Invalid chunk size");
  let next: (TextPosition & { content_hash: string }) | null = null;
  if (value.next !== null) {
    if (
      !record(value.next) ||
      !keys(value.next, ["content_hash", "page", "line", "offset"]) ||
      value.next.content_hash !== request.content_hash
    )
      throw Error("Invalid continuation");
    const address = position(value.next);
    if (address.page > value.page_count || !follows(last, address)) throw Error("Nonadvancing continuation");
    next = { ...address, content_hash: request.content_hash };
  } else if (!last.end_of_line || last.page !== value.page_count) throw Error("Incomplete text");
  return { ...identity, status: "produced", text_hash: value.text_hash, page_count: value.page_count, lines, next };
}
