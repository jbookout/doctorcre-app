import { parseWatch, type Subject, type Watch } from "./model.ts";

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
