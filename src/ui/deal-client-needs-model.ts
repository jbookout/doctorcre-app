import { type Schema, Validator } from "@cfworker/json-schema";
import schema from "../../contracts/client-needs.v1.json" with { type: "json" };
export type Need = {
  id: string;
  deal_id: string;
  client_id: string;
  vendor_id: string;
  version: number;
  revision: number;
  source_ref: string;
  source_revision: string;
  applicability: string;
  restriction: "allowed" | "restricted";
  observed_at: string;
  fresh_until: string;
  approved_revision: number | null;
  approved_by: string | null;
  approved_at: string | null;
  state: "draft" | "approved" | "edited_lapsed" | "stale" | "withdrawn";
  description: string;
  client_name: string;
  deal_name: string;
  vendor_ref: string;
  identity_restricted: boolean;
};
export type Fields = Pick<
  Need,
  "description" | "applicability" | "source_ref" | "source_revision" | "observed_at" | "fresh_until" | "restriction"
> & { vendor: string; withdrawn: boolean };
type Context = { deal: string; client: string };
type Page = {
  schema_version: "client-needs.v1";
  subject: "deal" | "vendor";
  subject_id: string;
  as_of: string;
  state: "ready" | "empty" | "missing_approval";
  rows: Need[];
  next_offset: number | null;
};
type Request = { verb: string; args: Record<string, unknown> };
export type Screen =
  | { kind: "listing" | "loading" | "unavailable" | "conflict" | "retired" }
  | { kind: "editing"; need: Need | null }
  | { kind: "reviewing"; need: Need }
  | { kind: "pending" | "unknown"; operation: Request };
