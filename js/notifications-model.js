// V5-UX-B12a — what the Notifications page shows, decided without a DOM.
//
// The producer is `mcp-server/src/notifications.js` over migration 0521, and
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
//   3. Quiet hours are reported as an OBSERVED EFFECT and never as a setting.
//      No verb reads or writes `ops.notification_preference`, so the page says
//      what the record layer did and says plainly that the window itself is not
//      reachable from here. A dead toggle would be a lie with a control on it.
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

/** The two sentences the quiet-hours panel is allowed to say. */
export const QUIET_HOURS_EFFECT =
  "Inside your quiet hours the record layer holds a device push instead of dropping it, and records that it held it. The in-app item is never suppressed.";
export const QUIET_HOURS_UNAVAILABLE =
  "The quiet-hours window itself cannot be read or changed from this app yet: no verb exposes the notification preference, so this page shows no value and offers no control.";

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
  "/business", "/status", "/incidents", "/notifications",
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
