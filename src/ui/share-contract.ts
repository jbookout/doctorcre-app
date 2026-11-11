const MAX_SHARE_BYTES = 26214400;
const MIME = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function validateSharedFile(file: File) {
  if (
    !MIME.has(file.type) ||
    file.size < 1 ||
    file.size > MAX_SHARE_BYTES ||
    !file.name.trim() ||
    file.name.length > 255
  )
    throw Error("Share one PDF, JPEG, PNG, WebP or HEIC file, up to 25 MiB.");
}
export type Attachment = {
  attachment_id: string;
  deal_id: string;
  sha256: string;
  filename: string;
  mime: string;
  bytes: number;
};
export type Material = Omit<Attachment, "attachment_id">;
export function parseReservation(
  value: unknown,
  deal: string,
  destination: "documents" | "deliverables" = "documents",
) {
  if (
    !record(value) ||
    value.ok !== true ||
    value.schema_version !== (destination === "documents" ? "deal-document-intake.v1" : "deal-deliverables.v1") ||
    !record(value.deliverable)
  )
    throw Error("Invalid reservation");
  const row = value.deliverable;
  if (
    typeof row.id !== "string" ||
    !uuid.test(row.id) ||
    row.deal_id !== deal ||
    !uuid.test(deal) ||
    row.state !== "started" ||
    value.upload_path !== `/api/v1/deal-deliverables/${deal}/${row.id}/bytes`
  )
    throw Error("Invalid reservation");
  return { id: row.id, uploadPath: value.upload_path };
}
export function parseAttachment(value: unknown, expected: Material): Attachment {
  if (
    !record(value) ||
    value.ok !== true ||
    value.schema_version !== "deal-document-intake.v1" ||
    !record(value.attachment) ||
    !record(value.deliverable)
  )
    throw Error("Document receipt unavailable");
  const row = value.attachment;
  if (
    typeof row.attachment_id !== "string" ||
    !uuid.test(row.attachment_id) ||
    !uuid.test(expected.deal_id) ||
    !/^[a-f0-9]{64}$/.test(expected.sha256) ||
    row.deal_id !== expected.deal_id ||
    row.sha256 !== expected.sha256 ||
    row.filename !== expected.filename ||
    row.mime !== expected.mime ||
    row.bytes !== expected.bytes ||
    value.deliverable.id !== row.attachment_id ||
    value.deliverable.deal_id !== expected.deal_id ||
    value.deliverable.state !== "finalized"
  )
    throw Error("Document receipt mismatch");
  return { ...expected, attachment_id: row.attachment_id };
}
