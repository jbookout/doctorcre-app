const CALENDAR_AGENDA_SCHEMA = "carr-calendar-agenda.v1";
const HORIZON_MS = 7 * 864e5;
const STALE_MS = 18 * 36e5;
const LIMIT = 100;
const CONFLICT_DETAIL_LIMIT = 5;
const plural = (n, one, many) => n === 1 ? one : many;
const WARNINGS = {
  responses_unverified: () => "May include meetings you declined or that were cancelled or deleted. Check Outlook.",
  group_invites_not_shown: () => "Invites sent only to a group you belong to are not shown.",
  undecoded: (n) => `${n} calendar ${plural(n, "item", "items")} in Outlook couldn't be read, so meetings may be missing.`,
  time_changed: (n) => `${n} ${plural(n, "meeting has", "meetings have")} more than one stored time. Check Outlook for the current time.`,
  recurring_unverified: () => "Recurring meetings show only the occurrences Outlook stored; some may be missing.",
  canceled_hidden: (n) => `${n} cancelled ${plural(n, "meeting was", "meetings were")} left out.`,
  follow_up_trimmed: (n) => `${n} meeting outcome ${plural(n, "review was", "reviews were")} left out to keep the brief small.`,
  trimmed: (n) => `${n} later ${plural(n, "meeting was", "meetings were")} left out to keep the brief small.`
};
const instant = (value) => {
  if (typeof value !== "string") return null;
  const fields = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):?(\d{2}))$/.exec(value);
  if (!fields) return null;
  const [, year, month, day, hour, minute, second] = fields.map(Number);
  const offsetHour = Number(fields[7] ?? 0), offsetMinute = Number(fields[8] ?? 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const text = (value) => typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : null;
const person = (value) => value && typeof value === "object" ? { name: text(value.name), email: text(value.email)?.toLowerCase() ?? null } : { name: null, email: null };
function calendarSection(snapshot, now = /* @__PURE__ */ new Date()) {
  if (snapshot === void 0 || snapshot === null) return null;
  const nowMs = now.getTime();
  const observed = instant(snapshot?.observed_at);
  if (snapshot?.schema !== CALENDAR_AGENDA_SCHEMA || observed === null || !Array.isArray(snapshot.items))
    return { state: "unavailable", reason: "source_unavailable", items: [] };
  let malformed = 0;
  let malformedTimes = 0;
  const items = [];
  for (const row of snapshot.items) {
    const start = instant(row?.start), end = instant(row?.end);
    if (start === null || end === null || end < start || !text(row?.title)) {
      malformed++;
      continue;
    }
    if (end <= nowMs || start >= nowMs + HORIZON_MS) continue;
    const attendees = Array.isArray(row.attendees) ? row.attendees.map(person) : [];
    const times = Array.isArray(row.times) ? row.times.map(instant) : [];
    malformedTimes += times.filter((t) => t === null).length;
    if (row.times !== void 0 && !Array.isArray(row.times)) malformedTimes++;
    items.push({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      title: text(row.title),
      location: text(row.location),
      organizer: person(row.organizer),
      attendees,
      attendee_count: Number.isSafeInteger(row.attendee_count) ? row.attendee_count : attendees.length,
      all_day: row.all_day === true,
      recurring: row.recurring === true,
      time_changed: row.time_changed === true,
      times: times.filter((t) => t !== null).map((t) => new Date(t).toISOString()),
      conflict: row.conflict === true
    });
  }
  items.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  for (const item of items) {
    item.schedule_conflict = false;
    item.schedule_conflicts = [];
    item.schedule_conflicts_omitted = 0;
  }
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a.all_day || a.end <= a.start) continue;
    for (let j = i + 1; j < items.length && items[j].start < a.end; j++) {
      const b = items[j];
      if (!b.all_day && b.end > b.start) {
        a.schedule_conflict = b.schedule_conflict = true;
        const overlap_start = a.start > b.start ? a.start : b.start;
        const overlap_end = a.end < b.end ? a.end : b.end;
        for (const [item, other] of [[a, b], [b, a]]) {
          if (item.schedule_conflicts.length < CONFLICT_DETAIL_LIMIT) {
            item.schedule_conflicts.push({
              title: other.title,
              start: other.start,
              end: other.end,
              overlap_start,
              overlap_end
            });
          } else item.schedule_conflicts_omitted++;
        }
      }
    }
  }
  const notes = [];
  for (const warning of Array.isArray(snapshot.warnings) ? snapshot.warnings : []) {
    const count = Number.isSafeInteger(warning?.count) && warning.count > 0 ? warning.count : 1;
    const say = Object.prototype.hasOwnProperty.call(WARNINGS, warning?.code) ? WARNINGS[warning.code] : null;
    notes.push(say ? say(count) : "This calendar has a gap the brief cannot describe. Check Outlook.");
  }
  if (malformed) notes.push(`${malformed} stored ${plural(malformed, "meeting", "meetings")} could not be shown.`);
  if (malformedTimes) notes.push(`${malformedTimes} stored alternate ${plural(malformedTimes, "time", "times")} could not be shown. Check Outlook for the current time.`);
  if (items.length > LIMIT) notes.push(`Only the first ${LIMIT} meetings are shown.`);
  const stale = nowMs - observed > STALE_MS;
  const future = observed > nowMs;
  const reviews = [];
  let malformedReviews = 0;
  if (snapshot.follow_up_reviews !== void 0 && !Array.isArray(snapshot.follow_up_reviews)) malformedReviews++;
  for (const row of Array.isArray(snapshot.follow_up_reviews) ? snapshot.follow_up_reviews : []) {
    const start = instant(row?.start), end = instant(row?.end);
    if (row?.state !== "needs_review" || typeof row?.key !== "string" || !/^[a-f0-9]{16}$/.test(row.key) || !text(row?.title) || !text(row?.prompt) || start === null || end === null || end <= start) {
      malformedReviews++;
      continue;
    }
    if (stale || future || end > observed || end > nowMs || end <= nowMs - 864e5) continue;
    reviews.push({
      key: row.key,
      title: text(row.title),
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      state: "needs_review",
      prompt: text(row.prompt)
    });
  }
  reviews.sort((a, b) => b.end.localeCompare(a.end) || a.key.localeCompare(b.key));
  if (reviews.length) notes.push("These are scheduled meetings, not confirmed attendance. Confirm each happened before recording an outcome or next step.");
  if (malformedReviews) notes.push(`${malformedReviews} stored meeting outcome ${plural(malformedReviews, "review", "reviews")} could not be shown.`);
  if (reviews.length > LIMIT) notes.push(`Only the first ${LIMIT} meeting outcome reviews are shown.`);
  if (future) notes.push("This calendar's observation time is in the future. Refresh Outlook before reviewing meetings.");
  if (stale) notes.push("This calendar was last read from Outlook more than 18 hours ago.");
  return {
    state: notes.length ? "partial" : items.length ? "ready" : "empty",
    source: "outlook_local_store",
    notes,
    observed_at: new Date(observed).toISOString(),
    sources: { outlook_calendar: { state: stale ? "stale" : notes.length ? "partial" : "ready" } },
    ...malformed ? { malformed_items: malformed } : {},
    items: items.slice(0, LIMIT),
    ...snapshot.follow_up_reviews !== void 0 ? { follow_up_reviews: reviews.slice(0, LIMIT) } : {}
  };
}

export { calendarSection };
