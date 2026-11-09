export type ReviewOutcome =
  | { kind: "success"; intent: "clear" }
  | { kind: "retryable-error"; intent: "retain" }
  | { kind: "terminal-refusal"; intent: "retain" }
  | { kind: "stale-source"; intent: "retain" };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function parseReviewOutcome(result: unknown, sessionId: string): ReviewOutcome {
  if (object(result) && result.kind === "authorization") return { kind: "terminal-refusal", intent: "retain" };
  if (object(result) && result.kind === "payload" && object(result.payload)) {
    const p = result.payload;
    if (
      Object.keys(p).length === 3 &&
      p.error === "source_version_changed" &&
      typeof p.correlation_id === "string" &&
      p.hint === "This call changed. Reopen the card and review the current outcome."
    )
      return { kind: "stale-source", intent: "retain" };
    if (
      !result.isError &&
      p.ok === true &&
      p.session_id === sessionId &&
      Object.keys(p).every((key) => ["ok", "session_id", "reviewed", "already", "replayed"].includes(key)) &&
      (!Object.hasOwn(p, "replayed") || p.replayed === true) &&
      ((p.reviewed === true && !Object.hasOwn(p, "already")) ||
        (p.already === "reviewed" && !Object.hasOwn(p, "reviewed")))
    )
      return { kind: "success", intent: "clear" };
  }
  return { kind: "retryable-error", intent: "retain" };
}
