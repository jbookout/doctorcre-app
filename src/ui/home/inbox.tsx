import { type BatchRequest, type BatchResult, parseBatch } from "./batch.ts";
import { parseReference, parseReview, type ReviewReference, type ReviewRequest } from "./review.ts";
import { completeAction, parseActionReceipt, type TaskReceipt } from "./task-done.ts";

type WaitingIdentity = Readonly<{
  kind: "party" | "actor";
  id: string;
  available: boolean;
  display_name: string | null;
}>;
type Waiting = Readonly<{ identity: WaitingIdentity; reason: string; evidence: string[]; version: number }>;
type WaitingArgs = Readonly<{
  idempotency_key: string;
  item_id: string;
  item_version: string;
  base_version: number;
  reason: string;
  evidence: string[];
}>;
export type WaitingCommand =
  | Readonly<{ action: "set"; args: WaitingArgs & { target: Pick<WaitingIdentity, "kind" | "id"> } }>
  | Readonly<{ action: "clear"; args: WaitingArgs }>;
type BaseItem = Readonly<{
  item_id: string;
  source_type: string;
  source_id: string;
  source_version: string;
  source_state: "working" | "needs_attention" | "done" | "failed";
  title: string;
  activity_at: string;
  hold_until: string | null;
  unseen: boolean;
  disposition: "inbox" | "snoozed" | "settled";
  snoozed_until: string | null;
  explicit_unsettle: boolean;
  section: "inbox" | "working" | "held" | "done" | "snoozed" | "settled";
  base_version: string;
}>;
export type InboxItem = BaseItem &
  Readonly<{
    waiting_version?: number;
    waiting_on?: Waiting | null;
    completed_at: string | null;
    auto_settled: boolean;
    context_label: string | null;
    due_on: string | null;
    open_url: string | null;
    kind_label: "Task" | "Call follow-up" | "Call" | "Reply draft" | "Update" | "Fact review" | "Tour feedback";
    merged_source_ids: string[];
    review_reference?: ReviewReference | null;
  }> &
  (
    | Readonly<{
        source_type: "next_action" | "capture_post_call_action";
        action_id: string;
        action_version: number;
        deal_id: string | null;
      }>
    | Readonly<{
        source_type: "capture_session" | "email_proposal" | "notification" | "fact_review" | "tour_feedback";
        action_id: null;
        action_version: null;
        deal_id: string | null;
      }>
  );
export type Snapshot = Readonly<{
  ok: true;
  truncated: boolean;
  limit: 1000;
  items: InboxItem[];
  working_collapsed: true;
}> &
  (
    | Readonly<{ schema_version: "home-inbox.v2"; auto_settle_enabled: false }>
    | Readonly<{ schema_version: "home-inbox.v3" | "home-inbox.v4" | "home-inbox.v5"; auto_settle_enabled: true }>
  );
export type Action = "snooze" | "settle" | "unsettle";
type CommandArgs = Readonly<{
  idempotency_key: string;
  items: ReadonlyArray<Pick<InboxItem, "item_id" | "base_version">>;
}>;
type DispositionCommand =
  | Readonly<{ action: "snooze"; args: CommandArgs & Readonly<{ until: string }> }>
  | Readonly<{ action: "settle" | "unsettle"; args: CommandArgs }>;

export type { TaskReceipt } from "./task-done.ts";

type TaskCommand = Readonly<{
  action: "complete" | "reopen";
  args: CommandArgs & { action_id: string; base_version: number; completion_event_id?: string };
}>;
export type Command = DispositionCommand | TaskCommand;
export function taskCommand(action: "complete" | "reopen", item: InboxItem, receipt?: TaskReceipt): TaskCommand {
  if (!item.action_id || !item.action_version || (action === "complete" && item.source_state !== "needs_attention"))
    throw Error("This card cannot be marked done.");
  if (
    action === "reopen" &&
    (!receipt?.completion_event_id || receipt.action_id !== item.action_id || receipt.status !== "done")
  )
    throw Error("Can't undo this completion. Its original receipt has no completion event.");
  return {
    action,
    args: {
      idempotency_key: crypto.randomUUID(),
      items: [{ item_id: item.item_id, base_version: item.base_version }],
      action_id: item.action_id,
      base_version: action === "reopen" && receipt ? receipt.version : item.action_version,
      ...(action === "reopen" && receipt?.completion_event_id
        ? { completion_event_id: receipt.completion_event_id }
        : {}),
    },
  };
}

