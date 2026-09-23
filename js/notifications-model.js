// V5-UX-B12a — what the Notifications page shows, decided without a DOM.
//
// The producer is `mcp-server/src/notifications.js` over migrations 0521 and
// 0527, and
// every rule below is a reading of what that producer can actually do. Five
// shapes govern the file, and each one exists because the alternative would
// let the page say something the record layer cannot back.
//
//   1. `unread_count` is PRINTED, never recomputed. The count is over all of
//      the recipient's rows while the list is capped at `limit`, so a count
//      derived from the visible cards would quietly shrink as the page filled.
//   2. The severity vocabulary is exactly two words. The notification severity
//      enum has no informational member, and `record-signal` mints nothing for
//      a signal of severity `info`. "No routine progress spam" is therefore a
//      fact about the producer, not a filter this page applies.
//   3. Quiet hours are now BOTH an observed effect and a setting. WR-000116
//      shipped `read-notification-preferences` and `set-notification-preference`,
//      so the honesty paragraph B12a wrote ("no verb exposes the notification
//      preference") is false as of producer 3c8f619d and is gone. What replaces
//      it is a real form under a compare-and-swap on `version`: every save
//      carries the version the page last read, and a `version_conflict` is
//      re-read and re-rendered rather than retried over somebody's change.
//      `quiet_suppressed` and `quiet_now` are OUTPUT-ONLY fields of the feed —
//      a suppressed row is MARKED and never hidden, because hiding it would be
//      this page inventing a filter the record layer did not apply.
//   4. A deep link is rendered as an anchor only when this application has a
//      page for it. The two shapes a production mint can produce are
//      `/signals/<id>` and `/doc-conversations/<ref>`, and neither is a route
//      today, so the honest rendering is the path plus a sentence.
//   5. Acknowledging clears THE NOTIFICATION and nothing else. That is all
//      `ops.acknowledge_notification` is granted to touch, so it is all the
//      page's copy is allowed to claim.
import { formatClock } from "./visual-system.js";
import { REFUSAL_SENTENCE } from "./status-model.js";

export { REFUSAL_SENTENCE };

/* ----------------------------------------------------------- the vocabulary */

/**
 * The whole severity vocabulary of this page, because it is the whole severity
 * vocabulary a mint can produce. A third chip here would be a chip no row can
 * ever carry.
 */
export const SEVERITY_LABELS = Object.freeze({
  action_required: "Action required",
  failure: "Failure",
});
export const SEVERITIES = Object.freeze(Object.keys(SEVERITY_LABELS));

/** The delivery states migration 0521 declares, in this page's plain English. */
export const DELIVERY_PHRASES = Object.freeze({
  pending: "in-app, waiting",
  delivered: "delivered",
  suppressed_quiet_hours: "device push held by your quiet hours",
  failed: "device push failed",
});

/**
 * What a card with no `device` delivery row means. No opt-in, no row — so this
 * is a reading of the absence, not an inference about a person's phone.
 */
export const DEVICE_OFF = "device push is off for you";

/** What quiet hours DO. Unchanged from B12a: the producer did not change. */
export const QUIET_HOURS_EFFECT =
  "Inside your quiet hours the record layer holds a device push instead of dropping it, and records that it held it. The in-app item is never suppressed.";

/**
 * The scope sentence that replaces B12a's honesty paragraph. The window is
 * readable and settable now; what is still true is the boundary — these are
 * YOUR preferences, the verbs take no actor, and nothing here changes anybody
 * else's.
 */
export const QUIET_HOURS_SCOPE =
  "These are your own preferences. Neither verb takes an actor, so this form can only read and set yours, and a save carries the version this page last read so it can never silently overwrite a change made somewhere else.";

/** The banner shown when the record layer says quiet hours cover this moment. */
export const QUIET_NOW_BANNER =
  "Quiet hours cover this moment. Device push is being held; the items below still arrived in-app.";

/** The marker a suppressed row carries. It is marked, never hidden. */
export const QUIET_SUPPRESSED_MARK = "held by your quiet hours";

