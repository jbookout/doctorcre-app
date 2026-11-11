import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes, useLocation, useParams } from "react-router";
import { HomeWatchDetail } from "../watches/home-detail.tsx";
import { BulkControls } from "./bulk-controls";
import {
  type Action,
  type Command,
  command,
  type InboxClient,
  type InboxItem,
  type ItemResult,
  type Snapshot,
  shelves,
  type TaskReceipt,
  taskCommand,
} from "./inbox";
import { MailPriorities } from "./mail-priorities";
import { MorningBrief } from "./morning-brief";
import { ReviewCard } from "./review-card";
import { recordRoutes } from "./routes";
import { completionLabel, HomeSections, HomeWelcome } from "./sections";
import { WaitingEditor } from "./waiting-editor";

type SnoozePreview = Readonly<{
  items: readonly InboxItem[];
  choices: ReadonlyArray<Readonly<{ hours: number; until: string; label: string }>>;
  error: string;
}>;
type Pending = { request: Command; before: readonly InboxItem[]; undoing?: true };
type Undo = { action: Action | "reopen"; items: readonly InboxItem[]; until?: string; receipt?: TaskReceipt };
const queryKey = ["home-inbox"];
const visibleRow = (node: HTMLElement) => !node.closest("details:not([open])") && node.getClientRects().length > 0;
export function inboxRefusal(code: unknown): string {
  switch (code) {
    case "version_conflict":
      return "This card changed on the server. Dismiss and refresh before another action.";
    case "invalid_completion":
      return "This completion can no longer be undone. Refresh to review the task.";
    case "action_not_found":
      return "This task is no longer available. Refresh to review current work.";
    case "action_not_open":
      return "This task is no longer open. Refresh to review its current state.";
    case "partner_required":
    case "human_only_verb_requires_verified_partner":
    case "unattended_runner_authority_not_admitted":
      return "Sign in as a verified partner before changing this task.";
    case "invalid_action_id":
    case "invalid_base_version":
      return "This task could not be identified safely. Refresh before another action.";
    case "key_reuse":
      return "This request does not match its original attempt. Dismiss and refresh before another action.";
    default:
      return "The server did not confirm this change. Retry the same request or dismiss and refresh.";
  }
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Result uncertain. Retry the same request.";
export function markHomeReady(host: HTMLElement) {
  if (host.dataset.homeReady) return;
  host.dataset.homeReady = "true";
  host.dispatchEvent(new Event("doctorcre:home-ready"));
}
function Inbox({ client }: { client: InboxClient }) {
  const route = useLocation();
  const home = route.pathname === "/";
  const { item_id: inboxItemId } = useParams();
  const item_id = home ? new URLSearchParams(route.search).get("card") || undefined : inboxItemId;
  const cache = useQueryClient();
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => client.read(signal),
    // eslint-disable-next-line no-restricted-syntax -- One read per 60000ms while visible and online; paused during writes and cleared on unmount by Query.
    refetchInterval: () =>
      navigator.onLine && document.visibilityState === "visible" && !inFlight.current ? 60_000 : false,
  });
  useEffect(() => {
    const host = document.getElementById("homeRoot");
    if (home && !query.isPending && host) markHomeReady(host);
  }, [home, query.isPending]);
  const [reviewing, setReviewing] = useState<InboxItem | null>(null);
  const reviewOpener = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (!reviewing && reviewOpener.current) {
      if (reviewOpener.current.isConnected) reviewOpener.current.focus();
      else root.current?.querySelector<HTMLElement>("[data-inbox-row] h3 a")?.focus();
    }
  }, [reviewing]);
  const [search, setSearch] = useState("");
  const [searchNotice, setSearchNotice] = useState("");
  const [selected, select] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  const [singleBusy, setBusy] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const busy = singleBusy || batchBusy;
  const [notice, setNotice] = useState("");
  const [failures, setFailures] = useState<ItemResult[]>([]);
  const [undo, setUndo] = useState<Undo[]>([]);
  const [snooze, setSnooze] = useState<SnoozePreview | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const root = useRef<HTMLElement>(null);
  const gesture = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    mounted.current = true;
    let lastRefresh = -Infinity;
    const refresh = () => {
      if (
        !navigator.onLine ||
        document.visibilityState !== "visible" ||
        inFlight.current ||
        cache.getQueryState(queryKey)?.fetchStatus === "fetching" ||
        Date.now() - lastRefresh < 1000
      )
        return;
      lastRefresh = Date.now();
      void query.refetch({ cancelRefetch: false });
    };
    const update = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) refresh();
    };
    // eslint-disable-next-line no-restricted-syntax -- At most one read per 1000ms only on focus; overlapping reads and writes suppress it.
    addEventListener("focus", refresh);
    // eslint-disable-next-line no-restricted-syntax -- At most one read per 1000ms only on visible return; hidden and offline views send none.
    document.addEventListener("visibilitychange", refresh);
    // eslint-disable-next-line no-restricted-syntax -- At most one read per 1000ms only on reconnect; never runs a mutation.
    addEventListener("online", update);
    addEventListener("offline", update);
    return () => {
      mounted.current = false;
      removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      removeEventListener("online", update);
      removeEventListener("offline", update);
    };
  }, [cache, query.refetch]);
  const snoozeOpener = useRef<HTMLElement | null>(null);
  const [snoozeCancelled, setSnoozeCancelled] = useState(0);
  function openSnooze(items: readonly InboxItem[]) {
    const openedAt = Date.now();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    });
    setSnooze({
      items,
      error: "",
      choices: [1, 24].map((hours) => {
        const until = new Date(openedAt + hours * 3_600_000).toISOString();
        return { hours, until, label: formatter.format(new Date(until)) };
      }),
    });
  }
  function cancelSnooze() {
    setSnooze(null);
    setSnoozeCancelled((value) => value + 1);
  }
  useLayoutEffect(() => {
    if (snoozeCancelled) snoozeOpener.current?.focus();
  }, [snoozeCancelled]);
  const [focusTargets, setFocusTargets] = useState<string[] | null>(null);
  function focusRow(preferred: string[] = []) {
    setFocusTargets([...preferred]);
  }
  useLayoutEffect(() => {
    if (!focusTargets) return;
    const links = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-inbox-row] h3 a") || []).filter(
      visibleRow,
    );
    const target =
      focusTargets
        .map((id) => links.find((node) => node.closest<HTMLElement>("[data-inbox-row]")?.dataset.inboxRow === id))
        .find(Boolean) ||
      links[0] ||
      root.current?.querySelector<HTMLElement>(".inbox-header button");
    target?.focus();
    target?.scrollIntoView({ block: "center" });
  }, [focusTargets]);
  function finishBatch() {
    const next = root.current?.querySelector<HTMLElement>(
      '.home-slice[aria-label="Needs your attention"] h3 a, .home-slice[aria-label="Today"] h3 a',
    );
    const target = next || root.current?.querySelector<HTMLElement>(".home-slice h2");
    target?.focus();
    target?.scrollIntoView({ block: "center" });
  }
  async function run(operation: Pending) {
    if (inFlight.current) return;
    setPending(operation);
    if (!navigator.onLine) {
      setNotice("Offline. No change was sent. Reconnect and retry the same request.");
      return;
    }
    const visible = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-inbox-row]") || [])
      .filter(visibleRow)
      .map((node) => node.dataset.inboxRow || "");
    const index = visible.indexOf(operation.before[0]?.item_id || "");
    const neighbours = [
      ...visible.slice(index + 1),
      ...visible.slice(0, index).reverse(),
      ...visible.slice(index, index + 1),
    ];
    inFlight.current = true;
    setBusy(true);
    setNotice("Waiting for server confirmation…");
    try {
      await cache.cancelQueries({ queryKey });
      if (!mounted.current) return;
      const results = await client.run(operation.request);
      if (!mounted.current) return;
      const successes = results.flatMap((result) => (result.ok ? [result.item] : []));
      const changed = results.flatMap((result) => (!result.ok && result.current_item ? [result.current_item] : []));
      const updates = [...successes, ...changed];
      const failed = results.filter((result) => !result.ok && !result.current_item);
      cache.setQueryData<Snapshot>(
        queryKey,
        (snapshot) =>
          snapshot
            ? {
                ...snapshot,
                items: snapshot.items.map((item) => updates.find((next) => next.item_id === item.item_id) || item),
              }
            : snapshot,
        { updatedAt: query.dataUpdatedAt },
      );
      setFailures(failed);
      select(new Set(failed.map((result) => result.item_id)));
      if ((successes.length || changed.length) && !operation.undoing) {
        setUndo((entries) => [
          ...entries.filter((entry) => !updates.some((item) => item.item_id === entry.items[0]?.item_id)),
          ...successes.flatMap<Undo>((item) => {
            const result = results.find((result) => result.ok && result.item_id === item.item_id);
            if (operation.request.action === "complete")
              return result?.ok && result.receipt?.completion_event_id
                ? [{ action: "reopen" as const, items: [item], receipt: result.receipt }]
                : [];
            const previous = operation.before.find((before) => before.item_id === item.item_id);
            return previous
              ? [
                  {
                    action:
                      previous.disposition === "settled"
                        ? "settle"
                        : previous.disposition === "snoozed"
                          ? "snooze"
                          : "unsettle",
                    items: [item],
                    ...(previous.snoozed_until ? { until: previous.snoozed_until } : {}),
                  },
                ]
              : [];
          }),
        ]);
      }
      const completion =
        operation.request.action === "complete" ? successes.map((item) => `Marked done: ${item.title}.`).join(" ") : "";
      const legacy = results.some((result) => result.ok && result.receipt && !result.receipt.completion_event_id)
        ? " Can't undo this completion. Its original receipt has no completion event."
        : "";
      setNotice(
        `${completion}${legacy} ${successes.length + changed.length} confirmed. ${changed.length ? `${changed.length} changed again after confirmation. Showing the latest state. Undo is unavailable for those cards. ` : ""}${failed.length ? `${failed.length} failed or uncertain. Kept for review.` : successes.length ? (operation.undoing ? "Undone." : legacy ? "Completion confirmed." : "You can undo this change.") : ""}`,
      );
      if (!failed.length) setPending(null);
      focusRow(operation.undoing ? operation.before.map((item) => item.item_id) : neighbours);
    } catch (error) {
      if (!mounted.current) return;
      const code =
        error &&
        typeof error === "object" &&
        "payload" in error &&
        error.payload &&
        typeof error.payload === "object" &&
        "error" in error.payload
          ? error.payload.error
          : null;
      if (
        typeof code === "string" &&
        ["version_conflict", "invalid_completion", "action_not_open", "action_not_found"].includes(code)
      ) {
        setPending(null);
        setNotice(`This task changed. ${inboxRefusal(code)} Nothing was overwritten.`);
        void query.refetch();
        focusRow(neighbours);
      } else
        setNotice(
          `Result uncertain. ${typeof code === "string" ? inboxRefusal(code) : message(error)} Retry the same request.`,
        );
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }
  function act(
    action: Action | "complete" | "reopen",
    items: readonly InboxItem[],
    until?: string,
    undoing = false,
    receipt?: TaskReceipt,
  ) {
    if (pending) {
      setNotice("Resolve or dismiss the previous request before starting another.");
      return;
    }
    const first = items[0];
    if (!first) return;
    try {
      void run({
        request:
          action === "complete" || action === "reopen"
            ? taskCommand(action, first, receipt)
            : command(action, items, until),
        before: items,
        ...(undoing ? { undoing: true as const } : {}),
      });
    } catch (error) {
      setNotice(message(error));
    }
  }
  const items = query.data?.items || [];
  const placed = shelves(items, item_id);
  const picked = items.filter((item) => selected.has(item.item_id));
  function row(item: InboxItem) {
    const primary =
      item.disposition === "settled" ? "Show in inbox" : item.disposition === "snoozed" ? "Wake" : "Hide from inbox";
    const completable = item.action_id !== null && item.source_state === "needs_attention";
    return (
      <article
        key={item.item_id}
        className="inbox-row"
        data-inbox-row={item.item_id}
        data-current={item_id === item.item_id || undefined}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          if (touch) gesture.current = { x: touch.clientX, y: touch.clientY };
        }}
        onTouchEnd={(event) => {
          const touch = event.changedTouches[0],
            start = gesture.current;
          gesture.current = null;
          if (
            !touch ||
            !start ||
            Math.abs(touch.clientY - start.y) > 45 ||
            Math.abs(touch.clientX - start.x) < 90 ||
            busy ||
            reviewing
          )
            return;
          if (touch.clientX > start.x && item.source_state !== "working")
            act(primary === "Hide from inbox" ? "settle" : "unsettle", [item]);
          else if (touch.clientX < start.x) {
            snoozeOpener.current = event.currentTarget.querySelector("h3 a");
            openSnooze([item]);
          }
        }}
      >
        <label className="inbox-select">
          <input
            type="checkbox"
            aria-label={`Select ${item.title}`}
            checked={selected.has(item.item_id)}
            disabled={busy || !!reviewing || item.source_state === "working"}
            onChange={(event) =>
              select((previous) => {
                const next = new Set(previous);
                if (event.target.checked) next.add(item.item_id);
                else next.delete(item.item_id);
                return next;
              })
            }
          />
        </label>
        <div className="inbox-copy">
          <p className="inbox-meta">
            <span>{item.kind_label}</span>
            <span className={`inbox-badge inbox-${item.source_state}`}>{item.source_state.replaceAll("_", " ")}</span>
          </p>
          <h3 className={item_id === item.item_id ? "inbox-title-expanded" : undefined}>
            <Link aria-current={item_id === item.item_id ? "true" : undefined} to={recordRoutes.card(item.item_id)}>
              {item.title}
            </Link>
          </h3>
          <p className="inbox-context">
            {item.context_label || "No linked deal"}
            {item.due_on && (
              <>
                {" "}
                · Due <time dateTime={item.due_on}>{item.due_on}</time>
              </>
            )}
          </p>
          <p className="inbox-detail">
            {item.disposition === "snoozed" && item.snoozed_until
              ? `Snoozed until ${new Date(item.snoozed_until).toLocaleString()}`
              : item.auto_settled || item.section === "done"
                ? completionLabel(item)
                : item.disposition === "settled"
                  ? "Hidden from inbox by you"
                  : item.source_state === "working"
                    ? "Dr. CRE is working. You can come back to this."
                    : item.source_state === "done"
                      ? completionLabel(item)
                      : "Ready for your attention"}
            {item.hold_until ? ` · On hold until ${item.hold_until}` : ""}
          </p>
          <WaitingEditor
            activity={(active) => {
              inFlight.current = active;
              setBusy(active);
              if (active) void cache.cancelQueries({ queryKey });
            }}
            item={item}
            client={client}
            disabled={busy || !!pending || !!reviewing}
            update={(next) =>
              cache.setQueryData<Snapshot>(queryKey, (snapshot) =>
                snapshot
                  ? { ...snapshot, items: snapshot.items.map((row) => (row.item_id === next.item_id ? next : row)) }
                  : snapshot,
              )
            }
          />
          {item_id === item.item_id && recordRoutes.source(item) && (
            <a className="inbox-source" href={recordRoutes.source(item) || undefined}>
              Open source record ↗
            </a>
          )}
          {item_id === item.item_id && item.source_type === "notification" && (
            <HomeWatchDetail open_url={item.open_url} />
          )}
          {item_id === item.item_id && item.open_url && !recordRoutes.source(item) && (
            <p role="status">Source record unavailable. Its destination is unsupported or invalid.</p>
          )}
        </div>
        <div className="inbox-actions">
          {home && item.review_reference && client.review && (
            <button
              type="button"
              disabled={busy || !!pending || !!reviewing}
              onClick={(event) => {
                reviewOpener.current = event.currentTarget;
                setReviewing(item);
              }}
            >
              Review card
            </button>
          )}
          {completable && (
            <button
              type="button"
              className="inbox-primary"
              disabled={busy || !!reviewing}
              onClick={() => act("complete", [item])}
            >
              Mark done
            </button>
          )}
          {item.source_state !== "working" && (
            <button
              type="button"
              disabled={busy || !!reviewing}
              onClick={() => act(primary === "Hide from inbox" ? "settle" : "unsettle", [item])}
            >
              {primary}
            </button>
          )}
          <button
            type="button"
            disabled={busy || !!reviewing}
            onClick={(event) => {
              snoozeOpener.current = event.currentTarget;
              openSnooze([item]);
            }}
          >
            Snooze
          </button>
        </div>
        {reviewing?.item_id === item.item_id && client.review && (
          <ReviewCard
            item={item}
            client={client.review}
            close={() => {
              setReviewing(null);
            }}
            busy={(value) => {
              inFlight.current = value;
              setBusy(value);
              if (value) void cache.cancelQueries({ queryKey });
            }}
            confirmed={(current, receipt) => {
              cache.setQueryData<Snapshot>(queryKey, (snapshot) =>
                snapshot
                  ? {
                      ...snapshot,
                      items: snapshot.items.map((row) => (row.item_id === current.item_id ? current : row)),
                    }
                  : snapshot,
              );
              if (receipt?.completion_event_id) {
                setUndo((entries) => [
                  ...entries.filter((entry) => entry.items[0]?.item_id !== current.item_id),
                  { action: "reopen", items: [current], receipt },
                ]);
                setNotice(`Marked done: ${current.title}. You can undo this change.`);
              }
            }}
          />
        )}
      </article>
    );
  }
  return (
    <section
      aria-label="Inbox cards"
      className={home ? "home-inbox" : undefined}
      ref={root}
      onKeyDown={(event) => {
        if (
          !["ArrowDown", "ArrowUp"].includes(event.key) ||
          !(event.target instanceof HTMLElement) ||
          !event.target.matches("[data-inbox-row] h3 a")
        )
          return;
        const links = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-inbox-row] h3 a") || []).filter(
          visibleRow,
        );
        const index = links.indexOf(event.target);
        const next = links[index + (event.key === "ArrowDown" ? 1 : -1)];
        if (next) {
          event.preventDefault();
          next.focus();
        }
      }}
    >
      {home && (
        <>
          <HomeWelcome />
          <MorningBrief />
          <MailPriorities
            items={items}
            locked={busy || !!pending || !!reviewing}
            review={(item, opener) => {
              reviewOpener.current = opener;
              setReviewing(item);
            }}
          />
        </>
      )}
      <header className="inbox-header">
        <div>
          <p className="inbox-eyebrow">YOUR WORKSPACE</p>
          {home ? <h2>Your inbox</h2> : <h1>Inbox</h1>}
          <p>Your attention, updates and work in progress.</p>
        </div>
        <button
          type="button"
          disabled={query.isFetching || busy || !!pending || !online}
          onClick={() => void query.refetch()}
        >
          Refresh inbox
        </button>
      </header>
      <div className="inbox-health" role="status">
        {!online
          ? "Offline · Inbox changes unavailable. Nothing will replay automatically."
          : query.isFetching
            ? "Updating inbox…"
            : query.isError
              ? "Update unavailable"
              : query.isStale
                ? "Snapshot may be stale · Refresh before acting."
                : "Up to date"}
        <span>Partner inbox</span>
      </div>
      {query.data && !query.data.auto_settle_enabled && (
        <p role="status">
          Automatic settlement unavailable. Showing the earlier inbox; completed items may still need review.
        </p>
      )}
      {notice && (
        <div className="inbox-notice" role="status">
          <p>{notice}</p>
          {failures.map(
            (result) =>
              !result.ok && (
                <p key={result.item_id}>
                  {items.find((item) => item.item_id === result.item_id)?.title || result.item_id} ·{" "}
                  {inboxRefusal(result.error)}
                </p>
              ),
          )}
          {pending && (
            <>
              <button type="button" disabled={busy || !online} onClick={() => void run(pending)}>
                Retry same request
              </button>
              <button
                type="button"
                disabled={busy || !!reviewing}
                onClick={() => {
                  setPending(null);
                  setFailures([]);
                  setNotice("Request dismissed. Refresh to check canonical state before another action.");
                  void query.refetch();
                }}
              >
                Dismiss and refresh
              </button>
            </>
          )}
          {!pending &&
            undo.map((previous) => (
              <button
                type="button"
                key={previous.items[0]?.item_id}
                disabled={busy || !!reviewing}
                onClick={() => {
                  setUndo((entries) => entries.filter((entry) => entry !== previous));
                  act(previous.action, previous.items, previous.until, true, previous.receipt);
                }}
              >
                {undo.length === 1 ? "Undo" : `Undo ${previous.items[0]?.title}`}
              </button>
            ))}
        </div>
      )}
      {query.isPending ? (
        <p className="inbox-empty" role="status">
          Loading your inbox…
        </p>
      ) : query.isError && !query.data ? (
        <div className="inbox-empty" role="alert">
          <h2>Inbox unavailable</h2>
          <p>{message(query.error)}</p>
          <p>Refresh to try again.</p>
        </div>
      ) : (
        <>
          {item_id && !placed.current && <p role="status">This card is not in your current inbox snapshot.</p>}
          {query.data?.truncated && <p role="status">Showing the first 1,000 cards. More work is available.</p>}
          {searchNotice && <p role="status">{searchNotice}</p>}
          {home ? (
            <HomeSections
              items={items}
              pinned={reviewing}
              current={reviewing?.item_id || item_id}
              search={search}
              locked={busy || !!pending || !!reviewing || !!snooze}
              changeSearch={(value) => {
                if (busy || pending || reviewing || snooze) return;
                setSearch(value);
                select(new Set());
                setSearchNotice(selected.size ? "Selection cleared because the search changed." : "");
              }}
              row={row}
            />
          ) : (
            <>
              <section className="inbox-section" aria-label="Inbox">
                <div className="inbox-section-title">
                  <h2>
                    Needs your attention <span>{placed.inbox.length}</span>
                  </h2>
                  <p>Mark done finishes a task. Hide from inbox leaves the task open.</p>
                </div>
                {placed.inbox.length ? (
                  placed.inbox.map(row)
                ) : (
                  <div className="inbox-empty">
                    <h3>You’re all caught up.</h3>
                    <p>New work will appear here. Your shelves stay below.</p>
                  </div>
                )}
              </section>
              {(["working", "held", "done", "snoozed", "settled"] as const).map((shelf) => (
                <details className="inbox-shelf" key={shelf} open={placed.current?.section === shelf || undefined}>
                  <summary>
                    <span>
                      {shelf === "working"
                        ? "Dr. CRE is working"
                        : shelf === "held"
                          ? "Held"
                          : shelf === "done"
                            ? "Done"
                            : shelf === "snoozed"
                              ? "Snoozed"
                              : "Settled"}
                    </span>
                    <span>{placed[shelf].length}</span>
                  </summary>
                  {placed[shelf].length ? (
                    placed[shelf].map(row)
                  ) : (
                    <p className="inbox-shelf-empty">Nothing here right now.</p>
                  )}
                </details>
              ))}
            </>
          )}
        </>
      )}
      {home ? (
        <BulkControls
          finish={finishBatch}
          client={client}
          picked={picked}
          selected={selected}
          locked={singleBusy || !!pending || !!reviewing || !online}
          select={select}
          snapshot={(value) => cache.setQueryData(queryKey, value)}
          prepare={() => cache.cancelQueries({ queryKey })}
          lock={(value) => {
            inFlight.current = value;
            setBatchBusy(value);
          }}
        />
      ) : (
        picked.length > 0 && (
          <div role="toolbar" className="inbox-bulk" aria-label="Selected cards">
            <strong>{picked.length} selected</strong>
            <button
              type="button"
              disabled={busy || !!reviewing || picked.length > 100}
              onClick={() => act("settle", picked)}
            >
              Hide selected
            </button>
            <button
              type="button"
              disabled={busy || !!reviewing || picked.length > 100}
              onClick={() => act("unsettle", picked)}
            >
              Show selected
            </button>
            <button
              type="button"
              disabled={busy || !!reviewing || picked.length > 100}
              onClick={(event) => {
                snoozeOpener.current = event.currentTarget;
                openSnooze(picked);
              }}
            >
              Snooze selected
            </button>
            <button type="button" onClick={() => select(new Set())}>
              Clear
            </button>
          </div>
        )
      )}
      {snooze && (
        <dialog
          className="inbox-snooze"
          ref={(node) => {
            if (node && !node.open) node.showModal();
          }}
          onCancel={() => {
            cancelSnooze();
          }}
          aria-label="Snooze cards"
        >
          <h2>Snooze {snooze.items.length === 1 ? "card" : `${snooze.items.length} cards`}</h2>
          <p>Choose when this returns to your inbox. All times are Central.</p>
          {snooze.error && <p role="alert">{snooze.error}</p>}
          {snooze.choices.map((choice) => (
            <button
              type="button"
              ref={(button) => {
                if (choice.hours === 1) button?.focus();
              }}
              key={choice.hours}
              onClick={() => {
                if (Date.parse(choice.until) <= Date.now()) {
                  setSnooze({
                    ...snooze,
                    error: "This return time has passed. Cancel and reopen Snooze to choose a new time.",
                  });
                  return;
                }
                const rows = snooze.items;
                setSnooze(null);
                act("snooze", rows, choice.until);
              }}
            >
              {choice.hours === 1 ? "1 hour" : "24 hours"} · <time dateTime={choice.until}>{choice.label}</time>
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              cancelSnooze();
            }}
          >
            Cancel
          </button>
        </dialog>
      )}
      <footer className="inbox-footer">
        Use ↑ ↓ to move between cards. On your phone, swipe right to hide or wake, left to snooze.
      </footer>
    </section>
  );
}
export function mountInbox(host: HTMLElement, client: InboxClient) {
  const query = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 0,
        // eslint-disable-next-line no-restricted-syntax -- Single refresh lifecycle owns automatic reads; Query retries and built-in focus/reconnect reads are disabled.
        retry: false,
        refetchOnWindowFocus: false,
        // eslint-disable-next-line no-restricted-syntax -- Single refresh lifecycle owns automatic reads; Query retries and built-in focus/reconnect reads are disabled.
        refetchOnReconnect: false,
        networkMode: "always",
      },
      // eslint-disable-next-line no-restricted-syntax -- Single refresh lifecycle owns automatic reads; Query retries and built-in focus/reconnect reads are disabled.
      mutations: { retry: false, networkMode: "always" },
    },
  });
  const root = createRoot(host);
  const inbox: ReactNode = <Inbox client={client} />;
  root.render(
    <QueryClientProvider client={query}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={inbox} />
          <Route path="/inbox" element={inbox} />
          <Route path="/inbox.html" element={inbox} />
          <Route path="/inbox/card/:item_id" element={inbox} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>,
  );
  addEventListener(
    "doctorcre-session-invalidated",
    () => {
      query.clear();
      root.unmount();
    },
    { once: true },
  );
}
