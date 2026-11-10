import { parseWatch, type Subject, type Watch } from "./model.ts";
import { parseWatchPage } from "./radar-model.ts";

type Transport = (verb: string, args: object, options: { signal: AbortSignal; timeoutMs: number }) => Promise<unknown>;
type Outcome =
  | { kind: "confirmed"; watch: Watch | null }
  | { kind: "conflict" }
  | { kind: "denied" }
  | { kind: "unknown" };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
export function createWatchClient(transport?: Transport) {
  return async (verb: string, args: Subject & object, signal: AbortSignal): Promise<Outcome> => {
    try {
      const send = transport ?? (await import(new URL("./mcp-requests.mjs", import.meta.url).href)).createMcpRequests();
      const result: unknown = await send(verb, args, { signal, timeoutMs: 10000 });
      if (!object(result)) return { kind: "unknown" };
      if (result.kind === "authorization") return { kind: "denied" };
      if (
        object(result.cause) &&
        (result.cause.status === 401 || result.cause.status === 403 || result.cause.code === "authentication_required")
      )
        return { kind: "denied" };
      if (result.kind !== "payload") return { kind: "unknown" };
      if (object(result.payload) && typeof result.payload.error === "string") {
        if (result.payload.error === "watch_stale_version") return { kind: "conflict" };
        if (/human|auth|permission|forbidden|watch_target_not_found/.test(result.payload.error))
          return { kind: "denied" };
        return { kind: "unknown" };
      }
      if (result.isError) return { kind: "unknown" };
      return { kind: "confirmed", watch: parseWatch(result.payload, args) };
    } catch {
      return { kind: "unknown" };
    }
  };
}
export type WatchClient = ReturnType<typeof createWatchClient>;
export function createWatchListReader(transport?: Transport) {
  return async (signal: AbortSignal) => {
    const send = transport ?? (await import(new URL("./mcp-requests.mjs", import.meta.url).href)).createMcpRequests();
    const watches: Watch[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    // eslint-disable-next-line no-restricted-syntax -- Limit the list to 10 pages of 100 watches, each read has a 10-second deadline.
    for (let page = 0; page < 10; page++) {
      const result: unknown = await send(
        "list-subject-watches-v2",
        { limit: 100, ...(cursor ? { cursor } : {}) },
        { signal, timeoutMs: 10000 },
      );
      if (!object(result) || result.kind !== "payload" || result.isError) throw Error("Watch list unavailable");
      const parsed = parseWatchPage(result.payload);
      watches.push(...parsed.watches);
      if (new Set(watches.map((watch) => watch.actor_id)).size > 1) throw Error("Watch actor changed while paging");
      if (new Set(watches.map((watch) => `${watch.subject_type}:${watch.subject_id}`)).size !== watches.length)
        throw Error("Watch list changed while paging. Refresh.");
      if (!parsed.next) return watches;
      if (cursors.has(parsed.next)) throw Error("Watch list cursor repeated");
      cursors.add(parsed.next);
      cursor = parsed.next;
    }
    throw Error("Watch list exceeds 1000 subscriptions");
  };
}