/** The candid mobile-exposure statement rule f0f9156e asks a page to make. */
export const EXPOSURE_STATEMENT =
  "This feed is yours alone, and its subjects name real deals, so on a shared or unlocked phone this page shows business subjects at a glance. It holds no document contents and no credentials, and nothing on it is cached offline.";

/** What acknowledging does, and the boundary it does not cross. */
export const ACKNOWLEDGE_SCOPE =
  "Acknowledging clears the notification. It does not complete, close or change the work the notification is about.";

/**
 * Every route this application serves, copied from
 * `contracts/app-routes.v1.json`. It is a copy because `js/` is served to a
 * browser with no build step, so the contract cannot be imported here; the
 * contract test asserts this list is byte-identical to the contract's own keys,
 * which is what stops the two drifting apart.
 */
export const APP_ROUTE_PATHS = Object.freeze([
  "/", "/control-room", "/workspace", "/deals", "/leads", "/clients", "/vendors",
  "/system-work.html", "/room.html", "/queue.html", "/tours", "/share", "/design",
  "/design/business", "/design/operations", "/work-inventory", "/tasks", "/pipeline",
  "/business", "/status", "/incidents", "/notifications", "/conversations", "/meeting",
]);

/** The sentence an unroutable deep link carries. */
export const NO_PAGE_SENTENCE = "This link points at a record the app has no page for yet.";

const isText = (value) => typeof value === "string" && value.length > 0;

/* --------------------------------------------------------------- the payload */

/** `notification-feed`'s own shape: the count, and the list, kept separate. */
export function validFeedPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (!Number.isInteger(payload.unread_count) || payload.unread_count < 0) return false;
  return Array.isArray(payload.notifications);
}

/* ---------------------------------------------------------------- the header */

/**
 * The unread line, printed from the payload's own number. Zero is a sentence,
 * never a hidden element: "nothing unread" is an answer and an empty space is
 * not.
 */
export function unreadLine(payload) {
  if (!validFeedPayload(payload)) return "unknown";
  const count = payload.unread_count;
  if (count === 0) return "Nothing unread";
  return count === 1 ? "1 unread notification" : `${count} unread notifications`;
}

/* ----------------------------------------------------------------- the cards */

/**
 * One phrase per delivery row, plus the device-off phrase when the producer
 * wrote no device row at all. An unrecognised state is named as itself rather
 * than dropped, because a state this page has not been taught is still a state
 * the record layer recorded.
 */
export function deliveryPhrases(delivery) {
  const rows = (Array.isArray(delivery) ? delivery : [])
    .filter((row) => row && typeof row === "object" && isText(row.channel) && isText(row.state));
  const phrases = rows.map((row) => ({
    channel: row.channel,
    state: row.state,
    phrase: DELIVERY_PHRASES[row.state] || `recorded as ${row.state}`,
  }));
  if (!rows.some((row) => row.channel === "device")) {
    phrases.push({ channel: "device", state: "absent", phrase: DEVICE_OFF });
  }
  return phrases;
}

/**
 * How a deep link is rendered. An anchor only where this application has the
 * page; otherwise the path itself, in monospace, with the sentence saying why.
 */
export function deepLinkView(deepLink, routes = APP_ROUTE_PATHS) {
  const path = isText(deepLink) ? deepLink : null;
  if (!path) return { path: null, href: null, routed: false, sentence: null };
  const routed = (Array.isArray(routes) ? routes : []).includes(path);
  return { path, href: routed ? path : null, routed, sentence: routed ? null : NO_PAGE_SENTENCE };
}

/**
 * One card per notification row, in the order the feed returned them. A row
 * without an id is dropped rather than drawn: the id is what an acknowledgement
 * is addressed to, and a card that cannot be acknowledged is a dead control.
 */
