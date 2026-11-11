import { type InboxItem, object, type Snapshot } from "./inbox.tsx";
export type BatchAction = "snooze" | "settle";
type BatchIdentity = Readonly<{ reversible: true; idempotency_key: string }>;
type ApplyArgs = BatchIdentity & Readonly<{ items: ReadonlyArray<Pick<InboxItem, "item_id" | "base_version">> }>;
export type BatchRequest =
  | Readonly<{ action: "snooze"; args: ApplyArgs & { until: string } }>
  | Readonly<{ action: "settle"; args: ApplyArgs }>
  | Readonly<{
      action: BatchAction;
      args: BatchIdentity & { undo_of: string; items?: ReadonlyArray<Pick<InboxItem, "item_id">> };
    }>;
export type BatchReceipt = Readonly<{
  item_id: string;
  status: "applied" | "already" | "not_found" | "not_allowed";
  error?: string;
}>;
export type BatchResult = Readonly<{ batch_key: string; results: readonly BatchReceipt[]; snapshot: Snapshot | null }>;
export type Batch = Readonly<{
  request: BatchRequest;
  items: readonly InboxItem[];
  result: BatchResult;
  remaining: readonly string[];
}>;
export type BatchState =
  | { kind: "selection" }
  | { kind: "applying"; request: BatchRequest; items: readonly InboxItem[] }
  | { kind: "results" | "undone" | "undo_refused"; batch: Batch }
  | { kind: "undoing"; request: BatchRequest; batch: Batch }
  | { kind: "uncertain"; operation: Extract<BatchState, { kind: "applying" | "undoing" }>; message: string };
export type BatchEvent =
  | { kind: "apply"; request: BatchRequest; items: readonly InboxItem[] }
  | { kind: "undo"; request: BatchRequest }
  | { kind: "received"; result: BatchResult }
  | { kind: "failed"; message: string }
  | { kind: "retry" }
  | { kind: "reset" };
export function transition(state: BatchState, event: BatchEvent): BatchState {
  switch (event.kind) {
    case "apply":
      return state.kind === "selection" ? { kind: "applying", request: event.request, items: event.items } : state;
    case "undo":
      return "batch" in state && state.kind !== "undoing"
        ? { kind: "undoing", request: event.request, batch: state.batch }
        : state;
    case "received": {
      if (state.kind === "applying")
        return {
          kind: "results",
          batch: {
            request: state.request,
            items: state.items,
            result: event.result,
            remaining: event.result.results.filter((row) => row.status === "applied").map((row) => row.item_id),
          },
        };
      if (state.kind !== "undoing") return state;
      const restored = event.result.results
        .filter((row) => row.status === "applied" || row.status === "already")
        .map((row) => row.item_id);
      return {
        kind: event.result.results.some((row) => row.status === "not_allowed" || row.status === "not_found")
          ? "undo_refused"
          : "undone",
        batch: {
          ...state.batch,
          result: {
            ...event.result,
            results: state.batch.result.results.map(
              (row) => event.result.results.find((next) => next.item_id === row.item_id) || row,
            ),
          },
          remaining: state.batch.remaining.filter((id) => !restored.includes(id)),
        },
      };
    }
    case "failed":
      return state.kind === "applying" || state.kind === "undoing"
        ? { kind: "uncertain", operation: state, message: event.message }
        : state;
    case "retry":
      return state.kind === "uncertain" ? state.operation : state;
    case "reset":
      return state.kind === "applying" || state.kind === "undoing" || state.kind === "uncertain"
        ? state
        : { kind: "selection" };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
export function batchRequest(action: BatchAction, items: readonly InboxItem[], until?: string): BatchRequest {
  if (!items.length || items.length > 100 || new Set(items.map((item) => item.item_id)).size !== items.length)
    throw Error("Select between 1 and 100 distinct cards.");
  if (action === "snooze" && (!until || !Number.isFinite(Date.parse(until)) || Date.parse(until) <= Date.now()))
    throw Error("Choose a future Central time.");
  const args: ApplyArgs = {
    reversible: true,
    idempotency_key: crypto.randomUUID(),
    items: items.map(({ item_id, base_version }) => ({ item_id, base_version })),
  };
  if (action === "snooze") {
    if (!until) throw Error("Choose a future Central time.");
    return { action, args: { ...args, until } };
  }
  return { action, args };
}
export function undoRequest(batch: Batch, subset?: readonly string[]): BatchRequest {
  if (subset && (!subset.length || subset.some((id) => !batch.remaining.includes(id))))
    throw Error("Select applied cards to undo.");
  return {
    action: batch.request.action,
    args: {
      reversible: true,
      idempotency_key: crypto.randomUUID(),
      undo_of: batch.result.batch_key,
      ...(subset ? { items: subset.map((item_id) => ({ item_id })) } : {}),
    },
  };
}
export function parseBatch(
  value: unknown,
  request: BatchRequest,
  expected: readonly string[],
): Omit<BatchResult, "snapshot"> {
  const key = "undo_of" in request.args ? request.args.undo_of : request.args.idempotency_key;
  if (
    !object(value) ||
    value.ok !== true ||
    value.schema_version !== "home-inbox-batch.v1" ||
    value.batch_key !== key ||
    !Array.isArray(value.results) ||
    value.results.length !== expected.length
  )
    throw Error("Batch result uncertain. Retry the same request.");
  const results: BatchReceipt[] = value.results.map((row: unknown) => {
    if (
      !object(row) ||
      typeof row.item_id !== "string" ||
      !expected.includes(row.item_id) ||
      (row.error !== undefined && typeof row.error !== "string")
    )
      throw Error("Batch result uncertain. Unexpected card.");
    const status = row.status;
    if (status !== "applied" && status !== "already" && status !== "not_found" && status !== "not_allowed")
      throw Error("Batch result uncertain. Unknown receipt.");
    return { item_id: row.item_id, status, ...(typeof row.error === "string" ? { error: row.error } : {}) };
  });
  if (new Set(results.map((row) => row.item_id)).size !== expected.length)
    throw Error("Batch result uncertain. Missing receipt.");
  return { batch_key: key, results };
}
