import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

const partnerNames: Record<string, string> = { joe: "Joe", dell: "Dell" };
type Payload = {
  summary?: string | null;
  text?: string | null;
  next_date?: string | null;
  value?: string | null;
  body?: string | null;
  assignee?: string | null;
  due_on?: string | null;
  started_on?: string | null;
  action?: string | null;
  subject?: string | null;
  base_event_id?: string | null;
  plan_base?: Record<string, string | null>;
};
type ActionSnapshot = { description: string; owner: string; due_on: string | null };
type ActionComparison =
  | { status: "unavailable" }
  | { status: "assignee_unavailable" }
  | { status: "no_match" }
  | {
      status: "exact_match";
      action: ActionSnapshot;
      date: { current: string | null; resulting: string | null; changes: boolean };
    }
  | { status: "related_open_tasks"; actions: ActionSnapshot[]; total: number };
type Candidate = {
  comparison: ActionComparison;
  resolver: string | null;
  candidate_id: string;
  kind: string;
  deal_id: string | null;
  deal_name: string | null;
  payload: Payload;
  evidence_quote: string | null;
};
type Change = Candidate & { deal_version: number; undone_at: string | null };
type Call = {
  source_version: string | null;
  session_id: string;
  call_date: string;
  applied: Change[];
  open_cards: Candidate[];
};
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown) {
  if (!isObject(value)) throw new Error("Call data unavailable");
  return value;
}
function text(value: unknown) {
  if (typeof value !== "string") throw new Error("Call text unavailable");
  return value;
}
function optionalText(value: unknown) {
  return value == null ? null : text(value);
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Call items unavailable");
  return value;
}
function actionSnapshot(value: unknown): ActionSnapshot {
  const row = object(value);
  return { description: text(row.description), owner: text(row.owner), due_on: optionalText(row.due_on) };
}
function actionComparison(value: unknown): ActionComparison {
  try {
    const row = object(value);
    if (row.schema_version !== "post-call-action-comparison.v2") return { status: "unavailable" };
    switch (row.status) {
      case "exact_match": {
        const date = object(row.date_effect);
        if (typeof date.changes_due_on !== "boolean") return { status: "unavailable" };
        return {
          status: "exact_match",
          action: actionSnapshot(row.exact_match),
          date: {
            current: optionalText(date.current_due_on),
            resulting: optionalText(date.resulting_due_on),
            changes: date.changes_due_on,
          },
        };
      }
      case "related_open_tasks": {
        const total = row.related_open_task_total,
          actions = list(row.related_open_tasks).map(actionSnapshot);
        if (
          typeof total !== "number" ||
          !Number.isSafeInteger(total) ||
          total < actions.length ||
          !actions.length ||
          actions.length > 5
        )
          return { status: "unavailable" };
        return { status: "related_open_tasks", actions, total };
      }
      case "no_match":
        return { status: row.related_open_task_total === 0 ? "no_match" : "unavailable" };
      case "assignee_unavailable":
        return { status: "assignee_unavailable" };
      default:
        return { status: "unavailable" };
    }
  } catch {
    return { status: "unavailable" };
  }
}
function candidate(value: unknown): Candidate {
  const row = object(value),
    raw = row.payload === undefined ? {} : object(row.payload),
    payload: Payload = {};
  for (const key of [
    "summary",
    "text",
    "next_date",
    "value",
    "started_on",
    "action",
    "subject",
    "base_event_id",
    "body",
    "assignee",
    "due_on",
  ] as const) {
    if (Object.hasOwn(raw, key)) payload[key] = optionalText(raw[key]);
  }
  if (raw.plan_base !== undefined)
    payload.plan_base = Object.fromEntries(
      Object.entries(object(raw.plan_base)).map(([field, value]) => [field, optionalText(value)]),
    );
  return {
    comparison: actionComparison(row.existing_action_comparison),
    resolver: optionalText(row.resolver),
    candidate_id: text(row.candidate_id),
    kind: text(row.kind),
    deal_id: optionalText(row.deal_id),
    deal_name: optionalText(row.deal_name),
    evidence_quote: optionalText(row.evidence_quote),
    payload,
  };
}
function callAnswer(value: unknown): { calls: Call[] } {
  return {
    calls: list(object(value).calls).map((value) => {
      const row = object(value);
      return {
        source_version: typeof row.source_version === "string" && row.source_version.length ? row.source_version : null,
        session_id: text(row.session_id),
        call_date: text(row.call_date),
        open_cards: list(row.open_cards).map(candidate),
        applied: list(row.applied).map((value) => {
          const row = object(value);
          if (typeof row.deal_version !== "number" || !Number.isFinite(row.deal_version))
            throw new Error("Deal version unavailable");
          return { ...candidate(value), deal_version: row.deal_version, undone_at: optionalText(row.undone_at) };
        }),
      };
    }),
  };
}
function appliedSignature(change: Change) {
  return JSON.stringify({ ...change, deal_version: undefined });
}
function receipt(value: unknown) {
  if (object(value).ok !== true) throw new Error("Command refused");
}
type Item = { call: Call; key: string; signature: string; before: ReactNode } & (
  | { state: "applied"; candidate: Change }
  | { state: "pending" | "resolved"; candidate: Candidate }
);
type Client = {
  readCallOutcomes(): Promise<unknown>;
  getDeal?(id: string): Promise<unknown>;
  undoCallChange(args: { candidate_id: string; base_version: number }): Promise<unknown>;
  resolvePostCallCandidate?(args: { candidate_id: string; accept: boolean; idempotency_key: string }): Promise<unknown>;
  resolveConfirm?(args: { proposal_id: string; accept: boolean; idempotency_key: string }): Promise<unknown>;
  reviewCallOutcome(args: { session_id: string; expected_source_version: string }): Promise<unknown>;
};
type Options = {
  client(): Client;
  describe(change: Candidate): string;
  dateLabel?(value: string): string;
  undoRefusal(error: unknown): string;
  onChange?(): void;
} & ({ sessionId: string; filter?: never } | { filter(): string[]; sessionId?: never });
const reviewReads = new WeakMap<Document, Promise<void>>();
type Load =
  | { state: "loading" | "ready" | "empty" | "signed_out" | "completed" }
  | { state: "retrying"; resumesAt: number }
  | { state: "paused" }
  | { state: "unavailable"; message: string };
