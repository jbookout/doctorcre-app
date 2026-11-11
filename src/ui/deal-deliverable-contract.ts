const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function parseDeliverable(value: unknown, deal: string) {
  if (record(value) && typeof value.bytes === "string" && /^[1-9][0-9]*$/.test(value.bytes))
    value = { ...value, bytes: Number(value.bytes) };
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    !uuid.test(deal) ||
    value.deal_id !== deal ||
    typeof value.filename !== "string" ||
    !value.filename.trim() ||
    value.filename.length > 255 ||
    typeof value.mime !== "string" ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > 26214400 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    value.state !== "finalized" ||
    (value.visibility !== "private" && value.visibility !== "shared") ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1
  )
    throw Error("Deliverable identity unavailable");
  return {
    id: value.id,
    deal_id: deal,
    filename: value.filename,
    mime: value.mime,
    bytes: value.bytes,
    sha256: value.sha256,
    state: value.state,
    visibility: value.visibility,
    version: value.version,
  };
}
export function parseDeliverableList(value: unknown, deal: string) {
  if (
    !record(value) ||
    value.ok !== true ||
    value.schema_version !== "deal-deliverables.v1" ||
    !Array.isArray(value.deliverables) ||
    value.deliverables.length > 100
  )
    throw Error("Deliverables unavailable");
  const rows = value.deliverables.map((row: unknown) => parseDeliverable(row, deal));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw Error("Repeated deliverable");
  return rows;
}
