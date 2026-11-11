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
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const nullableBoolean = (value: unknown): value is boolean | null => value === null || typeof value === "boolean";
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function strings(value: unknown, max: number, valid: (item: string) => boolean): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    new Set(value).size === value.length &&
    Array.from(value).every((item) => typeof item === "string" && valid(item))
  );
}
function criteria(value: unknown): value is Criteria {
  return (
    record(value) &&
    exact(value, [
      "query",
      "counties",
      "property_types",
      "min_square_feet",
      "max_square_feet",
      "availability",
      "entrance_verified",
      "public_projection_ready",
      "photos_available",
      "sort",
      "cursor",
      "limit",
    ]) &&
    nullableString(value.query) &&
    (value.query === null || Array.from(value.query).length <= 200) &&
    strings(value.counties, 5, (item) => ["Escambia", "Santa Rosa", "Okaloosa", "Walton", "Bay"].includes(item)) &&
    strings(value.property_types, 12, (item) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(item)) &&
    (value.min_square_feet === null || integer(value.min_square_feet, 0, 100000000)) &&
    (value.max_square_feet === null || integer(value.max_square_feet, 0, 100000000)) &&
    strings(value.availability, 4, (item) =>
      ["available", "coming_soon", "under_contract", "unknown"].includes(item),
    ) &&
    nullableBoolean(value.entrance_verified) &&
    nullableBoolean(value.public_projection_ready) &&
    nullableBoolean(value.photos_available) &&
    typeof value.sort === "string" &&
    ["updated_desc", "address_asc", "size_asc", "size_desc"].includes(value.sort) &&
    nullableString(value.cursor) &&
    (value.cursor === null || /^[0-9]{1,9}$/.test(value.cursor)) &&
    integer(value.limit, 1, 100)
  );
}
function prefill(value: unknown): value is Draft["client_prefill_source"] {
  return (
    value === null ||
    (record(value) &&
      exact(value, ["client_id", "source_ref", "observed_at"]) &&
      uuid(value.client_id) &&
      typeof value.source_ref === "string" &&
      Array.from(value.source_ref).length >= 1 &&
      Array.from(value.source_ref).length <= 500 &&
      date(value.observed_at))
  );
}
function search(value: unknown): value is Search {
  return (
    record(value) &&
    exact(value, [
      "id",
      "deal_id",
      "version",
      "name",
      "status",
      "state",
      "criteria",
      "requirements",
      "client_prefill_source",
      "last_run_at",
      "run_criteria",
      "result_property_ids",
      "has_more",
      "next_cursor",
      "updated_at",
    ]) &&
    uuid(value.id) &&
    uuid(value.deal_id) &&
    integer(value.version, 1, Infinity) &&
    typeof value.name === "string" &&
    (value.status === "draft" || value.status === "saved" || value.status === "archived") &&
    (value.state === "draft" || value.state === "saved" || value.state === "stale" || value.state === "archived") &&
    criteria(value.criteria) &&
    typeof value.requirements === "string" &&
    prefill(value.client_prefill_source) &&
    (value.last_run_at === null || date(value.last_run_at)) &&
    (value.run_criteria === null || criteria(value.run_criteria)) &&
    strings(value.result_property_ids, 100, uuid) &&
    typeof value.has_more === "boolean" &&
    nullableString(value.next_cursor) &&
    date(value.updated_at)
  );
}
export function parseSearchResponse(value: unknown, dealId: string, multiple = false): Search[] {
  if (!record(value) || value.ok !== true || value.schema_version !== "deal-space-searches.v1")
    throw Error("Invalid saved search response");
  let rows: Search[];
  if (multiple) {
    if (
      !exact(value, ["ok", "schema_version", "searches", "truncated"]) ||
      typeof value.truncated !== "boolean" ||
      !Array.isArray(value.searches) ||
      value.searches.length > 100 ||
      !Array.from(value.searches).every(search)
    )
      throw Error("Invalid saved search response");
    rows = value.searches;
  } else {
    if (
      !exact(value, ["ok", "schema_version", "search"], ["replayed"]) ||
      (Object.hasOwn(value, "replayed") && typeof value.replayed !== "boolean") ||
      !search(value.search)
    )
      throw Error("Invalid saved search response");
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
type SourceField = "name" | "requirements";
type ClientSource = {
  client_id: string;
  source_ref: string;
  observed_at: string;
  name: string;
  requirements: string;
  location: string;
  use: string;
};
type SourceReview =
  | { kind: "idle" | "reading" | "failed" | "changed" }
  | { kind: "review"; source: ClientSource; choices: Partial<Record<SourceField, "keep" | "use">> }
  | { kind: "applied" };
export class SavedSearches {
  sourceReview: SourceReview = { kind: "idle" };
  private sourceEpoch = 0;
  phase: Phase = "idle";
  rows: Search[] = [];
  current: Search | null = null;
  draft: Draft | null = null;
  selected = new Set<string>();
  newIds = new Set<string>();
  message = "";
  private alive = true;
  private operation: "read" | "write" | null = null;
  private searchId = "";
  private pending: { verb: string; args: Record<string, unknown> } | null = null;
  readonly dealId: string;
  private call: SearchCall;
  private changed: () => void;
  private readClient: ((id: string) => Promise<unknown>) | undefined;
  constructor(dealId: string, call: SearchCall, changed: () => void, readClient?: (id: string) => Promise<unknown>) {
    this.readClient = readClient;
    this.dealId = dealId;
    this.call = call;
    this.changed = changed;
  }
  private async exactClient() {
    const value = await this.call("get-deal-room", { deal: this.dealId });
    if (!record(value) || value.deal_id !== this.dealId || !uuid(value.client_id))
      throw Error("Deal client unavailable");
    return value.client_id;
  }
  async reviewClient() {
    if (!this.alive || this.working || this.sourceReview.kind === "reading" || !this.draft || !this.readClient) return;
    const epoch = ++this.sourceEpoch;
    this.sourceReview = { kind: "reading" };
    this.publish();
    try {
      const clientId = await this.exactClient();
      if (!this.alive || epoch !== this.sourceEpoch) return;
      const value = await this.readClient(clientId);
      if (
        !record(value) ||
        value.id !== clientId ||
        typeof value.name !== "string" ||
        !["city", "state", "vertical", "specialty", "notes"].every(
          (key) => value[key] == null || typeof value[key] === "string",
        )
      )
        throw Error("Invalid client record");
      const binding = await this.exactClient();
      if (!this.alive || epoch !== this.sourceEpoch) return;
      if (binding !== clientId) {
        this.sourceReview = { kind: "changed" };
        return;
      }
      this.sourceReview = {
        kind: "review",
        choices: {},
        source: {
          client_id: clientId,
          source_ref: `/api/v1/business/clients/${clientId}`,
          observed_at: new Date().toISOString(),
          name: `${value.name} space search`,
          requirements: typeof value.notes === "string" ? value.notes : "",
          location: [value.city, value.state].filter(Boolean).join(", "),
          use: String(value.vertical || value.specialty || ""),
        },
      };
    } catch {
      if (this.alive && epoch === this.sourceEpoch) this.sourceReview = { kind: "failed" };
    } finally {
      this.publish();
    }
  }
  chooseSource(field: SourceField, choice: "keep" | "use") {
    if (!this.alive || this.working || this.sourceReview.kind !== "review") return;
    this.sourceReview.choices[field] = choice;
    this.publish();
  }
  async applySource() {
    const review = this.sourceReview;
    if (
      !this.alive ||
      this.working ||
      !this.draft ||
      review.kind !== "review" ||
      !review.choices.name ||
      !review.choices.requirements
    )
      return;
    const epoch = ++this.sourceEpoch;
    this.sourceReview = { kind: "reading" };
    this.publish();
    try {
      const clientId = await this.exactClient();
      if (!this.alive || epoch !== this.sourceEpoch || !this.draft) return;
      if (clientId !== review.source.client_id) {
        this.sourceReview = { kind: "changed" };
        return;
      }
      const used = review.choices.name === "use" || review.choices.requirements === "use";
      this.update({
        ...this.draft,
        name: review.choices.name === "use" ? review.source.name : this.draft.name,
        requirements: review.choices.requirements === "use" ? review.source.requirements : this.draft.requirements,
        client_prefill_source: used
          ? {
              client_id: clientId,
              source_ref: review.source.source_ref,
              observed_at: review.source.observed_at,
            }
          : this.draft.client_prefill_source,
      });
      this.sourceReview = { kind: "applied" };
    } catch {
      if (this.alive && epoch === this.sourceEpoch) this.sourceReview = { kind: "failed" };
    } finally {
      this.publish();
    }
  }
  get dirty() {
    return (
      this.draft !== null &&
      (!this.current || JSON.stringify(this.draft) !== JSON.stringify(this.toDraft(this.current)))
    );
  }
  get working() {
    return this.operation !== null;
  }
  get blocksDeparture() {
    return this.dirty || this.operation === "write";
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
    ++this.sourceEpoch;
    this.sourceReview = { kind: "idle" };
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
    if (!this.alive || this.working) return;
    this.operation = "read";
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
      this.operation = null;
      this.publish();
    }
  }
  edit(row?: Search) {
    if (!this.alive || this.working || this.dirty) return;
    ++this.sourceEpoch;
    this.sourceReview = { kind: "idle" };
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
    if (!this.alive || this.working) return;
    ++this.sourceEpoch;
    if (this.sourceReview.kind === "reading") this.sourceReview = { kind: "idle" };
    if (this.sourceReview.kind === "review" && this.draft) {
      for (const field of ["name", "requirements"] as const)
        if (draft[field] !== this.draft[field]) delete this.sourceReview.choices[field];
    }
    this.draft = draft;
    this.phase = "editing";
    this.pending = null;
    this.publish();
  }
  cancel() {
    if (!this.alive || this.working) return;
    ++this.sourceEpoch;
    this.sourceReview = { kind: "idle" };
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
  age() {
    if (!this.alive || this.working || !this.stale()) return;
    if (["results-current", "handed-to-cart", "restored", "run-failed", "saved"].includes(this.phase)) {
      this.phase = "results-stale";
      this.publish();
    }
  }
  async write(action: "save" | "run" | "archive" | "restore") {
    if (!this.alive || this.working || !this.draft || (action !== "save" && !this.current)) return;
    if (action === "run" && (this.dirty || this.current?.status !== "saved")) return;
    ++this.sourceEpoch;
    this.sourceReview = { kind: "idle" };
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
    this.operation = "write";
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
      this.operation = null;
      this.publish();
    }
  }
  toggle(id: string) {
    if (!this.alive || this.working || !this.current?.result_property_ids.includes(id)) return;
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.publish();
  }
  handoff(accept: (ids: string[]) => boolean) {
    if (!this.alive || this.working || this.stale() || this.current?.status !== "saved" || !this.selected.size) return;
    if (accept([...this.selected])) {
      this.phase = "handed-to-cart";
      this.message = "Added to the Tour cart draft. Save selection in the Tour cart to keep these properties.";
      this.publish();
    }
  }
}