// JSON imports widen schema literals; the validator checks the pinned producer schema at runtime.
const validator = new Validator(schema as Schema);
function valid(value: unknown): value is Page {
  return validator.validate(value).valid;
}
export function parseNeeds(value: unknown, context: Context & { offset: number }): Page {
  if (
    !valid(value) ||
    value.subject !== "deal" ||
    value.subject_id !== context.deal ||
    value.rows.some((n) => n.deal_id !== context.deal || n.client_id !== context.client) ||
    new Set(value.rows.map((n) => n.id)).size !== value.rows.length ||
    (value.next_offset !== null && value.next_offset <= context.offset)
  )
    throw Error("Client needs response unavailable");
  return value;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
export function parseVendorNeeds(value: unknown, vendor: string, offset = 0, now = Date.now()): Page {
  if (
    !valid(value) ||
    value.subject !== "vendor" ||
    value.subject_id !== vendor ||
    (value.next_offset !== null && value.next_offset <= offset) ||
    value.rows.some(
      (n) =>
        n.vendor_id !== vendor ||
        n.state !== "approved" ||
        n.restriction !== "allowed" ||
        n.identity_restricted ||
        n.approved_revision !== n.revision ||
        Date.parse(n.fresh_until) <= now ||
        Date.parse(n.observed_at) > now,
    )
  )
    throw Error("Invalid vendor matches");
  return value;
}
export function parseNeed(value: unknown, context: Context): Need {
  const page = parseNeeds(
    {
      schema_version: "client-needs.v1",
      subject: "deal",
      subject_id: context.deal,
      as_of: new Date().toISOString(),
      state: "ready",
      rows: [value],
      next_offset: null,
    },
    { ...context, offset: 0 },
  );
  const need = page.rows[0];
  if (!need) throw Error("Need missing");
  return need;
}
export function fieldsOf(n: Need): Fields {
  return {
    vendor: n.vendor_id,
    description: n.description,
    applicability: n.applicability,
    source_ref: n.source_ref,
    source_revision: n.source_revision,
    observed_at: n.observed_at,
    fresh_until: n.fresh_until,
    restriction: n.restriction,
    withdrawn: n.state === "withdrawn",
  };
}
export function approvable(n: Need, now = Date.now()) {
  return (
    !n.identity_restricted &&
    n.restriction === "allowed" &&
    n.state !== "withdrawn" &&
    Date.parse(n.observed_at) <= now &&
    Date.parse(n.fresh_until) > now
  );
}
export function createNeedAuthor(
  options: Context & { call: (verb: string, args: Record<string, unknown>) => Promise<unknown>; changed: () => void },
) {
  let state: Screen = { kind: "listing" },
    rows: Need[] = [],
    next: number | null = null,
    generation = 0;
  const set = (s: Screen) => {
    state = s;
    options.changed();
  };
  const idle = () => state.kind === "listing";
  async function load(more = false) {
    if (!["listing", "conflict", "unavailable"].includes(state.kind)) return;
    const offset = more ? next : 0;
    if (offset === null) return;
    const seq = ++generation;
    set({ kind: "loading" });
    try {
      const page = parseNeeds(
        await options.call("read-deal-client-needs-v1", { deal: options.deal, offset, limit: 50 }),
        { ...options, offset },
      );
      if (seq !== generation) return;
      rows = more ? [...rows, ...page.rows] : page.rows;
      next = page.next_offset;
      set({ kind: "listing" });
    } catch {
      if (seq === generation) {
        rows = [];
        set({ kind: "unavailable" });
      }
    }
  }
  async function send(operation: Request) {
    const seq = ++generation;
    set({ kind: "pending", operation });
    try {
      const value = await options.call(operation.verb, operation.args);
      if (seq !== generation) return;
      if (object(value) && typeof value.error === "string") {
        set({ kind: "conflict" });
        return;
      }
      if (!object(value) || value.schema_version !== "client-needs.v1") throw Error("Unconfirmed");
      const n = parseNeed(value.need, options);
      if (operation.args.need !== undefined && n.id !== operation.args.need) throw Error("Wrong need");
      rows = [n, ...rows.filter((row) => row.id !== n.id)];
      set({ kind: "listing" });
    } catch {
      if (seq === generation) set({ kind: "unknown", operation });
    }
  }
  const request = (verb: string, args: Record<string, unknown>) =>
    send({ verb, args: { ...args, deal: options.deal, client: options.client, idempotency_key: crypto.randomUUID() } });
  return {
    get state() {
      return state;
    },
    get rows() {
      return rows;
    },
    get next() {
      return next;
    },
    load,
    edit(id?: string) {
      if (idle()) set({ kind: "editing", need: rows.find((n) => n.id === id) ?? null });
    },
    review(id: string) {
      const n = rows.find((n) => n.id === id);
      if (idle() && n && approvable(n)) set({ kind: "reviewing", need: structuredClone(n) });
    },
    cancel() {
      if (state.kind === "editing" || state.kind === "reviewing") set({ kind: "listing" });
    },
    async save(fields: Fields) {
      if (state.kind !== "editing") return;
      const n = state.need;
      if (
        !fields.description.trim() ||
        !fields.applicability.trim() ||
        !fields.source_ref.trim() ||
        !fields.source_revision.trim() ||
        !Number.isFinite(Date.parse(fields.observed_at)) ||
        !Number.isFinite(Date.parse(fields.fresh_until)) ||
        Date.parse(fields.fresh_until) <= Date.parse(fields.observed_at)
      )
        return;
      await request("record-deal-client-need-v1", { fields, ...(n ? { need: n.id, base_version: n.version } : {}) });
    },
    async approve() {
      if (state.kind !== "reviewing" || !approvable(state.need)) return;
      await request("approve-deal-client-need-v1", { need: state.need.id, base_version: state.need.version });
    },
    async withdraw(id: string) {
      const n = rows.find((n) => n.id === id);
      if (idle() && n)
        await request("record-deal-client-need-v1", {
          need: id,
          base_version: n.version,
          fields: { ...fieldsOf(n), withdrawn: true },
        });
    },
    async check() {
      if (state.kind === "unknown") await send(state.operation);
    },
    retire() {
      ++generation;
      rows = [];
      set({ kind: "retired" });
    },
  };
}
