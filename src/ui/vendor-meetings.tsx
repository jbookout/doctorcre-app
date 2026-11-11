import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { MeetingPage, MeetingQuery } from "./vendor-meetings-client.ts";
import { parseMeetingPage, researchReason } from "./vendor-meetings-client.ts";

type Options = {
  load: (query: MeetingQuery, signal: AbortSignal) => Promise<unknown>;
  href: (id: string) => string;
  open: (href: string, returnFocusId: string) => void;
};
type State = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; page: MeetingPage };
function VendorMeetings({ options }: { options: Options }) {
  const [query, setQuery] = useState<MeetingQuery>({ view: "suggested", q: "", limit: 5 });
  const [state, setState] = useState<State>({ kind: "loading" });
  const generation = useRef(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = useRef<AbortController | null>(null);
  function change(next: MeetingQuery) {
    generation.current++;
    active.current?.abort();
    setState({ kind: "loading" });
    setQuery(next);
  }
  useEffect(() => {
    const ticket = ++generation.current;
    const controller = new AbortController();
    active.current = controller;
    // eslint-disable-next-line no-restricted-syntax -- One 350 ms search debounce per panel, cancelled on query change or unmount.
    const timer = setTimeout(
      () => {
        void options
          .load(query, controller.signal)
          .then((value) => {
            if (ticket !== generation.current || controller.signal.aborted) return;
            const page = parseMeetingPage(value, query);
            setState({ kind: "ready", page });
          })
          .catch(() => {
            if (ticket === generation.current && !controller.signal.aborted) setState({ kind: "failed" });
          });
      },
      query.q ? 350 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
      generation.current++;
    };
  }, [options, query]);
  return (
    <section aria-label="People worth meeting">
      <header>
        <p>Named people with a reason to meet and a verified office.</p>
      </header>
      <div role="tablist" aria-label="Vendor meetings">
        {(["suggested", "research"] satisfies MeetingQuery["view"][]).map((view, index) => (
          <button
            key={view}
            ref={(node) => {
              tabs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`vendor-meetings-${view}`}
            aria-controls="vendor-meetings-results"
            aria-selected={query.view === view}
            tabIndex={query.view === view ? 0 : -1}
            onClick={() => {
              if (query.view !== view) change({ view, q: query.q, limit: 5 });
            }}
            onKeyDown={(event) => {
              const target =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? 1
                    : event.key === "ArrowLeft" || event.key === "ArrowRight"
                      ? 1 - index
                      : null;
              if (target === null) return;
              event.preventDefault();
              tabs.current[target]?.click();
              tabs.current[target]?.focus();
            }}
          >
            {view === "suggested" ? "Suggested" : "Research"}
          </button>
        ))}
      </div>
      <label className="field">
        Search people and offices
        <input
          type="search"
          maxLength={80}
          value={query.q}
          onChange={(event) => change({ view: query.view, q: event.currentTarget.value, limit: 5 })}
        />
      </label>
      <div
        role="tabpanel"
        id="vendor-meetings-results"
        aria-labelledby={`vendor-meetings-${query.view}`}
        aria-busy={state.kind === "loading"}
      >
        {state.kind === "loading" && <p role="status">Loading people…</p>}
        {state.kind === "failed" && (
          <>
            <p role="alert">People could not be loaded. Try again.</p>
            <button
              type="button"
              className="action"
              onClick={() => {
                generation.current++;
                setState({ kind: "loading" });
                setQuery({ ...query });
              }}
            >
              Retry people
            </button>
          </>
        )}
        {state.kind === "ready" && (
          <>
            {state.page.calendar.state === "unavailable" && (
              <p role="status">Calendar unavailable. People and office details are still shown.</p>
            )}
            {state.page.calendar.notes?.map((note) => (
              <p key={note} className="note-summary">
                {note}
              </p>
            ))}
            <p role="status">
              {state.page.total} {query.view === "suggested" ? "suggested people" : "people needing research"}. Showing{" "}
              {state.page.items.length}.
            </p>
            {state.page.items.length === 0 && (
              <p>
                {query.view === "suggested"
                  ? "No suggested people match this search. Open Research to see what is missing."
                  : "No people need research for this search."}
              </p>
            )}
            <ul className="vendor-meetings-list">
              {state.page.items.map((row, index) => (
                <li
                  key={`${row.vendor_id}-${row.contact?.id ?? "company"}`}
                  data-meeting-person={row.contact?.id ?? ""}
                >
                  <a
                    id={`vendor-meeting-person-${index}`}
                    href={options.href(row.vendor_id)}
                    onClick={(event) => {
                      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
                        return;
                      event.preventDefault();
                      options.open(event.currentTarget.href, event.currentTarget.id);
                    }}
                  >
                    {row.contact?.name || "Named contact not recorded"}
                  </a>
                  <p>{row.company?.name || "Company not recorded"}</p>
                  <p data-meeting-office>
                    {row.office
                      ? `${row.office.street_address}, ${row.office.city}, ${row.office.state}`
                      : "Verified office not recorded"}
                  </p>
                  {row.office && <p className="note-summary">Office source: {row.office.source}</p>}
                  <p data-meeting-reason>{row.reason || "Meeting reason not recorded"}</p>
                  <p>{row.contact?.email || "Email not recorded"}</p>
                  <p>{row.contact?.phone || row.contact?.cell || "Phone not recorded"}</p>
                  {row.missing.length > 0 && (
                    <ul aria-label="Research needed">
                      {row.missing.map((reason) => (
                        <li key={reason}>{researchReason(reason)}</li>
                      ))}
                    </ul>
                  )}
                  {row.possible_meetings.length > 0 ? (
                    <>
                      <h3>Possible meetings</h3>
                      <ul>
                        {row.possible_meetings.map((meeting) => (
                          <li key={`${meeting.title}-${meeting.start}-${meeting.end}-${meeting.location}`}>
                            {meeting.title} · <time dateTime={meeting.start}>{meeting.start}</time> to{" "}
                            <time dateTime={meeting.end}>{meeting.end}</time>
                            {meeting.location ? ` · ${meeting.location}` : ""}
                          </li>
                        ))}
                      </ul>
                      <p className="note-summary">Check Outlook before relying on these meetings.</p>
                    </>
                  ) : (
                    state.page.calendar.state !== "unavailable" && <p>No possible meetings recorded for this person.</p>
                  )}
                </li>
              ))}
            </ul>
            {state.page.has_more && (
              <button
                type="button"
                className="action"
                onClick={() => {
                  if (state.page.next_cursor) change({ ...query, cursor: state.page.next_cursor });
                }}
              >
                Next people
              </button>
            )}
            {query.cursor && (
              <button
                type="button"
                className="action"
                onClick={() => change({ view: query.view, q: query.q, limit: 5 })}
              >
                Back to first people
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
export function mountVendorMeetings(host: HTMLElement, options: Options) {
  const root = createRoot(host);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("doctorcre-session-invalidated", dispose);
    flushSync(() => root.unmount());
  };
  window.addEventListener("doctorcre-session-invalidated", dispose);
  flushSync(() =>
    root.render(
      <details className="module-card glass vendor-meetings" open={!window.matchMedia("(max-width: 767px)").matches}>
        <summary>
          <h2>People worth meeting</h2>
        </summary>
        <VendorMeetings options={options} />
      </details>,
    ),
  );
  return { dispose };
}
