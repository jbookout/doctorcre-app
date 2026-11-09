import type { ExactCard } from "./exact-action-card.ts";

export type ReviewOutcome =
  | { kind: "success" }
  | { kind: "retryable-error" }
  | { kind: "terminal-refusal" }
  | { kind: "stale-source" };

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function parseReviewOutcome(result: unknown, sessionId: string): ReviewOutcome {
  if (object(result) && result.kind === "authorization") return { kind: "terminal-refusal" };
  if (object(result) && result.kind === "payload" && object(result.payload)) {
    const p = result.payload;
    if (
      Object.keys(p).length === 3 &&
      p.error === "source_version_changed" &&
      typeof p.correlation_id === "string" &&
      p.hint === "This call changed. Reopen the card and review the current outcome."
    )
      return { kind: "stale-source" };
    if (
      !result.isError &&
      p.ok === true &&
      p.session_id === sessionId &&
      Object.keys(p).every((key) => ["ok", "session_id", "reviewed", "already", "replayed"].includes(key)) &&
      (!Object.hasOwn(p, "replayed") || p.replayed === true) &&
      ((p.reviewed === true && !Object.hasOwn(p, "already")) ||
        (p.already === "reviewed" && !Object.hasOwn(p, "reviewed")))
    )
      return { kind: "success" };
  }
  return { kind: "retryable-error" };
}

async function reviewIntentKey(principal: string, sessionId: string, sourceVersion: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(["doctorcre-review-v1", principal, sessionId, sourceVersion])),
    ),
  );
  bytes[6] = ((bytes[6] ?? 0) & 15) | 128;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = Array.from(bytes.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function reviewCallOutcome({
  card,
  request,
  signal,
  principal,
}: {
  card: Extract<ExactCard, { kind: "post_call_review" }>;
  request: (
    name: string,
    args: Record<string, unknown>,
    options: { signal: AbortSignal; timeoutMs: number },
  ) => Promise<unknown>;
  signal: AbortSignal;
  principal: () => Promise<string | null>;
}): Promise<ReviewOutcome> {
  const actor = await principal();
  if (!actor || signal.aborted) return { kind: "terminal-refusal" };
  const idempotency_key = await reviewIntentKey(actor, card.id, card.source_version);
  if (signal.aborted) return { kind: "terminal-refusal" };
  return parseReviewOutcome(
    await request(
      "review-call-outcome",
      {
        session_id: card.id,
        expected_source_version: card.source_version,
        idempotency_key,
      },
      { signal, timeoutMs: 10_000 },
    ),
    card.id,
  );
}