export function notificationCards(payload, routes = APP_ROUTE_PATHS) {
  if (!validFeedPayload(payload)) return [];
  return payload.notifications
    .filter((row) => row && typeof row === "object" && isText(row.id))
    .map((row) => ({
      id: row.id,
      severity: SEVERITIES.includes(row.severity) ? row.severity : null,
      severityLabel: SEVERITY_LABELS[row.severity] || "unknown severity",
      reason: isText(row.reason) ? row.reason : "no reason recorded",
      subject: isText(row.subject_type)
        ? `${row.subject_type}${isText(row.subject_ref) ? ` · ${row.subject_ref}` : ""}`
        : "no subject recorded",
      clock: formatClock(row.created_at) || "unknown",
      read: isText(row.read_at),
      readClock: formatClock(row.read_at) || null,
      delivery: deliveryPhrases(row.delivery),
      // OUTPUT-ONLY, and printed exactly as the producer decided it. The page
      // does not recompute suppression from the delivery rows: the producer's
      // value is a DISJUNCTION of "quiet hours cover now" and "a push was
      // suppressed at mint time", and a page that recomputed it would lose the
      // first term the moment the window closed.
      quietSuppressed: row.quiet_suppressed === true,
      link: deepLinkView(row.deep_link, routes),
    }));
}

/* -------------------------------------------------------------- the UX20 states */

/**
 * The refusal a failed read is turned into, from the STATUS and the CODE alone.
 * The server's prose never travels: a 500's body is written for whoever
 * maintains the verb, and this page prints at partners.
 *
 *  - 401/403 is a DECISION taken before the verb ran. Nothing was read.
 *  - any other HTTP status is the path failing around a request that may well
 *    have been served; the page says so and does not invite a blind retry.
 *  - `notification_feed_unavailable` is the shaper's own refusal: the answer
 *    could not be shaped, so the page shows nothing rather than a guess.
 */
export function classifyReadFailure(error) {
  const code = error?.payload?.error || null;
  const status = Number(error?.status ?? 0) || null;
  if (code === "notification_feed_unavailable") return { state: "unknown", reason: FEED_STATES.unknown };
  if (status === 401 || status === 403) return { state: "refused", reason: FEED_STATES.refused };
  if (status) return { state: "unavailable", reason: FEED_STATES.unavailable };
  return { state: "unknown", reason: REFUSAL_SENTENCE };
}

/** The eight states UX20 demands, each with the sentence the page renders. */
export const FEED_STATES = Object.freeze({
  loading: "Reading your notifications…",
  empty: "You have no notifications, and nothing is unread.",
  no_match: "No notification was created after that time. The filter matched nothing; the feed is not empty.",
  stale: "This is the last picture that landed. A newer read has not answered yet.",
  unavailable: "The feed did not answer. It may have been served; nothing was retried for you.",
  refused: "The record layer refused this read. It was decided before the verb ran, and nothing was read.",
  unknown: "The feed could not be shaped, so this page shows nothing rather than a guess.",
  partial: "This list is capped, so it is shorter than your unread count.",
});

/**
 * Which of the eight states this page is in. Order is the whole design: a
 * refusal outranks an empty list, because an empty list drawn over a refusal
 * would read as "you have nothing" when the truth is "we were not told".
 */
export function feedState(read = {}, { after = null, limit = null } = {}) {
  const has = read.state === "read" && validFeedPayload(read.payload);
  if (read.state === "refused") return { state: "refused", sentence: FEED_STATES.refused };
  if (read.state === "unavailable") return { state: "unavailable", sentence: FEED_STATES.unavailable };
  if (read.state === "unknown") return { state: "unknown", sentence: FEED_STATES.unknown };
  if (read.state === "pending") {
    if (!has && !read.payload) return { state: "loading", sentence: FEED_STATES.loading };
  }
  if (read.refreshing === true && has) return { state: "stale", sentence: FEED_STATES.stale };
  if (!has) return { state: "loading", sentence: FEED_STATES.loading };
  const rows = read.payload.notifications.length;
  if (rows === 0) {
    return isText(after)
      ? { state: "no_match", sentence: FEED_STATES.no_match }
      : { state: "empty", sentence: FEED_STATES.empty };
  }
  if (Number.isInteger(limit) && rows >= limit && read.payload.unread_count > rows) {
    return {
      state: "partial",
      sentence: `${FEED_STATES.partial} It shows ${rows} of ${read.payload.unread_count} unread.`,
    };
  }
  return { state: "ready", sentence: null };
}

