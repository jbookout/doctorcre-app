import { type Schema, Validator } from "@cfworker/json-schema";
import schema from "../../contracts/client-needs.v1.json" with { type: "json" };

type Need = {
  id: string;
  deal_id: string;
  vendor_id: string;
  client_id: string;
  version: number;
  revision: number;
  source_ref: string;
  source_revision: string;
  applicability: string;
  restriction: "allowed";
  observed_at: string;
  fresh_until: string;
  approved_revision: number;
  approved_by: string;
  approved_at: string;
  state: "approved";
  description: string;
  client_name: string;
  deal_name: string;
  vendor_ref: string;
  identity_restricted: false;
};
export type NeedsQuery = { vendor: string; offset: number; limit: number };
type NeedsPage = {
  schema_version: "client-needs.v1";
  subject: "vendor";
  subject_id: string;
  as_of: string;
  state: "ready" | "missing_approval" | "empty";
  rows: Need[];
  next_offset: number | null;
};
// The producer JSON schema is pinned verbatim; JSON imports widen its literal types.
const validator = new Validator(schema as Schema);
function validate(value: unknown): value is NeedsPage {
  return validator.validate(value).valid;
}
export function parseClientNeeds(value: unknown, query: NeedsQuery, now = Date.now()): NeedsPage {
  if (
    !validate(value) ||
    value.subject !== "vendor" ||
    value.subject_id !== query.vendor ||
    value.rows.length > query.limit ||
    (value.state !== "ready" && value.rows.length !== 0) ||
    (value.next_offset !== null && value.next_offset <= query.offset) ||
    new Set(value.rows.map((row) => row.id)).size !== value.rows.length ||
    value.rows.some(
      (row) =>
        row.vendor_id !== query.vendor ||
        row.approved_revision !== row.revision ||
        Date.parse(row.fresh_until) <= now ||
        Date.parse(row.observed_at) > now,
    )
  ) {
    throw new Error("Client needs response unavailable");
  }
  return value;
}
