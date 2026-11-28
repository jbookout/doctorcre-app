import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useState } from "react";
import { object } from "./inbox";
import type { MeetingRead } from "./meetings";
import { ended, type MeetingRow, meetingRows, nextChange, nowLine } from "./today-lines.ts";

const sibling = (path: string) => import(new URL(path, import.meta.url).href);
const clock = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const href = (value: unknown) =>
  typeof value === "string" &&
  /^\/[a-z]/.test(value) &&
  URL.parse(value, "https://doctorcre.invalid")?.origin === "https://doctorcre.invalid"
    ? value
    : undefined;

type Tour = { key: string; label: string; records: { name: string; url: string | null }[] };
type CalendarRead = { status: string; entries: ({ type: string } & Tour)[] };

/** Today's planned tours from the same read Calendar uses, so both show the same tours. */
async function readTours(today: string) {
  const [{ createClient }, { readMeetings }] = await Promise.all([
    sibling("./client.js"),
    sibling("./calendar-model.js"),
  ]);
  const read: CalendarRead = await readMeetings(await createClient("live", { docContext: false }), {
    from: today,
    to: today,
  });
  if (read.status === "unavailable") throw Error("Tours unavailable");
  return read.entries.filter((entry) => entry.type === "tour");
}

function MeetingLine({ row: { meeting }, now }: { row: MeetingRow; now: number }) {
  const attendees = Array.isArray(meeting.attendees) ? meeting.attendees.filter(object) : [];
  const names = attendees.map((person) => (text(person.name) ? person.name : person.email)).filter(text);
  const deal = href(meeting.open_url);
  const matches = Array.isArray(meeting.possible_deals) ? meeting.possible_deals.filter(object) : [];
  const past = ended(meeting, now);
  return (
    <details className="home-today-row" data-ended={past || undefined}>
      <summary>
        <time className="home-today-time" dateTime={meeting.start}>
          {meeting.all_day === true ? "All day" : clock.format(new Date(meeting.start))}
        </time>
        <span className="home-today-title">
          {meeting.title}
          {text(meeting.context_label) && <span> · {meeting.context_label}</span>}
        </span>
        {past && <span className="home-today-mark">Ended</span>}
      </summary>
      {names.length > 0 && <p>{names.join(", ")}</p>}
      {text(meeting.location) && <p>{meeting.location}</p>}
      {deal ? (
        <a href={deal}>Open deal</a>
      ) : (
        matches.map((match) => {
          const link = href(match.open_url);
          return link && text(match.name) ? (
            <a href={link} key={link}>
              {match.name}
            </a>
          ) : null;
        })
      )}
    </details>
  );
}

/** The day's tours, then its meetings in time order, with a line at the current time. */
export function TodayMeetings({ data, today }: { data: MeetingRead; today: string }) {
  const tours = useQuery({
    queryKey: ["home-tours", today],
    queryFn: () => readTours(today),
    // eslint-disable-next-line no-restricted-syntax -- Tours read once a minute while visible and online, like meetings.
    refetchInterval: () => (navigator.onLine && document.visibilityState === "visible" ? 60_000 : false),
  });
  const [view, setView] = useState(() => ({ data, today, revision: 0, rows: meetingRows(data, today, 0, []) }));
  if (view.data !== data || view.today !== today) {
    const revision = view.revision + 1;
    const previous = view.data.actor === data.actor ? view.rows : [];
    setView({ data, today, revision, rows: meetingRows(data, today, revision, previous) });
  }
  const rows = view.rows;

  const [, setClock] = useState(0);
  const now = Date.now();
  const redraw = nextChange(rows, now);
  useEffect(() => {
    if (!Number.isFinite(redraw)) return;
    // eslint-disable-next-line no-restricted-syntax -- One timer for the next meeting start or end, cleared when the rows change.
    const timer = window.setTimeout(() => setClock((tick) => tick + 1), Math.max(0, redraw - Date.now()));
    return () => window.clearTimeout(timer);
  }, [redraw]);

  const tourRows = tours.data ?? [];
  const count = tourRows.length + rows.length;
  if (!count && !tours.isError) return null;

  const calendar = `/calendar?${new URLSearchParams({ view: "day", d: today })}`;
  const line = nowLine(rows, now);
  const timed = rows.some(({ meeting }) => meeting.all_day !== true);
  return (
    <section className="home-slice home-today" aria-label="Today's meetings">
      <header>
        <h2 tabIndex={-1}>
          <a href={calendar}>Today's meetings</a> <span>{count}</span>
        </h2>
        <a className="home-tile-door" href={calendar}>
          Calendar
        </a>
      </header>
      {tours.isError && (
        <p className="home-tile-status" role="status">
          Tours unavailable.
        </p>
      )}
      <section className="home-today-list">
        {tourRows.map((tour) => {
          const deal = href(tour.records[0]?.url);
          const body = (
            <>
              <span className="home-today-time">Tour</span>
              <span className="home-today-title">
                {tour.records[0]?.name} <span>· {tour.label}</span>
              </span>
            </>
          );
          return deal ? (
            <a className="home-today-row home-tour" href={deal} key={tour.key}>
              {body}
            </a>
          ) : (
            <div className="home-today-row home-tour" key={tour.key}>
              {body}
            </div>
          );
        })}
        {rows.map((row, index) => (
          <Fragment key={row.id}>
            {timed && index === line && <hr className="home-now" aria-label="Now" />}
            <MeetingLine row={row} now={now} />
          </Fragment>
        ))}
        {timed && line === rows.length && <hr className="home-now" aria-label="Now" />}
      </section>
    </section>
  );
}
