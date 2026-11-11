import { Ajv } from "ajv";
import { searchResponseContract as schema } from "./deal-space-search-contract.ts";

export type Criteria = {
  query: string | null;
  counties: string[];
  property_types: string[];
  min_square_feet: number | null;
  max_square_feet: number | null;
  availability: string[];
  entrance_verified: boolean | null;
  public_projection_ready: boolean | null;
  photos_available: boolean | null;
  sort: string;
  cursor: string | null;
  limit: number;
};
export type Draft = {
  name: string;
  criteria: Criteria;
  requirements: string;
  client_prefill_source: { client_id: string; source_ref: string; observed_at: string } | null;
};
export type Search = Draft & {
  id: string;
  deal_id: string;
  version: number;
  status: "draft" | "saved" | "archived";
  state: "draft" | "saved" | "stale" | "archived";
  last_run_at: string | null;
  run_criteria: Criteria | null;
  result_property_ids: string[];
  has_more: boolean;
  next_cursor: string | null;
  updated_at: string;
};
const validator = new Ajv({
  strict: false,
  formats: {
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "date-time": (value: string) => Number.isFinite(Date.parse(value)),
  },
});
const one = validator.compile<{ search: Search }>(schema.one);
const list = validator.compile<{ searches: Search[]; truncated: boolean }>(schema.list);
export function parseSearchResponse(value: unknown, dealId: string, multiple = false): Search[] {
  let rows: Search[];
  if (multiple) {
    if (!list(value)) throw Error("Invalid saved search response");
    rows = value.searches;
  } else {
    if (!one(value)) throw Error("Invalid saved search response");
    rows = [value.search];
  }
  if (rows.some((row) => row.deal_id !== dealId)) throw Error("Saved search deal mismatch");
  return rows;
}
export type Phase =
  | "idle"
  | "editing"
  | "saving"
  | "saved"
  | "version-conflict"
  | "running"
  | "results-current"
  | "results-stale"
  | "archived"
  | "restored"
  | "run-failed"
  | "handed-to-cart"
  | "retired";
