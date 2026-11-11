import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

type Entry = {
  key: string;
  type: string;
  day: string;
  label: string;
  time?: string;
  start?: string;
  end?: string;
  location?: string;
  deal_id?: string;
  deal_name?: string;
};
type Day = { day: string; dated: Entry[]; allDay: Entry[]; timed: Entry[] };
type Calendar = { state: string; items: unknown[]; notes?: unknown[] } | null;
const sibling = (path: string) => import(new URL(path, import.meta.url).href);
const label = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

export async function mountWorkingWeek(host: HTMLElement) {
  const [{ homeWeek }, { localToday }, { agendaSnapshot }] = await Promise.all([
    sibling("./home-week.js"),
    sibling("./calendar-model.js"),
    sibling("./home-dashboard-model.js"),
  ]);
  let returnFocus: unknown = history.state?.workingWeekFocus;
  const root = createRoot(host);
  const dialog = document.createElement("dialog");
  dialog.className = "working-week-detail";
  dialog.setAttribute("aria-label", "Calendar item details");
  document.body.append(dialog);
  let days: Day[] = [],
    viewedDay: string = new URL(location.href).searchParams.get("homeDay") || localToday(),
    selected: Entry | null = null,
    retired = false;
  let calendar: Calendar = null,
    agendaAvailable = false;
  const restore = () => {
    const key = selected?.key;
    selected = null;
    flushSync(() => details.render(null));
    const opener = [...host.querySelectorAll<HTMLButtonElement>("[data-week-entry]")].find(
      (node) => node.dataset.weekEntry === key,
    );
    (opener || host.querySelector<HTMLButtonElement>('[aria-pressed="true"]'))?.focus();
  };
  dialog.addEventListener("close", restore);
  const close = () => {
    if (dialog.open) dialog.close();
  };
  const open = (entry: Entry) => {
    selected = entry;
    history.replaceState({ ...history.state, workingWeekFocus: entry.key }, "", location.href);
    flushSync(() =>
      details.render(
        <>
          <h2>{entry.label}</h2>
          <p>{label(entry.day)}</p>
          {entry.start && (
            <p>
              <time dateTime={entry.start}>{entry.time}</time>
              {entry.end && (
                <>
                  {" "}
                  to{" "}
                  <time dateTime={entry.end}>
                    {entry.time === "All day"
                      ? `${entry.end.slice(0, 10)} (exclusive)`
                      : new Date(entry.end).toLocaleString("en-US", {
                          timeZone: "America/Chicago",
                          timeZoneName: "short",
                        })}
                  </time>
                </>
              )}
            </p>
          )}
          <p>{entry.type === "meeting" ? entry.location || "Place not provided" : entry.deal_name}</p>
          {entry.type !== "meeting" && entry.deal_id && (
            <a href={`/deals?deal=${encodeURIComponent(entry.deal_id)}`}>Open deal</a>
          )}
          <button type="button" onClick={close}>
            Return to day
          </button>
        </>,
      ),
    );
    dialog.showModal();
  };
  const details = createRoot(dialog);
  const paint = () => {
    const day = days.find((day) => day.day === viewedDay);
    const entries = day ? [...day.dated, ...day.allDay, ...day.timed] : [];
    flushSync(() =>
      root.render(
        <section className="working-week" aria-label="Working week">
          <h2>Your working week</h2>
          {retired ? (
            <p role="status">Session ended. Sign in again to see your week.</p>
          ) : (
            <>
              <p>
                Returned work · {days[0]?.day} to {days.at(-1)?.day} · America/Chicago
              </p>
              <p role="status">
                {calendar
                  ? calendar.state === "partial"
                    ? "Calendar coverage is incomplete. Check Outlook for changes."
                    : "Upcoming calendar snapshot. Coverage outside returned meetings is not confirmed."
                  : "Calendar unavailable. Check Outlook for meetings."}
                {!agendaAvailable && " Dated deal work unavailable."}
              </p>
              {calendar?.notes?.length ? (
                <details>
                  <summary>Calendar coverage</summary>
                  <ul>
                    {[...new Set(calendar.notes)]
                      .filter((note): note is string => typeof note === "string")
                      .map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                  </ul>
                </details>
              ) : null}
              <fieldset className="working-week-days" aria-label="Choose working day">
                {days.map((day) => (
                  <button
                    type="button"
                    key={day.day}
                    aria-label={`${label(day.day).slice(0, 3)} ${Number(day.day.slice(-2))} ${label(day.day)}`}
                    aria-pressed={day.day === viewedDay}
                    onClick={() => {
                      viewedDay = day.day;
                      const url = new URL(location.href);
                      url.searchParams.set("homeDay", viewedDay);
                      history.replaceState(history.state, "", url);
                      paint();
                    }}
                  >
                    <span>
                      {new Date(`${day.day}T12:00:00Z`).toLocaleDateString("en-US", {
                        timeZone: "UTC",
                        weekday: "short",
                      })}
                    </span>
                    <strong>{Number(day.day.slice(-2))}</strong>
                  </button>
                ))}
              </fieldset>
              <h3>{label(viewedDay)}</h3>
              <div className="working-week-items">
                {entries.map((entry) => (
                  <button type="button" key={entry.key} data-week-entry={entry.key} onClick={() => open(entry)}>
                    <small>{entry.time || "Dated deal work"}</small>
                    <strong>{entry.label}</strong>
                    {entry.deal_name && <span>{entry.deal_name}</span>}
                  </button>
                ))}
                {!entries.length && <p>No returned items for this day. This does not confirm availability.</p>}
              </div>
              <a href="/review-workflows#homeCalendar">Open calendar workflows</a>
            </>
          )}
        </section>,
      ),
    );
  };
  return {
    render(value: Calendar, source: { board: unknown; details: Map<string, unknown> } | null) {
      if (retired) return;
      calendar = value;
      const agenda = source?.board ? agendaSnapshot(source.board, source.details) : null;
      agendaAvailable = Boolean(agenda && !agenda.failed.length);
      days = homeWeek({ agenda, calendar, today: localToday() });
      if (!days.some((day) => day.day === viewedDay)) viewedDay = days[0]?.day || localToday();
      const next = days
        .flatMap((day) => [...day.dated, ...day.allDay, ...day.timed])
        .find((entry) => entry.key === selected?.key);
      if (selected && JSON.stringify(next) !== JSON.stringify(selected)) close();
      paint();
      if (typeof returnFocus === "string") {
        const opener = [...host.querySelectorAll<HTMLButtonElement>("[data-week-entry]")].find(
          (node) => node.dataset.weekEntry === returnFocus,
        );
        if (opener) {
          opener.focus();
          returnFocus = null;
        }
      }
    },
    retire() {
      if (retired) return;
      retired = true;
      calendar = null;
      close();
      days = [];
      selected = null;
      paint();
    },
  };
}
