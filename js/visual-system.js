// Pure decisions behind the shared visual system (V5-UX-S01). No DOM, no
// network, no storage: the prototype pages call these and do the wiring.

export const THEMES = Object.freeze(["dark", "light"]);
export const DENSITIES = Object.freeze(["comfortable", "compact"]);
export const MOTIONS = Object.freeze(["full", "reduced"]);

export const DEFAULT_PREFERENCES = Object.freeze({ theme: "dark", density: "comfortable", motion: "full" });

/**
 * Resolve the three personal presentation preferences. A stored value wins
 * when it is a known one; an unknown or missing value falls back to the
 * default, except motion, where the operating system's reduced-motion
 * request is honoured when nothing personal has been stored. Follow mode
 * never reaches this function: preferences are personal by contract.
 */
export function resolvePreferences(stored = {}, system = {}) {
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  const motionFallback = system.prefersReducedMotion === true ? "reduced" : DEFAULT_PREFERENCES.motion;
  return Object.freeze({
    theme: pick(stored?.theme, THEMES, DEFAULT_PREFERENCES.theme),
    density: pick(stored?.density, DENSITIES, DEFAULT_PREFERENCES.density),
    motion: pick(stored?.motion, MOTIONS, motionFallback),
  });
}

/** The attribute map a page applies to <html>; one place decides the names. */
export function preferenceAttributes(preferences) {
  return Object.freeze({ "data-theme": preferences.theme, "data-density": preferences.density, "data-motion": preferences.motion });
}

/**
 * Command feedback is a small, closed state machine. Saving appears at once
 * but stays distinguishable from confirmed; a refusal restores the confirmed
 * position and keeps the input; a timeout is UNKNOWN, never failed, and must
 * be reconciled before any retry. Every record names its logical operation,
 * so a double click or a reconnect reuses one operation instead of two.
 */
export const FEEDBACK_STATES = Object.freeze(["idle", "pending", "confirmed", "refused", "unknown", "checking", "undone"]);

const TRANSITIONS = Object.freeze({
  idle: { dispatch: "pending" },
  pending: { confirm: "confirmed", refuse: "refused", timeout: "unknown" },
  confirmed: { undo: "undone" },
  refused: { dispatch: "pending" },
  unknown: { reconcile: "checking" },
  checking: { confirm: "confirmed", refuse: "refused", timeout: "unknown" },
  undone: { dispatch: "pending" },
});

export function createFeedback(operationId, summary) {
  if (typeof operationId !== "string" || !operationId) throw new TypeError("a feedback record needs a logical operation id");
  return Object.freeze({ operationId, summary: String(summary || ""), state: "idle", reason: null, retryable: false, refusedEvent: null });
}

export function transitionFeedback(record, event, detail = {}) {
  const next = TRANSITIONS[record.state]?.[event];
  if (!next) return Object.freeze({ ...record, refusedEvent: event });
  const reason = event === "refuse"
    ? String(detail.reason || "refused without a reason")
    : event === "timeout" ? "outcome unproven; checking before any retry" : null;
  return Object.freeze({ ...record, state: next, reason, retryable: next === "refused" || next === "undone", refusedEvent: null });
}

/** Whether a fresh dispatch of the same operation may start now. */
export function canDispatch(record) {
  return record.state === "idle" || record.state === "refused" || record.state === "undone";
}

/** What the user reads next to the state; colour and shape come from CSS via data-state. */
export function feedbackLabel(record) {
  switch (record.state) {
    case "pending": return "Saving";
    case "confirmed": return "Confirmed";
    case "refused": return "Refused";
    case "unknown": return "Unknown outcome";
    case "checking": return "Checking";
    case "undone": return "Undone";
    default: return "Ready";
  }
}

/**
 * Priority order for work lists: overdue, approaching deadline, blocked, then
 * ordinary, with an explicit reason for every elevation and manual pins on
 * top. Sorting is stable, so equal items never reshuffle under a reader.
 */
const PRIORITY_RANK = Object.freeze({ overdue: 0, deadline: 1, blocked: 2, ordinary: 3 });
const DAY_MS = 86400000;

export function classifyPriority(item, now) {
  if (item.blocked) return { priority: "blocked", reason: `blocked on ${item.blockedOn || "something outside this task"}` };
  if (item.due) {
    const dueMs = Date.parse(item.due);
    const nowMs = typeof now === "number" ? now : Date.parse(now);
    if (Number.isFinite(dueMs) && Number.isFinite(nowMs)) {
      const days = (dueMs - nowMs) / DAY_MS;
      const plural = (n) => `${n} day${n === 1 ? "" : "s"}`;
      if (days < 0) return { priority: "overdue", reason: `due ${plural(Math.max(1, Math.floor(-days)))} ago` };
      if (days <= 7) return { priority: "deadline", reason: `due in ${plural(Math.ceil(days))}` };
    }
  }
  return { priority: "ordinary", reason: "" };
}

