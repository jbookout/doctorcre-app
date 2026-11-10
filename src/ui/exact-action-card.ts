type ReviewDetail = {
  session_id: string;
  started_at: string;
  reviewed: boolean;
  candidates: Record<string, unknown>[];
  changes: Record<string, unknown>[];
};
type FeedbackDetail = {
  event_id: string;
  projection_id: string;
  share_grant_id: string;
  property_id: string;
  action: "shortlist" | "comment";
  shortlisted: boolean | null;
  comment: string | null;
  created_at: string;
};
type Lifecycle = "stale" | "resolved" | "retired";
export type ExactCard =
  | {
      kind: "post_call_review";
      id: string;
      state: "pending_review" | Lifecycle;
      source_version: string;
      detail: ReviewDetail | null;
    }
  | { kind: "feedback_event"; id: string; state: Lifecycle; source_version: string; detail: FeedbackDetail | null }
  | {
      kind: "reply_draft";
      id: string;
      state: Lifecycle;
      source_version: number;
      subject?: string;
      body?: string;
      to?: string[];
      cc?: string[];
    };
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const text = (v: unknown): v is string => typeof v === "string";
const records = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.every(object);
export function parseExactCard(value: unknown, ref: string): ExactCard | null {
  if (!object(value) || value.schema_version !== "action-link-resolve.v2" || value.ref !== ref || !object(value.card))
    return null;
  if (Object.keys(value).sort().join(",") !== "card,ref,schema_version") return null;
  const c = value.card;
  const allowed =
    c.kind === "reply_draft"
      ? [
          "kind",
          "id",
          "state",
          "source_version",
          "actions",
          ...(c.state === "stale" ? ["subject", "body", "to", "cc"] : []),
        ]
      : ["kind", "id", "state", "source_version", "detail", "actions"];
  if (Object.keys(c).length !== allowed.length || !allowed.every((key) => Object.hasOwn(c, key))) return null;
  if (!uuid(c.id) || !Array.isArray(c.actions)) return null;
  let decoded: string;
  try {
    decoded = atob(ref.slice(4).replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  if (`al1_${btoa(decoded).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}` !== ref) return null;
  const [code, id, version, replyVersion, ...rest] = decoded.split(":");
  if (id !== c.id || rest.length) return null;
  const state = c.state;
  if (state !== "pending_review" && state !== "stale" && state !== "resolved" && state !== "retired") return null;
  if (c.kind === "reply_draft") {
    if (
      code !== "rd" ||
      !["joe", "dell"].includes(version || "") ||
      !/^[1-9][0-9]*$/.test(replyVersion || "") ||
      typeof c.source_version !== "number" ||
      !Number.isSafeInteger(c.source_version) ||
      c.source_version < 1 ||
      c.actions.length ||
      state === "pending_review"
    )
      return null;
    if (state === "stale") {
      if (
        !text(c.subject) ||
        !text(c.body) ||
        !Array.isArray(c.to) ||
        !c.to.every(text) ||
        !Array.isArray(c.cc) ||
        !c.cc.every(text)
      )
        return null;
      return {
        kind: c.kind,
        id: c.id,
        state,
        source_version: c.source_version,
        subject: c.subject,
        body: c.body,
        to: c.to,
        cc: c.cc,
      };
    }
    return { kind: c.kind, id: c.id, state, source_version: c.source_version };
  }
  if (replyVersion !== undefined || !text(version) || !/^[A-Za-z0-9_-]{1,32}$/.test(version) || !text(c.source_version))
    return null;
  if (state !== "pending_review" && c.actions.length) return null;
  if (state === "pending_review") {
    const op: unknown = c.actions[0];
    if (
      c.actions.length !== 1 ||
      !object(op) ||
      op.action !== "review" ||
      op.verb !== "review-call-outcome" ||
      !object(op.args) ||
      op.args.session_id !== id ||
      c.source_version !== version
    )
      return null;
  }
  if (c.kind === "post_call_review" && code === "cr") {
    if (state === "retired")
      return c.detail === null
        ? { kind: c.kind, id: c.id, state, source_version: c.source_version, detail: null }
        : null;
    const d = c.detail;
    if (
      !object(d) ||
      d.session_id !== id ||
      !text(d.started_at) ||
      typeof d.reviewed !== "boolean" ||
      !records(d.candidates) ||
      !records(d.changes)
    )
      return null;
    return {
      kind: c.kind,
      id: c.id,
      state,
      source_version: c.source_version,
      detail: {
        session_id: id,
        started_at: d.started_at,
        reviewed: d.reviewed,
        candidates: d.candidates,
        changes: d.changes,
      },
    };
  }
  if (c.kind === "feedback_event" && code === "fe" && state !== "pending_review" && !c.actions.length) {
    if (state === "retired")
      return c.detail === null
        ? { kind: c.kind, id: c.id, state, source_version: c.source_version, detail: null }
        : null;
    const d = c.detail;
    if (
      !object(d) ||
      d.event_id !== id ||
      !uuid(d.projection_id) ||
      !uuid(d.share_grant_id) ||
      !uuid(d.property_id) ||
      !["shortlist", "comment"].includes(String(d.action)) ||
      !(d.shortlisted === null || typeof d.shortlisted === "boolean") ||
      !(d.comment === null || text(d.comment)) ||
      !text(d.created_at)
    )
      return null;
    return {
      kind: c.kind,
      id: c.id,
      state,
      source_version: c.source_version,
      detail: {
        event_id: id,
        projection_id: d.projection_id,
        share_grant_id: d.share_grant_id,
        property_id: d.property_id,
        action: d.action === "comment" ? "comment" : "shortlist",
        shortlisted: d.shortlisted,
        comment: d.comment,
        created_at: d.created_at,
      },
    };
  }
  return null;
}