function beforeText(candidate: Candidate, detail: unknown, dateLabel: Options["dateLabel"]) {
  const dateText = (value: string | null) =>
    value ? (
      <time dateTime={value} style={{ whiteSpace: "nowrap" }}>
        {dateLabel?.(value) ?? value}
      </time>
    ) : (
      "No due date"
    );
  if (candidate.kind === "assigned_action") {
    const comparison = candidate.comparison;
    const actionText = (action: ActionSnapshot) => (
      <>
        {action.description} · {partnerNames[action.owner] ?? action.owner} · {dateText(action.due_on)}
      </>
    );
    switch (comparison.status) {
      case "exact_match": {
        const { current, resulting, changes } = comparison.date;
        const date = changes ? (
          current ? (
            <>
              Due date changes from {dateText(current)} to {dateText(resulting)}
            </>
          ) : (
            <>Due date set to {dateText(resulting)}</>
          )
        ) : current ? (
          <>Due date stays {dateText(current)}</>
        ) : (
          "No due date"
        );
        return (
          <>
            <strong>Already on this deal</strong>
            <div>{actionText(comparison.action)}</div>
            <div>Accepting adds this call's notes to that task.</div>
            <div>{date}</div>
          </>
        );
      }
      case "related_open_tasks":
        return (
          <>
            <strong>Other open tasks on this deal</strong>
            <ul>
              {comparison.actions.map((action) => (
                <li key={JSON.stringify(action)}>{actionText(action)}</li>
              ))}
            </ul>
            {comparison.total > comparison.actions.length && (
              <div>and {comparison.total - comparison.actions.length} more</div>
            )}
          </>
        );
      case "no_match":
        return "No other open tasks on this deal";
      case "assignee_unavailable":
        return "Comparison unavailable: task owner not recognised";
      case "unavailable":
        return "Comparison unavailable";
      default: {
        const exhaustive: never = comparison;
        return exhaustive;
      }
    }
  }
  if (candidate.kind === "activity" || candidate.kind === "meeting_record") return "New note proposed";
  if (candidate.kind === "email_draft") return "New email draft proposed";
  if (candidate.kind === "new_deal") return "New deal proposed";
  if (!["phase_move", "next_step"].includes(candidate.kind)) return "Earlier value unavailable.";
  const field = candidate.kind === "phase_move" ? "phase" : "next_step";
  const base: Record<string, string | null | undefined> | undefined =
    candidate.kind === "phase_move" && Object.hasOwn(candidate.payload, "base_event_id")
      ? { phase: candidate.payload.base_event_id }
      : candidate.payload.plan_base;
  if (!base || !Object.hasOwn(base, field)) return "Earlier value unavailable.";
  if (base[field] === null) return "No earlier value recorded.";
  const history: unknown[] = isObject(detail) && Array.isArray(detail.history) ? detail.history : [];
  const event = history.find((row) => isObject(row) && row.id === base[field]);
  return isObject(event) && typeof event.new_value === "string" ? event.new_value : "Earlier value unavailable.";
}
function decisionRefusal(error: unknown, action: "approve" | "skip") {
  return isObject(error) && error.status === 429
    ? "Your decision was not saved. When the countdown ends, choose Approve or Skip again."
    : `Could not ${action} this item. Refresh and check before retrying.`;
}
function signedOut(error: unknown) {
  return isObject(error) && (error.status === 401 || error.status === 403);
}