/* ------------------------------------------------------ accountable activity */

/**
 * The activity stream, as *actor · verb · subject · time*. It is deliberately
 * NOT merged into the feed: a notification is addressed to you, and an event is
 * something that happened.
 */
export function activityRows(events) {
  return (Array.isArray(events) ? events : [])
    .filter((row) => row && typeof row === "object" && isText(row.verb))
    .slice(-12)
    .reverse()
    .map((row) => ({
      actor: isText(row.actor) ? row.actor : "unattributed",
      verb: row.verb,
      subject: isText(row.subject_id)
        ? `${isText(row.subject_type) ? row.subject_type : "record"} ${row.subject_id}`
        : "no subject recorded",
      clock: formatClock(row.recorded_at) || "unknown",
    }));
}

/* -------------------------------------------------------------- the one write */

/** One operation per notification id, so two cards never share a key. */
export function acknowledgeOperationKey(id) {
  return `notifications:ack:${id}`;
}

/**
 * The arguments for `acknowledge-notification`, or the refusal. The verb
 * declares exactly two fields and refuses any other, and the kernel mints the
 * idempotency key, so nothing here adds, defaults or trims one into shape.
 */
export const ID_REFUSAL = "A notification is identified by the id the feed returned. Nothing was sent.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function acknowledgeArgs(id) {
  const value = String(id || "").trim();
  if (!UUID.test(value)) return { ok: false, message: ID_REFUSAL };
  return { ok: true, args: { notification_id: value } };
}

/* ------------------------------------------ the preference form (WR-000116) */

/**
 * `read-notification-preferences`' own shape, and `set-notification-preference`'s
 * too — the set answer is the same object minus `quiet_now` and plus
 * `deduplicated`, so `quiet_now` is read with `=== true` and never required.
 * `exists` is a first-class boolean here because "no row yet" is an answer the
 * page prints, not a hole it fills in.
 */
export function validPreferencePayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.ok !== true) return false;
  if (typeof payload.exists !== "boolean") return false;
  if (typeof payload.device_opt_in !== "boolean") return false;
  if (!Number.isInteger(payload.version) || payload.version < 1) return false;
  if (!isText(payload.timezone)) return false;
  for (const field of ["quiet_hours_start", "quiet_hours_end"]) {
    const value = payload[field];
    if (value !== null && typeof value !== "string") return false;
  }
  return true;
}

/**
 * A stored `time` reaches the browser as `HH:MM:SS`, and the verb accepts
 * `HH:MM`. This is the ONE place the two spellings meet; a null stays null,
 * and anything that is not a clock time is null rather than a guess.
 */
const CLOCK = /^([01][0-9]|2[0-3]):([0-5][0-9])(?::[0-5][0-9](?:\.\d+)?)?$/;
export function toInputTime(value) {
  const match = CLOCK.exec(typeof value === "string" ? value.trim() : "");
  return match ? `${match[1]}:${match[2]}` : null;
}

/** Everything the panel draws, decided once, from the payload alone. */
export function preferenceView(payload) {
  if (!validPreferencePayload(payload)) return null;
  const start = toInputTime(payload.quiet_hours_start);
  const end = toInputTime(payload.quiet_hours_end);
  return {
    exists: payload.exists,
    deviceOptIn: payload.device_opt_in,
    start,
    end,
    timezone: payload.timezone,
    version: payload.version,
    quietNow: payload.quiet_now === true,
    quietHoursSet: start !== null && end !== null,
  };
}

/**
 * What the record layer holds, in one line, ending in the version — because the
 * version is what the next save is compared against and a person about to save
 * should be able to see it.
 */