export type SearchCall = (verb: string, args: Record<string, unknown>) => Promise<unknown>;
export class SavedSearches {
  phase: Phase = "idle";
  rows: Search[] = [];
  current: Search | null = null;
  draft: Draft | null = null;
  selected = new Set<string>();
  newIds = new Set<string>();
  message = "";
  private alive = true;
  private busy = false;
  private searchId = "";
  private pending: { verb: string; args: Record<string, unknown> } | null = null;
  readonly dealId: string;
  private call: SearchCall;
  private changed: () => void;
  constructor(dealId: string, call: SearchCall, changed: () => void) {
    this.dealId = dealId;
    this.call = call;
    this.changed = changed;
  }
  get dirty() {
    return (
      this.draft !== null &&
      (!this.current || JSON.stringify(this.draft) !== JSON.stringify(this.toDraft(this.current)))
    );
  }
  get working() {
    return this.busy;
  }
  private toDraft(row: Search): Draft {
    return structuredClone({
      name: row.name,
      criteria: row.criteria,
      requirements: row.requirements,
      client_prefill_source: row.client_prefill_source,
    });
  }
  private publish() {
    if (this.alive) this.changed();
  }
  retire() {
    this.alive = false;
    this.phase = "retired";
    this.rows = [];
    this.current = null;
    this.draft = null;
    this.selected.clear();
    this.newIds.clear();
    this.pending = null;
    this.message = "Session changed. Reload this deal to continue.";
    this.changed();
  }
  async load() {
    if (!this.alive || this.busy) return;
    this.busy = true;
    this.message = "Loading saved searches…";
    this.publish();
    try {
      const value = await this.call("read-deal-space-searches-v1", { deal_id: this.dealId, search_id: null });
      if (!this.alive) return;
      this.rows = parseSearchResponse(value, this.dealId, true);
      this.message = this.rows.length === 100 ? "Showing up to 100 saved searches." : "";
    } catch {
      if (this.alive) this.message = "Saved searches unavailable. Retry loading.";
    } finally {
      this.busy = false;
      this.publish();
    }
  }
  edit(row?: Search) {
    if (!this.alive || this.busy || this.dirty) return;
    this.current = row ?? null;
    this.searchId = row?.id ?? crypto.randomUUID();
    this.draft = row
      ? this.toDraft(row)
      : {
          name: "",
          requirements: "",
          client_prefill_source: null,
          criteria: {
            query: null,
            counties: [],
            property_types: [],
            min_square_feet: null,
            max_square_feet: null,
            availability: [],
            entrance_verified: null,
            public_projection_ready: null,
            photos_available: null,
            sort: "updated_desc",
            cursor: null,
            limit: 100,
          },
        };
    this.phase = row ? this.resultPhase(row) : "editing";
    this.selected.clear();
    this.newIds.clear();
    this.pending = null;
    this.message = "";
    this.publish();
  }
  update(draft: Draft) {
    if (!this.alive || this.busy) return;
    this.draft = draft;
    this.phase = "editing";
    this.pending = null;
    this.publish();
  }
  cancel() {
    if (!this.alive || this.busy) return;
    this.current = null;
    this.draft = null;
    this.pending = null;
    this.selected.clear();
    this.phase = "idle";
    this.message = "";
    this.publish();
  }
  private resultPhase(row: Search): Phase {
    if (row.status === "archived") return "archived";
    if (!row.last_run_at) return "saved";
    return row.state === "stale" || Date.now() - Date.parse(row.last_run_at) >= 86400000
      ? "results-stale"
      : "results-current";
  }
  stale() {
    return this.current ? this.resultPhase(this.current) === "results-stale" || this.dirty : false;
  }
  async write(action: "save" | "run" | "archive" | "restore") {
    if (!this.alive || this.busy || !this.draft || (action !== "save" && !this.current)) return;
    if (action === "run" && (this.dirty || this.current?.status !== "saved")) return;
    const criteria = this.draft.criteria;
    if (
      !this.draft.name.trim() ||
      (criteria.min_square_feet !== null &&
        criteria.max_square_feet !== null &&
        criteria.min_square_feet > criteria.max_square_feet)
    ) {
      this.message = "Name this search and check the size range.";
      this.publish();
      return;
    }
    const verb = action === "run" ? "run-deal-space-search-v1" : "save-deal-space-search-v1";
    const args = {
      deal_id: this.dealId,
      search_id: this.searchId,
      expected_version: this.current?.version ?? 0,
      ...(action === "run"
        ? {}
        : {
            ...this.draft,
            criteria: {
              ...criteria,
              property_types: criteria.property_types
                .map((value) => value.trim().toLowerCase().replaceAll(" ", "_"))
                .filter(Boolean),
            },
            status: action === "archive" ? "archived" : "saved",
          }),
    };
    const signature = JSON.stringify(args);
    if (
      !this.pending ||
      this.pending.verb !== verb ||
      JSON.stringify({ ...this.pending.args, idempotency_key: undefined }) !== signature
    )
      this.pending = { verb, args: { ...args, idempotency_key: crypto.randomUUID() } };
    const pending = this.pending;
    const previous = this.current;
    this.busy = true;
    this.phase = action === "run" ? "running" : "saving";
    this.message = action === "run" ? "Rerunning saved criteria…" : "Saving search…";
    this.publish();
    try {
      const response = await this.call(verb, pending.args);
      if (!this.alive) return;
      const row = parseSearchResponse(response, this.dealId)[0];
      if (!row || row.id !== this.searchId) throw Error("Saved search identity mismatch");
      this.current = row;
      this.draft = this.toDraft(row);
      this.pending = null;
      this.rows = [row, ...this.rows.filter((item) => item.id !== row.id)];
      this.selected.clear();
      if (action === "run")
        this.newIds = new Set(
          previous?.last_run_at
            ? row.result_property_ids.filter((id) => !previous.result_property_ids.includes(id))
            : [],
        );
      this.phase = action === "restore" ? "restored" : this.resultPhase(row);
      this.message =
        action === "run"
          ? "Results saved. Review candidates before adding them to a Tour."
          : action === "restore"
            ? "Search restored."
            : "Search saved.";
    } catch (error) {
      if (!this.alive) return;
      if (error instanceof Error && /version_conflict|space_search_conflict/.test(error.message)) {
        this.phase = "version-conflict";
        this.pending = null;
        try {
          const response = await this.call("read-deal-space-searches-v1", {
            deal_id: this.dealId,
            search_id: this.searchId,
          });
          if (!this.alive) return;
          const row = parseSearchResponse(response, this.dealId, true).find((item) => item.id === this.searchId);
          if (!row) throw Error("Search unavailable");
          this.current = row;
          this.rows = [row, ...this.rows.filter((item) => item.id !== row.id)];
          this.message = "A newer saved version is shown below. Your draft is retained. Review it before saving again.";
        } catch {
          this.message = "Newer version unavailable. Cancel and reopen before saving.";
        }
      } else {
        this.phase = action === "run" ? "run-failed" : "editing";
        this.message =
          action === "run"
            ? "Run failed or unconfirmed. Previous results remain. Retry uses the same request."
            : "Save unconfirmed. Your draft remains. Retry uses the same request.";
      }
    } finally {
      this.busy = false;
      this.publish();
    }
  }
  toggle(id: string) {
    if (!this.alive || this.busy || !this.current?.result_property_ids.includes(id)) return;
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.publish();
  }
  handoff(accept: (ids: string[]) => boolean) {
    if (!this.alive || this.busy || this.stale() || this.current?.status !== "saved" || !this.selected.size) return;
    if (accept([...this.selected])) {
      this.phase = "handed-to-cart";
      this.message = "Added to the Tour cart draft. Save selection in the Tour cart to keep these properties.";
      this.publish();
    }
  }
}