export function mountCallReview(container: HTMLElement, options: Options) {
  const root = createRoot(container);
  let disposed = false,
    revoked = false,
    sequence = 0,
    writing = false;
  let load: Load = { state: "loading" },
    items: Item[] = [],
    selected: string | undefined,
    notice = "";
  let deciding: string | undefined,
    automaticAttempts = 0;
  let decision:
    | {
        key: string;
        signature: string;
        resolver: string;
        args: { candidate_id: string; accept: boolean; idempotency_key: string };
      }
    | undefined;
  let inFlight: Promise<void> | undefined, retryTimer: ReturnType<typeof setTimeout> | undefined;
  const details = new Map<string, unknown>();
  const active = () => {
    const dialog = container.ownerDocument.querySelector(".call-review-dialog[open]");
    return dialog ? dialog.contains(container) : !container.closest(".call-review-dialog");
  };
  const cancelWait = () => {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  };
  function retry(touchedDeal?: string | null) {
    cancelWait();
    load = automaticAttempts < 3 ? { state: "retrying", resumesAt: Date.now() + 60_000 } : { state: "paused" };
    if (load.state === "paused") return;
    automaticAttempts++;
    function tick() {
      retryTimer = undefined;
      if (load.state !== "retrying") return;
      const remaining = load.resumesAt - Date.now();
      if (remaining <= 0) {
        void refresh({ touchedDeal });
        return;
      }
      render();
      // eslint-disable-next-line no-restricted-syntax -- Update the countdown until the read retry deadline; dispose and sign-out cancel the timer.
      retryTimer = setTimeout(tick, Math.min(1000, remaining));
    }
    tick();
  }
  const completed = () => load.state === "completed";
  const reviewed = new Map<string, string>();
  const complete = (item: Item) => item.state === "resolved" || reviewed.get(item.key) === item.signature;
  const outstanding = () => items.find((item) => !complete(item));
  const current = () => items.find((item) => item.key === selected) ?? outstanding() ?? items[0];
  const clear = () => {
    items = [];
    reviewed.clear();
    selected = undefined;
    decision = undefined;
  };
  function render() {
    if (disposed) return;
    container.hidden = false;
    flushSync(() => root.render(renderGuide()));
  }
  function refresh(args: { preserveSelection?: boolean; touchedDeal?: string | null | undefined } = {}): Promise<void> {
    if (disposed || revoked || writing || completed() || !active() || retryTimer !== undefined)
      return Promise.resolve();
    if (inFlight) return inFlight;
    if (load.state === "paused") automaticAttempts = 0;
    const previous = reviewReads.get(container.ownerDocument) ?? Promise.resolve();
    const pending = previous.then(() => read(args));
    inFlight = pending.finally(() => {
      inFlight = undefined;
      render();
    });
    reviewReads.set(container.ownerDocument, inFlight);
    return inFlight;
  }
  async function read({
    preserveSelection = true,
    touchedDeal,
  }: {
    preserveSelection?: boolean;
    touchedDeal?: string | null | undefined;
  }) {
    if (disposed || revoked || writing || completed() || !active()) return;
    const read = ++sequence;
    if (!items.length) {
      load = { state: "loading" };
      render();
    }
    try {
      const answer = callAnswer(await options.client().readCallOutcomes());
      if (disposed || revoked || read !== sequence) return;
      const ids = new Set(options.filter?.());
      const calls = answer.calls.filter((call) =>
        options.sessionId !== undefined
          ? call.session_id === options.sessionId
          : [...call.applied, ...call.open_cards].some((item) => ids.has(item.candidate_id)),
      );
      const deals = [
        ...new Set(
          calls.flatMap((call) =>
            [...call.applied, ...call.open_cards].flatMap((item) => (item.deal_id ? [item.deal_id] : [])),
          ),
        ),
      ];
      if (touchedDeal) {
        details.delete(touchedDeal);
        if (!deals.includes(touchedDeal)) deals.push(touchedDeal);
      }
      // eslint-disable-next-line no-restricted-syntax -- Read each distinct discussed deal once; actions invalidate only the touched deal.
      for (const id of deals.filter((id) => !details.has(id))) {
        try {
          details.set(id, await options.client().getDeal?.(id));
        } catch (error) {
          if (signedOut(error) || (isObject(error) && error.status === 429)) throw error;
          details.set(id, null);
        }
        if (disposed || revoked || read !== sequence) {
          details.clear();
          return;
        }
      }
      if (disposed || revoked || read !== sequence) return;
      const previous = items;
      for (const call of calls) {
        if (
          previous.some(
            (item) => item.call.session_id === call.session_id && item.call.source_version !== call.source_version,
          )
        ) {
          for (const item of previous.filter((item) => item.call.session_id === call.session_id))
            reviewed.delete(item.key);
        }
      }
      items = calls.flatMap((call) => {
        const applied: Item[] = call.applied.map((candidate) => ({
          call,
          candidate,
          state: "applied",
          key: `${call.session_id}:${candidate.candidate_id}`,
          signature: appliedSignature(candidate),
          before: beforeText(candidate, details.get(candidate.deal_id ?? ""), options.dateLabel),
        }));
        const pending: Item[] = call.open_cards.map((candidate) => ({
          call,
          candidate,
          state: "pending",
          key: `${call.session_id}:${candidate.candidate_id}`,
          signature: JSON.stringify(candidate),
          before: beforeText(candidate, details.get(candidate.deal_id ?? ""), options.dateLabel),
        }));
        const resolved: Item[] = previous
          .filter(
            (item) =>
              item.call.session_id === call.session_id &&
              item.state !== "applied" &&
              ![...applied, ...pending].some((next) => next.key === item.key),
          )
          .map((item) => ({ ...item, call, state: "resolved" }));
        const dealOrder = new Map<string, number>();
        for (const candidate of [
          ...previous.filter((item) => item.call.session_id === call.session_id).map((item) => item.candidate),
          ...call.applied,
          ...call.open_cards,
        ]) {
          const deal = candidate.deal_id ?? "";
          if (!dealOrder.has(deal)) dealOrder.set(deal, dealOrder.size);
        }
        const itemOrder = new Map(previous.map((item, index) => [item.key, index]));
        return [...applied, ...pending, ...resolved].sort(
          (a, b) =>
            (dealOrder.get(a.candidate.deal_id ?? "") ?? 0) - (dealOrder.get(b.candidate.deal_id ?? "") ?? 0) ||
            (itemOrder.get(a.key) ?? previous.length) - (itemOrder.get(b.key) ?? previous.length),
        );
      });
      if (decision && !items.some((item) => item.key === decision?.key && item.state === "pending"))
        decision = undefined;
      if (!preserveSelection || !items.some((item) => item.key === selected))
        selected = outstanding()?.key ?? items[0]?.key;
      automaticAttempts = 0;
      load = { state: items.length ? "ready" : "empty" };
    } catch (error) {
      if (disposed || revoked || read !== sequence) return;
      if (signedOut(error)) {
        revoked = true;
        clear();
        load = { state: "signed_out" };
      }
      // eslint-disable-next-line no-restricted-syntax -- Only three automatic read attempts after a budget refusal; writes are never replayed.
      else if (isObject(error) && error.status === 429) retry(touchedDeal);
      else load = { state: "unavailable", message: "Could not check this call. Refresh before continuing the review." };
    }
    render();
  }
  async function act(run: () => Promise<unknown>, refused: (error: unknown) => string, touchedDeal?: string | null) {
    if (disposed || revoked || writing || inFlight || load.state !== "ready") return;
    writing = true;
    sequence++;
    notice = "";
    render();
    try {
      const result = await run();
      if (isObject(result) && result.ok === false) throw new Error("Command refused");
      if (disposed || revoked) return;
      writing = false;
      if (!completed()) await refresh({ preserveSelection: true, touchedDeal });
      if (!disposed && !revoked) options.onChange?.();
    } catch (error) {
      if (disposed || revoked) return;
      if (signedOut(error)) {
        revoked = true;
        clear();
        load = { state: "signed_out" };
      } else if (isObject(error) && error.status === 429) {
        notice = refused(error);
        // eslint-disable-next-line no-restricted-syntax -- Only three automatic read attempts after a budget refusal; writes are never replayed.
        retry(touchedDeal);
      } else {
        if (isObject(error) && isObject(error.payload) && error.payload.error === "source_version_changed") {
          reviewed.clear();
          details.clear();
        }
        notice = refused(error);
        writing = false;
        await refresh({ preserveSelection: true, touchedDeal });
      }
    } finally {
      writing = false;
      render();
    }
  }
  async function completeCall() {
    const sessions = new Map(items.map((row) => [row.call.session_id, row.call.source_version]));
    if ([...sessions.values()].some((version) => !version)) throw new Error("Call version unavailable");
    const latest = callAnswer(await options.client().readCallOutcomes());
    latest.calls
      .filter((call) => sessions.has(call.session_id))
      .forEach((call) => {
        if (call.source_version !== sessions.get(call.session_id))
          throw Object.assign(new Error("Call changed"), { payload: { error: "source_version_changed" } });
        if (
          call.open_cards.length ||
          call.applied.some(
            (candidate) => reviewed.get(`${call.session_id}:${candidate.candidate_id}`) !== appliedSignature(candidate),
          )
        )
          throw new Error("Call changed");
      });
    if (disposed || revoked) return;
    await Promise.all(
      [...sessions].map(async ([session_id, expected_source_version]) => {
        if (!expected_source_version) throw new Error("Call version unavailable");
        receipt(await options.client().reviewCallOutcome({ session_id, expected_source_version }));
      }),
    );
    if (disposed || revoked) return;
    clear();
    load = { state: "completed" };
  }
  async function decide(item: Item, accept: boolean) {
    if (decision) return;
    const resolver = item.candidate.resolver,
      client = options.client();
    if (
      !(resolver === "resolve-post-call-candidate" && client.resolvePostCallCandidate) &&
      !(resolver === "resolve-candidate" && client.resolveConfirm)
    )
      throw new Error("Decision unavailable");
    decision = {
      key: item.key,
      signature: item.signature,
      resolver,
      args: { candidate_id: item.candidate.candidate_id, accept, idempotency_key: crypto.randomUUID() },
    };
    await sendDecision();
  }
  async function sendDecision() {
    const request = decision;
    if (!request || disposed || revoked) return;
    const client = options.client();
    try {
      const { candidate_id, accept, idempotency_key } = request.args;
      const result =
        request.resolver === "resolve-post-call-candidate"
          ? await client.resolvePostCallCandidate?.({ ...request.args })
          : await client.resolveConfirm?.({ proposal_id: candidate_id, accept, idempotency_key });
      if (disposed || revoked) return;
      if (isObject(result) && result.ok === false) {
        decision = undefined;
        throw new Error("Decision refused");
      }
      if (
        !isObject(result) ||
        !(result.ok === true || (request.resolver === "resolve-candidate" && result.status === "ok"))
      )
        throw new Error("Decision receipt unavailable");
      decision = undefined;
      deciding = undefined;
    } catch (error) {
      if (disposed || revoked) return;
      if (isObject(error) && !error.pendingRequest && (error.writeRefusal === true || signedOut(error)))
        decision = undefined;
      throw error;
    }
  }
  async function checkOutcome() {
    if (!decision || writing || inFlight || disposed || revoked) return;
    await refresh();
    if (!decision || disposed || revoked || load.state !== "ready") return;
    const item = items.find((item) => item.key === decision?.key);
    if (!item || item.signature !== decision.signature) {
      notice = "The proposal changed. Refresh to check its outcome. The original decision is still held.";
      render();
      return;
    }
    const action = decision.args.accept ? "approve" : "skip";
    await act(sendDecision, (error) => decisionError(error, action), item.candidate.deal_id);
  }
  function decisionError(error: unknown, action: "approve" | "skip") {
    return decision
      ? "The decision outcome is unknown. Check outcome before making another decision."
      : decisionRefusal(error, action);
  }
  function proposalText(candidate: Candidate) {
    if (candidate.kind === "next_step" || candidate.kind === "phase_move") return options.describe(candidate);
    return (
      candidate.payload.action ||
      candidate.payload.subject ||
      candidate.payload.summary ||
      candidate.payload.text ||
      "Open the decision card for the full proposal."
    );
  }
  function renderGuide() {
    const item = current(),
      index = item ? items.indexOf(item) : 0;
    const ready = load.state === "ready" && !writing && !inFlight;
    const deals = [...new Set(items.flatMap((row) => (row.candidate.deal_id ? [row.candidate.deal_id] : [])))];
    const done = items.filter(complete).length;
    return (
      <section
        className="call-review"
        aria-label="Review this call"
        data-review-candidate={item?.candidate.candidate_id}
      >
        <link rel="stylesheet" href="/css/call-review.css" />
        <h2>Review this call</h2>
        {load.state === "loading" && <p role="status">Loading call review…</p>}
        {load.state === "completed" && <p role="status">Call review complete.</p>}
        {load.state === "empty" && <p role="status">No call items to review.</p>}
        {load.state === "signed_out" && <p role="status">Sign in again to review this call.</p>}
        {load.state === "retrying" && (
          <>
            <p role="status">
              The call review is taking a short break. Trying again automatically. Your place in this review is kept.
            </p>
            <p aria-hidden="true">
              Trying again automatically in {Math.max(0, Math.ceil((load.resumesAt - Date.now()) / 1000))}{" "}
              {load.resumesAt - Date.now() > 1000 ? "seconds" : "second"}.
            </p>
          </>
        )}
        {load.state === "paused" && (
          <p role="status">
            The call review is still busy. Try Refresh call review in a minute. Your place in this review is kept.
          </p>
        )}
        {load.state === "unavailable" && <p role="alert">{load.message}</p>}
        {notice && <p role="alert">{notice}</p>}
        {["ready", "retrying", "paused"].includes(load.state) && item && (
          <>
            <p className="call-review-meta">
              {options.dateLabel?.(item.call.call_date) ?? item.call.call_date} · Item {index + 1} of {items.length}
            </p>
            <p className="call-review-progress-label">
              {done} of {items.length} reviewed
            </p>
            <progress aria-label="Call review progress" value={done} max={items.length} />
            <p className="call-review-deal-position">
              {item.candidate.deal_id
                ? `Deal ${deals.indexOf(item.candidate.deal_id) + 1} of ${deals.length}`
                : "No deal linked"}
            </p>
            <h3>{item.candidate.deal_name || (item.candidate.deal_id ? "Deal" : "No deal")}</h3>
            <p className="call-review-meta">
              {item.state === "pending"
                ? "Needs your decision"
                : item.state === "resolved"
                  ? "No longer pending"
                  : item.state === "applied" && item.candidate.undone_at
                    ? "Undone"
                    : "Already applied"}
            </p>
            <dl>
              <div>
                <dt>Before</dt>
                <dd>{item.before}</dd>
              </div>
              <div>
                <dt>{item.state === "pending" ? "Proposed" : "From this call"}</dt>
                <dd>{proposalText(item.candidate)}</dd>
              </div>
            </dl>
            <blockquote aria-label="What was said">
              {item.candidate.evidence_quote || "No transcript quote included. Check the full report below."}
            </blockquote>
            <div className="call-review-actions">
              {item.state === "applied" && (
                <button
                  type="button"
                  className="primary"
                  disabled={!ready || complete(item)}
                  onClick={() => {
                    reviewed.set(item.key, item.signature);
                    selected = outstanding()?.key ?? item.key;
                    notice = "";
                    render();
                  }}
                >
                  Reviewed
                </button>
              )}
              {item.state === "applied" && !item.candidate.undone_at && (
                <button
                  type="button"
                  className="secondary"
                  data-call-undo={item.candidate.candidate_id}
                  disabled={!ready}
                  onClick={() =>
                    void act(
                      () =>
                        options.client().undoCallChange({
                          candidate_id: item.candidate.candidate_id,
                          base_version: item.candidate.deal_version,
                        }),
                      options.undoRefusal,
                      item.candidate.deal_id,
                    )
                  }
                >
                  Undo
                </button>
              )}
              {item.state === "pending" && (
                <button
                  type="button"
                  className={deciding === item.key ? "secondary" : "primary"}
                  disabled={!ready}
                  onClick={() => {
                    deciding = item.key;
                    render();
                    container.querySelector(".call-review-decision")?.scrollIntoView({ block: "nearest" });
                  }}
                >
                  Approve or fix this item
                </button>
              )}
              {item.candidate.deal_id && (
                <a className="call-outcome-link" href={`/deals?deal=${encodeURIComponent(item.candidate.deal_id)}`}>
                  Open deal to fix
                </a>
              )}
            </div>
            {item.state === "pending" && deciding === item.key && (
              <section className="call-review-decision" aria-label="Decide this item">
                <h4>Decide this item</h4>
                {item.candidate.payload.body && <p className="call-review-body">{item.candidate.payload.body}</p>}
                {item.candidate.payload.assignee && (
                  <p>
                    Assigned to {partnerNames[item.candidate.payload.assignee] ?? item.candidate.payload.assignee} ·{" "}
                    {item.candidate.payload.due_on
                      ? (options.dateLabel?.(item.candidate.payload.due_on) ?? item.candidate.payload.due_on)
                      : "No due date"}
                  </p>
                )}
                <p>Check the proposal and quote above. Approve it, or skip it and make any correction on the deal.</p>
                <div className="call-review-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={!ready || !!decision}
                    onClick={() =>
                      void act(
                        () => decide(item, true),
                        (error) => decisionError(error, "approve"),
                        item.candidate.deal_id,
                      )
                    }
                  >
                    Approve item
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={!ready || !!decision}
                    onClick={() =>
                      void act(
                        () => decide(item, false),
                        (error) => decisionError(error, "skip"),
                        item.candidate.deal_id,
                      )
                    }
                  >
                    Skip item
                  </button>
                </div>
                <p className="call-review-meta">Email proposals create drafts only.</p>
              </section>
            )}
            {item.state === "pending" && (
              <p className="call-review-meta">This item stays outstanding until its decision is recorded.</p>
            )}
            <nav aria-label="Call review navigation">
              <button
                type="button"
                className="secondary"
                disabled={!ready || index === 0}
                onClick={() => {
                  deciding = undefined;
                  selected = items[Math.max(index - 1, 0)]?.key;
                  notice = "";
                  render();
                }}
              >
                Back
              </button>
              <button
                type="button"
                className="secondary"
                disabled={!ready || index === items.length - 1}
                onClick={() => {
                  deciding = undefined;
                  selected = items[Math.min(index + 1, items.length - 1)]?.key;
                  notice = "";
                  render();
                }}
              >
                Next
              </button>
              <button
                type="button"
                className="primary"
                disabled={
                  !ready || items.some((row) => !row.call.source_version || row.state === "pending" || !complete(row))
                }
                onClick={() =>
                  void act(completeCall, (error) =>
                    isObject(error) && isObject(error.payload) && error.payload.error === "source_version_changed"
                      ? "This call outcome changed elsewhere. Review the reloaded call before completing it."
                      : "Could not complete this call review. Refresh and check outstanding items before retrying.",
                  )
                }
              >
                Complete call review
              </button>
            </nav>
            <p className="call-review-meta">Check each item before completing the call review.</p>
            {items.some((row) => !row.call.source_version) && (
              <p role="status">
                This call cannot be completed until its current version is available. Refresh call review to check
                again.
              </p>
            )}
          </>
        )}
        {decision && (
          <button
            type="button"
            className="primary"
            disabled={writing || !!inFlight || load.state !== "ready"}
            onClick={() => void checkOutcome()}
          >
            Check outcome
          </button>
        )}
        {load.state !== "completed" && (
          <button
            type="button"
            className="secondary"
            disabled={writing || load.state === "loading" || load.state === "signed_out" || load.state === "retrying"}
            onClick={() => void refresh()}
          >
            Refresh call review
          </button>
        )}
      </section>
    );
  }
  render();
  const invalidate = () => {
    revoked = true;
    sequence++;
    cancelWait();
    details.clear();
    clear();
    load = { state: "signed_out" };
    render();
  };
  container.ownerDocument.defaultView?.addEventListener("doctorcre-session-invalidated", invalidate);
  return {
    refresh,
    dispose() {
      disposed = true;
      sequence++;
      cancelWait();
      details.clear();
      clear();
      container.ownerDocument.defaultView?.removeEventListener("doctorcre-session-invalidated", invalidate);
      root.unmount();
      container.hidden = true;
    },
  };
}

export function mountCallReviewDialog(document: Document, options: Omit<Options, "sessionId" | "filter">) {
  const dialog = document.createElement("dialog");
  dialog.className = "call-review-dialog";
  dialog.setAttribute("aria-label", "Filed call review");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "call-review-close";
  close.textContent = "Close call review";
  close.addEventListener("click", () => dialog.close());
  const node = document.createElement("div");
  const toolbar = document.createElement("header");
  toolbar.className = "call-review-toolbar";
  const docSlot = document.createElement("div");
  docSlot.setAttribute("data-doc-presence-slot", "");
  toolbar.append(docSlot, close);
  dialog.append(toolbar, node);
  document.body.append(dialog);
  let guide: ReturnType<typeof mountCallReview> | undefined,
    session: string | undefined,
    disposed = false;
  return {
    async open(sessionId: string) {
      if (disposed) return;
      if (session !== sessionId) {
        guide?.dispose();
        session = sessionId;
        guide = mountCallReview(node, { ...options, sessionId });
      }
      if (!dialog.open) dialog.showModal();
      await guide?.refresh();
    },
    dispose() {
      disposed = true;
      guide?.dispose();
      dialog.remove();
    },
  };
}