export function preferenceSummary(view) {
  if (!view) return "unknown";
  const window = view.quietHoursSet
    ? `Quiet hours ${view.start} to ${view.end} ${view.timezone}`
    : `No quiet hours set · ${view.timezone}`;
  return `${window} · device push ${view.deviceOptIn ? "on" : "off"} · version ${view.version}`;
}

/** The documented answer when no row exists, said as an absence, not a value. */
export const PREFERENCE_DEFAULTS_SENTENCE =
  "You have never saved a notification preference, so these are the record layer's documented defaults: no quiet hours, device push off, UTC. Nothing has been written on your behalf.";
export const PREFERENCE_SAVED_SENTENCE =
  "These are your saved preferences, read back from the record layer.";
export function preferenceOriginSentence(view) {
  if (!view) return "unknown";
  return view.exists ? PREFERENCE_SAVED_SENTENCE : PREFERENCE_DEFAULTS_SENTENCE;
}

/** The five states the panel can be in, each with the sentence it renders. */
export const PREFERENCE_STATES = Object.freeze({
  loading: "Reading your preferences…",
  ready: null,
  unavailable: "Your preferences did not answer. They may have been read; nothing was retried for you.",
  refused: "The record layer refused this read. It was decided before the verb ran, and nothing was read.",
  unknown: "Your preferences could not be shaped, so this page shows nothing rather than a guess.",
});

export function classifyPreferenceReadFailure(error) {
  const code = error?.payload?.error || null;
  const status = Number(error?.status ?? 0) || null;
  if (code === "notification_preferences_unavailable") return { state: "unknown" };
  if (status === 401 || status === 403) return { state: "refused" };
  if (status) return { state: "unavailable" };
  return { state: "unknown" };
}

export function preferenceState(read = {}) {
  if (read.state === "read" && validPreferencePayload(read.payload)) return { state: "ready", sentence: null };
  if (["refused", "unavailable", "unknown"].includes(read.state)) {
    return { state: read.state, sentence: PREFERENCE_STATES[read.state] };
  }
  return { state: "loading", sentence: PREFERENCE_STATES.loading };
}

/* ------------------------------------------------------- the preference write */

/** One operation key for the whole form: two saves are the same operation. */
export const PREFERENCE_OPERATION_KEY = "notifications:preference";

export const BASE_VERSION_REFUSAL =
  "This form has not read your preferences yet, so it holds no version to save against. Nothing was sent.";
export const TIME_REFUSAL =
  "A quiet-hours time is a 24-hour clock time written HH:MM. Nothing was sent.";

/**
 * The arguments for `set-notification-preference`, or the refusal.
 *
 * Two things are DELIBERATELY not checked here. A half pair — a start with no
 * end — is sent, because `notification_preference_quiet_hours_incomplete` is
 * the record layer's own refusal and rendering it by name is what proves the
 * page is reading the store's answer instead of guessing it. So is an unknown
 * timezone: `pg_timezone_names` is the list, and this page does not hold a copy
 * of it. `base_version` comes from the last READ, never from a caller.
 */
export function setPreferenceArgs(form = {}, view = null) {
  if (!view || !Number.isInteger(view.version)) return { ok: false, message: BASE_VERSION_REFUSAL };
  const args = { base_version: view.version };
  if (typeof form.device_opt_in === "boolean") args.device_opt_in = form.device_opt_in;
  if (form.clear_quiet_hours === true) {
    args.clear_quiet_hours = true;
    return { ok: true, args };
  }
  for (const field of ["quiet_hours_start", "quiet_hours_end"]) {
    const raw = typeof form[field] === "string" ? form[field].trim() : "";
    if (raw === "") continue;
    const time = toInputTime(raw);
    if (!time) return { ok: false, message: TIME_REFUSAL };
    args[field] = time;
  }
  const timezone = typeof form.timezone === "string" ? form.timezone.trim() : "";
  if (timezone) args.timezone = timezone;
  return { ok: true, args };
}