export function orderWork(items, now) {
  return items
    .map((item, index) => ({ item, index, ...classifyPriority(item, now) }))
    .sort((a, b) => (Number(Boolean(b.item.pinned)) - Number(Boolean(a.item.pinned)))
      || (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
      || (a.index - b.index))
    .map(({ item, priority, reason }) => Object.freeze({ ...item, priority, reason }));
}

/**
 * Clock and calendar formatting. Every time DoctorCRE prints is a 12-hour
 * AM/PM time; 24-hour clocks are not in this product's vocabulary. Dates are
 * printed as a calendar reads them, never as a bare ISO key. Both work in UTC
 * so a fixture reads the same on every machine and in every test.
 */
const WEEKDAYS = Object.freeze(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
const MONTHS = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);

function asDate(value) {
  const date = value instanceof Date ? value : new Date(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isFinite(date.valueOf()) ? date : null;
}

/** "2:00 PM" — hour without a leading zero, minutes always two digits. */
export function formatClock(value) {
  const date = asDate(value);
  if (!date) return null;
  const hours = date.getUTCHours();
  const suffix = hours < 12 ? "AM" : "PM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(date.getUTCMinutes()).padStart(2, "0")} ${suffix}`;
}

/** "Wed, Sep 16, 2026" — the calendar, in the order a calendar reads. */
export function formatCalendarDate(value) {
  const date = asDate(value);
  if (!date) return null;
  return `${WEEKDAYS[date.getUTCDay()].slice(0, 3)}, ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** "Wednesday" — the day a title names, taken from the fixture date. */
export function weekdayName(value) {
  const date = asDate(value);
  return date ? WEEKDAYS[date.getUTCDay()] : null;
}

/** A calendar date plus an optional AM/PM time, joined the one way. */
export function formatDueStamp(value, time = null) {
  const calendar = formatCalendarDate(value);
  if (!calendar) return null;
  return time ? `${calendar} · ${time}` : calendar;
}

function nextWeekday(target, now) {
  const date = new Date(now);
  const delta = ((target - date.getUTCDay()) + 7) % 7 || 7;
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/**
 * Quick add reads one sentence and shows what it understood. It infers the
 * action, an owner, a due date, a due time and the related record.
 *
 * Three rules came out of the 2026-09-16 review. An owner is never left
 * unknown when the sentence does not name one: the viewer owns what the
 * viewer captures, and the reply says it was defaulted. A time of day in the
 * sentence ("Friday 10 AM") is read and printed as AM/PM. A related record is
 * matched against the records actually on the board, so a distinctive word
 * ("Crestview") finds "Demo Crestview Derm" without the word "for".
 *
 * @param {string} sentence
 * @param {number|{now?: number, viewer?: string, records?: string[]}} options
 *        a bare number is still accepted as `now`.
 */
export function parseQuickAdd(sentence, options = {}) {
  const { now = Date.now(), viewer = "joe", records = [] } = typeof options === "number" ? { now: options } : (options || {});
  const text = String(sentence || "").trim();

  const named = /(?:@|\bto\s+|\bfor\s+)(joe|dell)\b/i.exec(text)?.[1]?.toLowerCase() || null;
  const owner = named || (viewer === "dell" ? "dell" : "joe");
  const ownerDefaulted = named === null;

  let due = null;
  const isoMatch = /\b(?:by|on|due)?\s*(\d{4}-\d{2}-\d{2})\b/i.exec(text);
  const weekdayMatch = /\b(?:by\s+|on\s+|next\s+|this\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(text);
  if (isoMatch) due = isoMatch[1];
  else if (weekdayMatch) due = nextWeekday(WEEKDAYS.findIndex((n) => n.toLowerCase() === weekdayMatch[1].toLowerCase()), now);

  const timeMatch = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  const dueTime = timeMatch
    ? `${Number(timeMatch[1]) % 12 === 0 ? 12 : Number(timeMatch[1]) % 12}:${timeMatch[2] || "00"} ${timeMatch[3].toUpperCase()}`
    : null;

  const haystack = text.toLowerCase();
  const matched = records.find((name) => String(name).toLowerCase().split(/\s+/)
    .filter((word) => word.length > 3 && word !== "demo")
    .some((word) => haystack.includes(word)));
  const related = matched || /\b(?:for|about|on)\s+((?:Demo\s+)?[A-Z][\w'&-]*(?:\s+[A-Z][\w'&-]*)*)/.exec(text)?.[1] || null;

  const action = text
    .replace(/(?:@|\bto\s+|\bfor\s+)(joe|dell)\b/ig, " ")
    .replace(/\b(?:by|on|due)?\s*\d{4}-\d{2}-\d{2}\b/ig, " ")
    .replace(/\b(?:by\s+|on\s+|next\s+|this\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/ig, " ")
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/ig, " ")
    .replace(/\b(?:about|regarding)\s+(?:the\s+)?(?:Demo\s+)?[A-Z][\w'&-]*(?:\s+[A-Z][\w'&-]*)*(?:\s+\w+)?$/g, " ")
    .replace(/\bfor\s+(?:Demo\s+)?[A-Z][\w'&-]*(?:\s+[A-Z][\w'&-]*)*/g, " ")
    .replace(/\s+/g, " ").trim() || null;

  const questions = [];
  if (!action) questions.push("What is the action?");
  return Object.freeze({
    action, owner, ownerDefaulted, due, dueTime,
    dueLabel: formatDueStamp(due, dueTime), related, questions, complete: questions.length === 0,
  });
}

/**
 * WCAG 2.x relative luminance and contrast ratio, used by the token audit
 * test so a theme cannot ship a text/ground pair under 4.5:1.
 */
export function parseHex(hex) {
  const value = String(hex).trim().replace(/^#/, "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new TypeError(`not a 6-digit hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

export function relativeLuminance(hex) {
  const [r, g, b] = parseHex(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/**
 * Read the custom properties declared in the first `{ … }` block that follows
 * a selector. Enough for the token audit, which reads `--name: value;` pairs.
 */
export function readTokens(css, selector) {
  const start = css.indexOf(selector);
  if (start < 0) return null;
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const tokens = {};
  for (const match of css.slice(open + 1, close).matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) tokens[`--${match[1]}`] = match[2].trim();
  return tokens;
}