export type ItemResult =
  | { item_id: string; ok: true; item: InboxItem; receipt?: TaskReceipt }
  | { item_id: string; ok: false; error: string; current_version?: string; current_item?: InboxItem };
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const timestamp = (value: unknown) => text(value) && Number.isFinite(Date.parse(value));
export function waitingLabel(
  item: Pick<InboxItem, "waiting_version" | "waiting_on" | "section" | "source_state">,
): string | null {
  if (item.waiting_version === undefined || ["done", "settled"].includes(item.section) || item.source_state === "done")
    return null;
  if (!item.waiting_on && (item.section !== "inbox" || item.source_state === "working")) return null;
  return item.waiting_on
    ? item.waiting_on.identity.available
      ? `Waiting on ${item.waiting_on.identity.display_name}`
      : "Waiting on someone · Identity unavailable"
    : "Waiting on someone · Not recorded";
}
function parseWaiting(value: unknown, version: number): Waiting | null {
  if (value === null) return null;
  if (
    !object(value) ||
    !object(value.identity) ||
    !["party", "actor"].includes(String(value.identity.kind)) ||
    !uuid(value.identity.id) ||
    typeof value.identity.available !== "boolean" ||
    (value.identity.available ? !text(value.identity.display_name) : value.identity.display_name !== null) ||
    !text(value.reason) ||
    !Array.isArray(value.evidence) ||
    !value.evidence.length ||
    value.evidence.length > 20 ||
    !value.evidence.every(text) ||
    value.version !== version
  )
    throw Error("Waiting identity unavailable. Refresh to try again.");
  // The checks above validate every Waiting field, including its identity discriminant.
  return value as Waiting;
}
function parseBaseItem(value: unknown): BaseItem {
  if (
    !object(value) ||
    !["item_id", "source_type", "source_id", "source_version", "title", "section", "base_version"].every((key) =>
      text(value[key]),
    ) ||
    !(
      typeof value.source_state === "string" &&
      ["working", "needs_attention", "done", "failed"].includes(value.source_state)
    ) ||
    !(typeof value.disposition === "string" && ["inbox", "snoozed", "settled"].includes(value.disposition)) ||
    !(
      typeof value.section === "string" &&
      ["inbox", "working", "held", "done", "snoozed", "settled"].includes(value.section)
    ) ||
    !timestamp(value.activity_at) ||
    !(value.hold_until === null || timestamp(value.hold_until)) ||
    !(value.snoozed_until === null || timestamp(value.snoozed_until)) ||
    typeof value.unseen !== "boolean" ||
    typeof value.explicit_unsettle !== "boolean"
  )
    throw Error("Inbox returned an unreadable item. Refresh to try again.");
  // The checks above validate all base fields and their allowed string values.
  return value as BaseItem;
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const day = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
export function parseItem(value: unknown, v3 = false, v4 = false): InboxItem {
  const legacy = parseBaseItem(value);
  if (
    !object(value) ||
    !(value.context_label === null || text(value.context_label)) ||
    !(value.due_on === null || day(value.due_on)) ||
    !(value.open_url === null || text(value.open_url)) ||
    !(
      typeof value.kind_label === "string" &&
      [
        "Task",
        "Call follow-up",
        "Call",
        "Reply draft",
        "Update",
        ...(v3 ? ["Fact review", "Tour feedback"] : []),
      ].includes(value.kind_label)
    ) ||
    !Array.isArray(value.merged_source_ids) ||
    !value.merged_source_ids.every(uuid) ||
    !(value.deal_id === null || uuid(value.deal_id)) ||
    (["capture_session", "email_proposal"].includes(legacy.source_type) && value.deal_id !== null)
  )
    throw Error("Inbox returned unreadable card context. Refresh to try again.");
  const task = legacy.source_type === "next_action" || legacy.source_type === "capture_post_call_action";
  if (
    task
      ? !uuid(value.action_id) ||
        !Number.isSafeInteger(value.action_version) ||
        typeof value.action_version !== "number" ||
        value.action_version < 1 ||
        value.action_version > 2147483647
      : ![
          "capture_session",
          "email_proposal",
          "notification",
          ...(v3 ? ["fact_review", "tour_feedback"] : []),
        ].includes(legacy.source_type) ||
        value.action_id !== null ||
        value.action_version !== null
  )
    throw Error("Inbox returned unreadable completion identity. Refresh to try again.");
  if (
    v3 &&
    (typeof value.auto_settled !== "boolean" ||
      (value.auto_settled &&
        (legacy.section !== "settled" ||
          legacy.disposition !== "settled" ||
          legacy.source_state !== "done" ||
          legacy.explicit_unsettle ||
          !["next_action", "capture_post_call_action", "email_proposal", "fact_review", "tour_feedback"].includes(
            legacy.source_type,
          ))))
  )
    throw Error("Inbox returned unreadable settlement context. Refresh to try again.");
  if (
    (v4 &&
      !(
        value.completed_at === null ||
        (typeof value.completed_at === "string" &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value.completed_at) &&
          timestamp(value.completed_at) &&
          new Date(value.completed_at).toISOString().slice(0, 19) === value.completed_at.slice(0, 19))
      )) ||
    (v4 && legacy.source_state !== "done" && value.completed_at !== null)
  )
    throw Error("Inbox returned unreadable completion time. Refresh to try again.");
  const reference = v3 ? parseReference(value.review_reference) : null;
  // Version-specific checks above validate the item before normalized optional fields are added.
  return {
    ...value,
    ...(value.review_reference === undefined
      ? {}
      : {
          review_reference:
            reference && reference.item_id === legacy.item_id && reference.source_version === legacy.source_version
              ? reference
              : null,
        }),
    completed_at: v4 ? value.completed_at : null,
    auto_settled: v3 ? value.auto_settled : false,
  } as InboxItem;
}
const inboxVersions = [
  { version: "v5", schema: "home-inbox.v5", settlement: true, completion: true, waiting: true },
  { version: "v4", schema: "home-inbox.v4", settlement: true, completion: true, waiting: false },
  { version: "v3", schema: "home-inbox.v3", settlement: true, completion: false, waiting: false },
  { version: "v2", schema: "home-inbox.v2", settlement: false, completion: false, waiting: false },
] as const;
export function parseSnapshot(value: unknown): Snapshot {
  const contract = object(value) ? inboxVersions.find((entry) => entry.schema === value.schema_version) : undefined;
  if (
    !contract ||
    !object(value) ||
    value.ok !== true ||
    !Array.isArray(value.items) ||
    value.items.length > 1000 ||
    typeof value.truncated !== "boolean" ||
    value.limit !== 1000 ||
    value.working_collapsed !== true ||
    value.auto_settle_enabled !== contract.settlement
  )
    throw Error("Inbox unavailable. The server could not provide the complete inbox.");
  const items = value.items.map((item) => {
    const parsed = parseItem(item, contract.settlement, contract.completion);
    if (!contract.waiting) {
      const { waiting_version, waiting_on, ...legacy } = parsed;
      return legacy;
    }
    if (
      !object(item) ||
      typeof item.waiting_version !== "number" ||
      !Number.isSafeInteger(item.waiting_version) ||
      item.waiting_version < 0
    )
      throw Error("Waiting version unavailable.");
    return {
      ...parsed,
      waiting_version: item.waiting_version,
      waiting_on: parseWaiting(item.waiting_on, item.waiting_version),
    };
  });
  if (new Set(items.map((item) => item.item_id)).size !== items.length)
    throw Error("Inbox returned duplicate items. Refresh to try again.");
  const shared = { ok: true, truncated: value.truncated, limit: 1000, items, working_collapsed: true } as const;
  return contract.settlement
    ? { ...shared, schema_version: contract.schema, auto_settle_enabled: true }
    : { ...shared, schema_version: "home-inbox.v2", auto_settle_enabled: false };
}
export function shelves(items: readonly InboxItem[], currentId?: string) {
  const result: {
    inbox: InboxItem[];
    working: InboxItem[];
    held: InboxItem[];
    done: InboxItem[];
    snoozed: InboxItem[];
    settled: InboxItem[];
    current: InboxItem | undefined;
  } = { inbox: [], working: [], held: [], done: [], snoozed: [], settled: [], current: undefined };
  for (const item of [...items].sort(
    (a, b) => Date.parse(b.activity_at) - Date.parse(a.activity_at) || a.item_id.localeCompare(b.item_id),
  )) {
    if (item.item_id === currentId) result.current = item;
    result[item.section].push(item);
  }
  return result;
}
export function command(action: Action, items: readonly InboxItem[], until?: string): Command {
  if (!items.length || items.length > 100 || new Set(items.map((item) => item.item_id)).size !== items.length)
    throw Error("Select between 1 and 100 distinct cards.");
  if (action === "snooze" && (!until || Date.parse(until) <= Date.now() || !timestamp(until)))
    throw Error("Choose a future snooze time.");
  const args = {
    idempotency_key: crypto.randomUUID(),
    items: items.map(({ item_id, base_version }) => ({ item_id, base_version })),
  };
  if (action === "snooze") {
    if (!until) throw Error("Choose a future snooze time.");
    return { action, args: { ...args, until } };
  }
  return { action, args };
}
export function parseResults(
  value: unknown,
  request: Command,
): Array<{ item_id: string; ok: true; item: BaseItem } | Extract<ItemResult, { ok: false }>> {
  if (
    !object(value) ||
    value.ok !== true ||
    value.schema_version !== "home-inbox-command.v1" ||
    !Array.isArray(value.results)
  )
    throw Error("Result uncertain. Retry the same request.");
  const rows = value.results;
  if (rows.some((row) => !object(row) || !request.args.items.some((item) => item.item_id === row.item_id)))
    throw Error("Result uncertain. Unexpected items in command response.");
  return request.args.items.map(({ item_id }) => {
    const matches = rows.filter((row: unknown) => object(row) && row.item_id === item_id);
    const row: unknown = matches.length === 1 ? matches[0] : null;
    if (object(row) && row.ok === true) {
      try {
        const item = parseBaseItem(row.item);
        if (item.item_id === item_id) return { item_id, ok: true, item };
      } catch {
        /* Preserve an unconfirmed item. */
      }
    }
    return {
      item_id,
      ok: false,
      error: object(row) && text(row.error) ? row.error : "Result uncertain. Retry the same request.",
      ...(object(row) && text(row.current_version) ? { current_version: row.current_version } : {}),
    };
  });
}
export type WaitingChoice = Pick<WaitingIdentity, "kind" | "id"> & { name: string };
export type PartyCursor = Readonly<{ query: string; name: string; id: string }>;
type PeoplePage = Readonly<{ choices: WaitingChoice[]; next_cursor: PartyCursor | null }>;
export type InboxClient = {
  review?: {
    current(item: InboxItem): Promise<InboxItem>;
    load(item: InboxItem, signal?: AbortSignal): Promise<ReturnType<typeof parseReview>>;
    run(
      item: InboxItem,
      request: ReviewRequest,
    ): Promise<{ item: InboxItem; receipt?: TaskReceipt; saved_version?: number }>;
  };
  actors?(): Promise<WaitingChoice[] | null>;
  search?(query: string, cursor?: PartyCursor): Promise<PeoplePage | null>;
  choices?(): Promise<WaitingChoice[]>;
  wait?(request: WaitingCommand): Promise<InboxItem>;
  read(signal?: AbortSignal): Promise<Snapshot>;
  run(request: Command): Promise<ItemResult[]>;
  batch(request: BatchRequest, expected: readonly string[]): Promise<BatchResult>;
};
export function createInboxClient(
  rpc: (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>,
): InboxClient {
  async function read(signal?: AbortSignal): Promise<Snapshot> {
    // eslint-disable-next-line no-restricted-syntax -- At most four version reads; only unknown_tool advances to the next version.
    for (const { version } of inboxVersions) {
      let value: unknown;
      try {
        value = await rpc(`read-home-inbox-${version}`, {}, signal);
      } catch (error) {
        if (!object(error) || !object(error.payload) || error.payload.error !== "unknown_tool") throw error;
        value = { error: "unknown_tool" };
      }
      if (object(value) && value.error === "unknown_tool") continue;
      if (!object(value) || value.schema_version !== `home-inbox.${version}`)
        throw Error("Inbox unavailable. The server inbox could not be verified.");
      return parseSnapshot(value);
    }
    throw Error("Inbox unavailable. No supported inbox could be verified.");
  }
  const unavailable = Symbol("unknown_tool");
  async function directory(name: string, args: unknown): Promise<unknown> {
    try {
      const value = await rpc(name, args);
      return object(value) && value.error === "unknown_tool" ? unavailable : value;
    } catch (error) {
      if (object(error) && object(error.payload) && error.payload.error === "unknown_tool") return unavailable;
      throw error;
    }
  }
  return {
    read,
    async actors() {
      const value = await directory("read-actor-roster-v1", {});
      if (value === unavailable) return null;
      if (
        !object(value) ||
        value.ok !== true ||
        value.schema_version !== "actor-roster.v1" ||
        !Array.isArray(value.actors) ||
        value.actors.length > 1000
      )
        throw Error("Actor roster unavailable.");
      const choices = new Map<string, WaitingChoice>();
      for (const row of value.actors) {
        if (
          !object(row) ||
          !uuid(row.id) ||
          typeof row.slug !== "string" ||
          !text(row.display_name) ||
          !["human", "automation", "system"].includes(String(row.kind))
        )
          throw Error("Actor roster unreadable.");
        if (row.kind === "human") choices.set(row.id, { kind: "actor", id: row.id, name: row.display_name });
      }
      return [...choices.values()];
    },
    async search(input, cursor) {
      const query = input.trim();
      if (!query || query.length > 100 || (cursor && cursor.query.toLowerCase() !== query.toLowerCase()))
        throw Error("Enter a name prefix of 1 to 100 characters.");
      const value = await directory("search-parties-v1", { query, limit: 25, ...(cursor ? { cursor } : {}) });
      if (value === unavailable) return null;
      if (
        !object(value) ||
        value.ok !== true ||
        value.schema_version !== "party-search.v1" ||
        !Array.isArray(value.parties) ||
        value.parties.length > 25
      )
        throw Error("People search unavailable.");
      const choices = new Map<string, WaitingChoice>();
      for (const row of value.parties) {
        if (!object(row) || !uuid(row.id) || !text(row.display_name) || !["person", "org"].includes(String(row.kind)))
          throw Error("People search unreadable.");
        if (row.kind === "person") choices.set(row.id, { kind: "party", id: row.id, name: row.display_name });
      }
      const next = value.next_cursor;
      if (
        next !== null &&
        (!object(next) ||
          typeof next.query !== "string" ||
          next.query.toLowerCase() !== query.toLowerCase() ||
          typeof next.name !== "string" ||
          next.name.length > 10000 ||
          !uuid(next.id))
      )
        throw Error("People search cursor unreadable.");
      return {
        choices: [...choices.values()],
        next_cursor: next === null ? null : { query: String(next.query), name: String(next.name), id: String(next.id) },
      };
    },
    async choices() {
      const value = await rpc("email-match-contacts", {});
      if (!object(value) || value.schema_version !== "email-match-contacts.v1" || !Array.isArray(value.contacts))
        throw Error("People unavailable. Try loading again.");
      const choices = new Map<string, WaitingChoice>();
      for (const row of value.contacts)
        if (
          object(row) &&
          row.exact === true &&
          text(row.name) &&
          object(row.contact_snapshot) &&
          uuid(row.contact_snapshot.party_id)
        )
          choices.set(row.contact_snapshot.party_id, {
            kind: "party",
            id: row.contact_snapshot.party_id,
            name: row.name,
          });
      return [...choices.values()];
    },
    async wait(request) {
      if (navigator.onLine === false) throw Error("Offline. No change was sent.");
      const result = await rpc(`${request.action}-home-waiting`, request.args);
      if (
        !object(result) ||
        result.ok !== true ||
        result.schema_version !== "home-waiting.v1" ||
        result.item_id !== request.args.item_id ||
        result.waiting_version !== request.args.base_version + 1
      )
        throw Error("Result uncertain. Retry the same request.");
      const snapshot = await read();
      const item = snapshot.items.find((item) => item.item_id === request.args.item_id);
      if (!item || item.waiting_version === undefined || item.waiting_version < result.waiting_version)
        throw Error("Waiting change recorded. Readback unavailable. Retry the same request.");
      return item;
    },
    review: {
      async current(item) {
        const current = (await read()).items.find((row) => row.item_id === item.item_id);
        if (!current)
          throw Object.assign(Error("Card no longer available."), { payload: { error: "home_review_not_found" } });
        return current;
      },
      async load(item, signal) {
        if (!item.review_reference) throw Error("This card has no inline review.");
        const value = await rpc(
          "read-home-review",
          { item_id: item.item_id, source_version: item.source_version },
          signal,
        );
        if (object(value) && typeof value.error === "string")
          throw Object.assign(Error(value.error), { payload: value });
        const detail = parseReview(value, item.review_reference);
        if (
          detail.operations.some((op) =>
            op.verb === "complete-one-action"
              ? op.args.action_id !== item.action_id
              : op.verb === "resolve-fact-review"
                ? JSON.stringify([op.args.entity_ref, op.args.fact_key]) !== item.source_id
                : op.args.proposal_id !== item.source_id,
          )
        )
          throw Error("Review source does not match this card.");
        return detail;
      },
      async run(item, request) {
        if (navigator.onLine === false) throw Error("Offline. Nothing was sent.");
        const value = await rpc(request.verb, request.args);
        if (object(value) && typeof value.error === "string")
          throw Object.assign(Error(value.error), { payload: value });
        if (!object(value) || value.ok !== true) throw Error("Receipt unavailable.");
        let receipt: TaskReceipt | undefined;
        if (request.verb === "complete-one-action") {
          if (typeof request.args.action_id !== "string" || typeof request.args.base_version !== "number")
            throw Error("Task identity unavailable.");
          receipt = parseActionReceipt(
            value,
            {
              action_id: request.args.action_id,
              base_version: request.args.base_version,
              idempotency_key: request.args.idempotency_key,
            },
            "done",
          );
        } else if (request.verb === "resolve-fact-review") {
          if (
            value.schema_version !== "fact-review.v1" ||
            !object(value.review_receipt) ||
            value.review_receipt.entity_ref !== request.args.entity_ref ||
            value.review_receipt.fact_key !== request.args.fact_key
          )
            throw Error("Review receipt unavailable.");
        } else if (
          value.proposal_id !== item.source_id ||
          !Number.isSafeInteger(value.version) ||
          typeof value.version !== "number" ||
          typeof request.args.base_version !== "number" ||
          value.version <= request.args.base_version
        )
          throw Error("Draft receipt unavailable.");
        const current = (await read()).items.find((row) => row.item_id === item.item_id);
        if (!current) throw Error("Receipt received, but exact card readback is unavailable.");
        return {
          item: current,
          ...(request.verb === "edit-email-draft" && typeof value.version === "number"
            ? { saved_version: value.version }
            : {}),
          ...(receipt &&
          current.action_id === receipt.action_id &&
          current.action_version === receipt.version &&
          current.source_state === "done"
            ? { receipt }
            : {}),
        };
      },
    },
    async batch(request, expected) {
      if (navigator.onLine === false) throw Error("Offline. No change was sent. Reconnect and retry manually.");
      const receipt = parseBatch(await rpc(`${request.action}-home-inbox`, request.args), request, expected);
      let snapshot: Snapshot | null = null;
      try {
        snapshot = await read();
      } catch {
        /* Receipts remain confirmed even when readback fails. */
      }
      return { ...receipt, snapshot };
    },
    async run(request) {
      if (navigator.onLine === false) throw Error("Offline. No change was sent. Reconnect and retry manually.");
      if (request.action === "complete" || request.action === "reopen") {
        const { items, ...args } = request.args;
        const receipt =
          request.action === "complete"
            ? await completeAction({ completeOneAction: (args) => rpc("complete-one-action", args) }, args)
            : parseActionReceipt(await rpc("reopen-one-action", args), args, "open");
        const snapshot = await read();
        const expectedItem = items[0]?.item_id;
        const item = snapshot.items.find(
          (item) => item.item_id === expectedItem && item.action_id === receipt.action_id,
        );
        if (!item) throw Error("Task receipt confirmed, but readback is unavailable. Retry the same request.");
        const item_id = item.item_id;
        if (
          item.action_version !== receipt.version ||
          item.source_state !== (receipt.status === "done" ? "done" : "needs_attention")
        )
          return [{ item_id, ok: false, error: "intervening_change", current_item: item }];
        return [{ item_id, ok: true, item, receipt }];
      }
      const results = parseResults(await rpc(`${request.action}-home-inbox`, request.args), request);
      if (!results.some((result) => result.ok)) return results.flatMap((result) => (result.ok ? [] : [result]));
      const snapshot = await read();
      return results.map((result) => {
        if (!result.ok) return result;
        const item = snapshot.items.find((item) => item.item_id === result.item_id);
        if (!item)
          return {
            item_id: result.item_id,
            ok: false,
            error: "Confirmed change, but card readback is unavailable. Refresh to check its state.",
          };
        if (item.base_version !== result.item.base_version)
          return { item_id: result.item_id, ok: false, error: "intervening_change", current_item: item };
        return { item_id: result.item_id, ok: true, item: { ...item, base_version: result.item.base_version } };
      });
    },
  };
}