/**
 * Every refusal `ops.set_notification_preference` can return, in this page's
 * plain English. A reason id this page has not been taught is named as itself:
 * a refusal the record layer issued is still a refusal, and swallowing it would
 * leave a person looking at a form that did nothing and said nothing.
 */
export const PREFERENCE_REFUSALS = Object.freeze({
  // F2: the discard is STATED. A conflict repaints the four controls from the
  // record layer's answer, so anything typed and not saved is gone, and a page
  // that dropped it silently would look like it had simply ignored the person.
  // The values are not preserved across the re-read on purpose: the whole point
  // of the re-read is that the person is deciding again against what the record
  // layer actually holds, and a form that kept the old typing over fresh values
  // would invite saving a change that was composed against a picture that is no
  // longer true.
  version_conflict:
    "Your preferences changed somewhere else while this form was open, so nothing was saved. The form has been read again and now shows the current values and the current version, and anything you had typed and not saved has been replaced by them — check them and save again.",
  notification_preference_quiet_hours_incomplete:
    "Quiet hours are two times. Set a start and an end together, or clear them together. Nothing was saved.",
  notification_preference_quiet_hours_conflicting_request:
    "Clearing quiet hours and setting one are the same request here, so the record layer refused it. Do one or the other. Nothing was saved.",
  notification_preference_timezone_unknown:
    "The record layer does not know that timezone. Use an IANA name such as America/Chicago. Nothing was saved.",
  notification_preference_idempotency_key_required:
    "That save carried no idempotency key, so the record layer refused it. Nothing was saved.",
  notification_preference_idempotency_key_reused:
    "That key has already been used for a different save, so the record layer refused it. Nothing was saved.",
  notification_preference_not_set:
    "The record layer refused the save without naming a reason. Nothing was saved.",
});

export const VERSION_CONFLICT = "version_conflict";

/**
 * The refusal, from EITHER shape it can arrive in: the thrown client error
 * (`payload.error`) or the command kernel's settled outcome (`code`), because
 * the kernel classifies `version_conflict` as a CONFLICT and never lets the
 * raw error out. One function reads both so the sentence cannot depend on
 * which door the page happened to come through.
 */
export function classifyPreferenceFailure(source) {
  const payload = source?.payload || {};
  const code = isText(payload.error) ? payload.error
    : (isText(source?.code) ? source.code : null);
  return {
    code,
    conflict: code === VERSION_CONFLICT,
    currentVersion: Number.isInteger(payload.current_version) ? payload.current_version
      : (Number.isInteger(source?.conflict?.current_version) ? source.conflict.current_version : null),
    message: code
      ? (PREFERENCE_REFUSALS[code] || `The record layer refused this save as ${code}. Nothing was saved.`)
      : REFUSAL_SENTENCE,
  };
}

/* --------------------------------------------------------- quiet, right now */

/**
 * Whether quiet hours cover this instant. BOTH doors answer it and they are
 * read on one snapshot each, so either saying yes is yes; the page never
 * computes it from a clock of its own.
 */
export function quietNowBanner(feedPayload, preferencePayload) {
  const fromFeed = !!feedPayload && typeof feedPayload === "object" && feedPayload.quiet_now === true;
  const fromPreference = !!preferencePayload && typeof preferencePayload === "object"
    && preferencePayload.quiet_now === true;
  return fromFeed || fromPreference ? QUIET_NOW_BANNER : null;
}

/**
 * F3: the two versions, named. The refusal carries `current_version` and the
 * form carried the `base_version` it was saving against, and a person told only
 * that "something changed" has been given a fact they cannot check. Null when
 * either number is missing, because half of this sentence is not worth saying.
 */
export function versionConflictLine(currentVersion, baseVersion) {
  if (!Number.isInteger(currentVersion) || !Number.isInteger(baseVersion)) return null;
  return `It was saving against version ${baseVersion}; the record layer holds version ${currentVersion}.`;
}
