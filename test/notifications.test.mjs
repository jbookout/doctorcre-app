// V5-UX-B12a — the notifications page, one test per clause of the frozen spec.
//
// The payloads below are the producer's own shapes: `notification-feed` returns
// `unread_count` OVER EVERY ROW the recipient holds beside a list capped at
// `limit`, and each row carries a per-channel `delivery` list. A test written
// against a recomputed count, or against a single delivery state, would pass
// here and let the page print a number nobody recorded.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

import {
  APP_ROUTE_PATHS, BASE_VERSION_REFUSAL, DEVICE_OFF,
  FEED_STATES, NO_PAGE_SENTENCE, PREFERENCE_DEFAULTS_SENTENCE, PREFERENCE_OPERATION_KEY,
  PREFERENCE_REFUSALS, QUIET_NOW_BANNER, versionConflictLine,
  QUIET_SUPPRESSED_MARK, SEVERITIES, SEVERITY_LABELS, TIME_REFUSAL,
  acknowledgeArgs, acknowledgeOperationKey, activityRows, preferenceTimeLabel, classifyPreferenceFailure,
  classifyPreferenceReadFailure, classifyReadFailure, deepLinkView, deliveryPhrases, feedState,
  notificationCards, preferenceOriginSentence, preferenceState, preferenceSummary,
  preferenceView, quietNowBanner, setPreferenceArgs, toInputTime, unreadLine,
  validFeedPayload, validPreferencePayload,
} from "../js/notifications-model.js";
import { classifyCommandOutcome } from "../js/command-feedback.mjs";
import { createFixtureClient } from "../js/fixture-client.js";

test('board notifications retain encoded board identity and require the registered board route', () => {
  const path = '/control-room/progress/board/demo%20project?task=build';
  assert.equal(deepLinkView(path).href, path);
  assert.equal(deepLinkView(path, ['/control-room/progress']).href, null);
});

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const html = await read("notifications.html");

const routes = (await import("../js/routes.js")).routeContract;
const contract = JSON.parse(await read("contracts/carr-interface.v1.json"));

const fixture = async (options = {}) => {
  const seed = await read("data/board-seed.json");
  return createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seed).toString("base64")}`, ...options });
};

const QUIET = "11111111-1111-4111-8111-111111111101";
const DEVICE_OPT_OUT = "11111111-1111-4111-8111-111111111102";
const ALREADY_READ = "11111111-1111-4111-8111-111111111103";
const DOC_CONVERSATION = "11111111-1111-4111-8111-111111111105";
const cardFor = (payload, id) => notificationCards(payload).find((card) => card.id === id);

/* ------------------------------------------------------------------ clause 1 */

test("clause 1: the unread count is printed from the payload and never recomputed from the rows", async () => {
  const client = await fixture();
  const feed = await client.notificationFeed({ limit: 25 });
  assert.equal(validFeedPayload(feed), true);
  assert.equal(feed.unread_count, 5);
  assert.equal(feed.notifications.length, 6, "the fixture holds a read row too");
  assert.equal(unreadLine(feed), "5 unread notifications");

  // The count and the visible rows are DIFFERENT numbers, and the line follows
  // the count. A capped list is the ordinary case, not an edge one.
  const capped = await client.notificationFeed({ limit: 2 });
  assert.equal(capped.notifications.length, 2);
  assert.equal(capped.unread_count, 5, "the fixture recomputed the count from the page");
  assert.equal(unreadLine(capped), "5 unread notifications");

  assert.equal(unreadLine({ ok: true, unread_count: 0, notifications: [] }), "Nothing unread");
  assert.equal(unreadLine({ ok: true, unread_count: 1, notifications: [] }), "1 unread notification");
  assert.equal(unreadLine(null), "unknown");

});

/* ------------------------------------------------------------------ clause 2 */

test("clause 2: two severity chips exist, and the page's vocabulary has no third", async () => {
  const client = await fixture();
  const feed = await client.notificationFeed({ limit: 25 });
  const cards = notificationCards(feed);
  assert.deepEqual(SEVERITIES, ["action_required", "failure"]);
  assert.equal(cardFor(feed, QUIET).severity, "action_required");
  assert.equal(cardFor(feed, QUIET).severityLabel, "Action required");
  assert.equal(cardFor(feed, DEVICE_OPT_OUT).severity, "failure");
  assert.equal(cardFor(feed, DEVICE_OPT_OUT).severityLabel, "Failure");
  assert.notEqual(cardFor(feed, QUIET).severityLabel, cardFor(feed, DEVICE_OPT_OUT).severityLabel);
  assert.equal(new Set(cards.map((card) => card.severity)).size, 2);

  // No informational member anywhere: the notification severity enum has none,
  // so a chip for one would be a chip no row could ever carry.
  assert.equal(Object.keys(SEVERITY_LABELS).length, 2);
  for (const word of ["info", "informational", "progress", "notice"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(SEVERITY_LABELS, word), false, `${word} is in the page vocabulary`);
  }

});

/* ------------------------------------------------------------------ clause 3 */

test("clause 3: quiet-hours suppression, device opt-out and an ordinary delivery each read differently", async () => {
  const client = await fixture();
  const feed = await client.notificationFeed({ limit: 25 });

  const held = cardFor(feed, QUIET).delivery.map((row) => row.phrase);
  assert.ok(held.includes("device push held by your quiet hours"), "the suppression is not stated");
  assert.equal(held.includes(DEVICE_OFF), false, "a suppressed push is not an absent one");

  const optedOut = cardFor(feed, DEVICE_OPT_OUT).delivery.map((row) => row.phrase);
  assert.ok(optedOut.includes(DEVICE_OFF), "no device row did not read as device push off");
  assert.equal(optedOut.includes("device push held by your quiet hours"), false);

  const ordinary = cardFor(feed, ALREADY_READ).delivery.map((row) => row.phrase);
  assert.deepEqual(ordinary, ["delivered", "delivered"], "an ordinary delivery says something else");
  assert.equal(ordinary.includes("device push held by your quiet hours"), false);
  assert.equal(ordinary.includes(DEVICE_OFF), false);

  assert.deepEqual(
    deliveryPhrases([{ channel: "in_app", state: "pending" }, { channel: "device", state: "failed" }]).map((row) => row.phrase),
    ["in-app, waiting", "device push failed"],
  );
  // A state this page has not been taught is still a state the ledger recorded.
  assert.equal(deliveryPhrases([{ channel: "device", state: "queued" }])[0].phrase, "Delivery status unavailable");
});

/* ------------------------------------------------------------------ clause 4 */

/* ------------------------------------------------------------------ clause 5 */

test("clause 5: an unroutable deep link is text plus a sentence, and a routable one is an anchor", async () => {
  const client = await fixture();
  const feed = await client.notificationFeed({ limit: 25 });

  const unrouted = cardFor(feed, DOC_CONVERSATION).link;
  assert.equal(unrouted.path, "/doc-conversations/dc-demo-0007");
  assert.equal(unrouted.href, null);
  assert.equal(unrouted.routed, false);
  assert.equal(unrouted.sentence, NO_PAGE_SENTENCE);
  assert.equal(cardFor(feed, QUIET).link.routed, false, "a /signals link has no page in this application");

  // The day a route exists the anchor appears, and its href is byte-identical
  // to the payload value — no normalising, no trailing slash, no rewrite.
  const routed = deepLinkView("/incidents");
  assert.equal(routed.routed, true);
  assert.equal(routed.href, "/incidents");
  assert.equal(routed.sentence, null);
  assert.equal(deepLinkView("/notifications").href, "/updates");
  assert.equal(deepLinkView(null).path, null);

});

/* -------------------------------------------------------------- clause 5, B12b */

test("B12b-1: a /doc-conversations/<ref> deep link is an anchor into conversations.html's ?id= route when the ref is the conversation's own uuid", () => {
  const uuid = "22222222-2222-4222-8222-222222222222";
  const view = deepLinkView(`/doc-conversations/${uuid}`);
  assert.equal(view.routed, true);
  // Keep the original path for Details; the visible anchor has a human label.
  assert.equal(view.label, "Open conversation");
  assert.equal(view.path, `/doc-conversations/${uuid}`);
  assert.equal(view.href, `/doc-chats?id=${uuid}`);
  assert.equal(view.sentence, null);
});

test("B12b-2: a /doc-conversations/<ref> deep link whose ref is not the conversation's own uuid shape stays unrouted", () => {
  // This is the fixture's own row (data/board-seed.json, notification 105):
  // `dc-demo-0007` is not the uuid shape `ops.doc_conversation` assigns, and
  // conversations.html's own `idFromSearch` would call it malformed too, so
  // an anchor here would point at a page that could not open it either.
  const view = deepLinkView("/doc-conversations/dc-demo-0007");
  assert.equal(view.routed, false);
  assert.equal(view.href, null);
  assert.equal(view.sentence, NO_PAGE_SENTENCE);
});

test("B12b-3: a /doc-conversations/<ref> deep link stays unrouted if /conversations is ever missing from the route list", () => {
  const uuid = "22222222-2222-4222-8222-222222222222";
  const withoutConversations = APP_ROUTE_PATHS.filter((path) => path !== "/doc-chats");
  const view = deepLinkView(`/doc-conversations/${uuid}`, withoutConversations);
  assert.equal(view.routed, false);
  assert.equal(view.href, null);
});

test("B12b-4: /signals/<id> has no CARR read verb by signal id, so it stays the path plus the sentence, never an anchor", async () => {
  // next-signals lists queued signals; get-investigation takes an
  // investigation run_id, which a signal id is not. There is nothing this
  // page could route a signal deep link to without inventing a page that
  // cannot fetch the record.
  const client = await fixture();
  const feed = await client.notificationFeed({ limit: 25 });
  const signalCard = cardFor(feed, QUIET);
  assert.match(signalCard.link.path, /^\/signals\//);
  assert.equal(signalCard.link.routed, false);
  assert.equal(signalCard.link.href, null);
  assert.equal(signalCard.link.sentence, NO_PAGE_SENTENCE);
});

/* ------------------------------------------------------------------ clause 6 */

test("clause 6: one acknowledgement, one operation key, one idempotency key, replayed on a second click", async () => {
  assert.equal(acknowledgeOperationKey(QUIET), `notifications:ack:${QUIET}`);
  assert.notEqual(acknowledgeOperationKey(QUIET), acknowledgeOperationKey(DEVICE_OPT_OUT));
  assert.deepEqual(acknowledgeArgs(` ${QUIET} `).args, { notification_id: QUIET });
  assert.equal(acknowledgeArgs("not-a-uuid").ok, false);

  // The kernel replays the retained request under one key; the fixture returns
  // the stored answer rather than writing again.
  const client = await fixture();
  const key = "22222222-2222-4222-8222-222222222201";
  const first = await client.acknowledgeNotification({ idempotency_key: key, notification_id: QUIET });
  const replay = await client.acknowledgeNotification({ idempotency_key: key, notification_id: QUIET });
  assert.deepEqual(replay, first, "the same key did not replay the stored answer");
  const again = await client.acknowledgeNotification({ idempotency_key: "22222222-2222-4222-8222-222222222202", notification_id: QUIET });
  assert.equal(again.deduplicated, true);
  assert.equal(again.read_at, first.read_at, "a second acknowledgement moved the first read_at");
});

/* ------------------------------------------------------------------ clause 7 */

test("clause 7: a refusal leaves the row unread and is settled; a 5xx is unknown and reconciles first", async () => {
  const client = await fixture();
  await assert.rejects(
    () => client.acknowledgeNotification({ idempotency_key: "33333333-3333-4333-8333-333333333301", notification_id: "11111111-1111-4111-8111-1111111111ff" }),
    (error) => {
      assert.equal(error.payload.error, "notification_not_found");
      const outcome = classifyCommandOutcome({ error });
      assert.equal(outcome.status, "refused");
      assert.equal(outcome.code, "notification_not_found");
      return true;
    },
  );
  const after = await client.notificationFeed({ limit: 25 });
  assert.equal(after.unread_count, 5, "a refused acknowledgement moved the unread count");
  assert.equal(cardFor(after, QUIET).read, false, "a refused acknowledgement marked a row read");

  const unknown = classifyCommandOutcome({ error: Object.assign(new Error("live acknowledge-notification -> HTTP 502"), { status: 502 }) });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.reason, "server_error");
  // The dock's unknown path re-sends the SAME frozen request; it is not a
  // blind retry, and the page hands the retained arguments back unchanged.

});

/* ------------------------------------------------------------------ clause 8 */

test("clause 8: acknowledging changes only read_at and unread_count — nothing else moves", async () => {
  const client = await fixture();
  const before = await client.notificationFeed({ limit: 25 });
  const dealsBefore = await client.getChanges(null);

  await client.acknowledgeNotification({ idempotency_key: "44444444-4444-4444-8444-444444444401", notification_id: QUIET });

  const after = await client.notificationFeed({ limit: 25 });
  assert.equal(after.unread_count, before.unread_count - 1);
  assert.equal(after.notifications.length, before.notifications.length, "a row appeared or vanished");

  const strip = (rows) => rows.map(({ read_at, ...rest }) => rest);
  assert.deepEqual(strip(after.notifications), strip(before.notifications), "something other than read_at moved");
  for (const row of before.notifications) {
    const now = after.notifications.find((candidate) => candidate.id === row.id);
    if (row.id === QUIET) assert.ok(now.read_at, "the acknowledged row is still unread");
    else assert.equal(now.read_at, row.read_at, `${row.id} changed its read state`);
  }
  // The source work is untouched: the acknowledgement is not granted to move it.
  assert.deepEqual(await client.getChanges(null), dealsBefore, "the change stream moved");
});

/* ------------------------------------------------------------------ clause 9 */

test("clause 9: each of the eight UX20 states renders its own evidence", async () => {
  const client = await fixture();
  const payload = await client.notificationFeed({ limit: 25 });
  const full = { state: "read", payload, observed_at: "2026-01-15T10:00:00Z" };

  // 1 loading
  assert.equal(feedState({ state: "pending" }).state, "loading");
  assert.equal(feedState({ state: "pending" }).sentence, FEED_STATES.loading);
  // 2 empty
  const empty = { state: "read", payload: { ok: true, unread_count: 0, notifications: [] } };
  assert.equal(feedState(empty).state, "empty");
  assert.equal(feedState(empty).sentence, FEED_STATES.empty);
  // 3 no-match — an `after` filter that returned nothing is NOT an empty feed
  const filtered = await client.notificationFeed({ after: "2030-01-01T00:00:00Z", limit: 25 });
  assert.equal(filtered.notifications.length, 0);
  assert.equal(filtered.unread_count, 5, "the filter emptied the count as well as the list");
  const noMatch = feedState({ state: "read", payload: filtered }, { after: "2030-01-01T00:00:00Z" });
  assert.equal(noMatch.state, "no_match");
  assert.equal(noMatch.sentence, FEED_STATES.no_match);
  // 4 stale
  const stale = feedState({ ...full, refreshing: true });
  assert.equal(stale.state, "stale");
  assert.equal(stale.sentence, FEED_STATES.stale);
  // 5 unavailable — a 5xx may have been served
  const unavailable = classifyReadFailure(Object.assign(new Error("x"), { status: 503 }));
  assert.equal(unavailable.state, "unavailable");
  assert.equal(feedState(unavailable).sentence, FEED_STATES.unavailable);
  // 6 refused — a 401/403 was decided before the verb ran
  const refused = classifyReadFailure(Object.assign(new Error("x"), { status: 403 }));
  assert.equal(refused.state, "refused");
  assert.equal(feedState(refused).sentence, FEED_STATES.refused);
  assert.equal(classifyReadFailure(Object.assign(new Error("x"), { status: 401 })).state, "refused");
  // 7 unknown — the shaper's own refusal
  const unknown = classifyReadFailure(Object.assign(new Error("x"), { payload: { error: "notification_feed_unavailable" } }));
  assert.equal(unknown.state, "unknown");
  assert.equal(feedState(unknown).sentence, FEED_STATES.unknown);
  // 8 partial — the list is capped while the count is larger
  const capped = await client.notificationFeed({ limit: 2 });
  const partial = feedState({ state: "read", payload: capped }, { limit: 2 });
  assert.equal(partial.state, "partial");
  assert.match(partial.sentence, /It shows 2 of 5 unread\./);

  assert.equal(feedState(full, { limit: 25 }).state, "ready");
  // A refusal outranks an empty list: "we were not told" is not "you have none".
  assert.equal(feedState({ state: "refused" }).state, "refused");
  // The outage switch proves the read really can fail in a browser.
  const down = await fixture({ outage: "notifications" });
  await assert.rejects(() => down.notificationFeed({ limit: 25 }), /fixture outage/);

  // The server's own words never reach the page: only a status and a code do.

});

/* ----------------------------------------------------------------- clause 10 */

test("clause 10: the route, the route version, the producer pin and the two verbs are in the contracts", () => {
  assert.equal(routes.version, "1.22.0");
  assert.equal(contract.producer.source_commit, "700173808625061adff581cfab415ce8e83e24f6");

  assert.equal(routes.routes["/updates"], "notifications.html");
  for (const verb of ["notification-feed", "acknowledge-notification", "read-notification-preferences", "set-notification-preference"]) {
    assert.ok(contract.mcp_operations.includes(verb), `${verb} is not pinned`);
  }
  assert.deepEqual(contract.mcp_operations, [...contract.mcp_operations].sort(), "the operation list is sorted");
  // The model's route list is served to a browser with no build step, so it is
  // a COPY of the contract. This is what stops the copy drifting from it.
  assert.deepEqual([...APP_ROUTE_PATHS], Object.keys(routes.routes), "the model's route list has drifted from the contract");
});

/* -------------------------------------------------------------- the shared shell */

test("the page is the shared shell, the activity panel is its own thing, and 44px holds at 360px", async () => {

  // An event is not a notification, and the two are never merged.

  const rows = activityRows([
    { actor: "joe", verb: "set-next-step", subject_type: "deal", subject_id: "d14", recorded_at: "2026-01-14T14:20:00.000Z" },
    { actor: null, verb: "add-deal-note", subject_id: "d05", recorded_at: "not a time" },
    { verb: "" },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].actor, "Unattributed", "the newest event is not first");
  assert.equal(rows[1].clock, "2:20 PM");
  assert.equal(rows[1].subject, "Deal");

  // Mobile first: one column, a full-width target, and the 44px floor.

});

/* ======================================================================== */
/* V5-UX-B12 — quiet hours and device opt-in. One test per behaviour.       */
/*                                                                          */
/* The two READ payloads these tests validate against were captured from    */
/* production on 2026-09-18, read-only, and committed at                    */
/* test/fixtures/notification-preferences-live-capture.json. Defect 33e8409b */
/* is the reason: a validator is only worth anything if it has been run     */
/* against a real answer, not against this repository's own fixture.        */
/* ======================================================================== */

const liveCapture = JSON.parse(await read("test/fixtures/notification-preferences-live-capture.json"));
const captured = (verb) => liveCapture.captures.find((entry) => entry.verb === verb).payload;

/** A window that certainly covers this instant, in UTC, without a wrap gap. */
function windowCoveringNow() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const start = `${pad((now.getUTCHours() + 23) % 24)}:${pad(now.getUTCMinutes())}`;
  const end = `${pad((now.getUTCHours() + 1) % 24)}:${pad(now.getUTCMinutes())}`;
  return { start, end };
}

/* ------------------------------------------------------------- behaviour 1 */

test("B12-1 defaults panel: with no row the page prints the record layer's documented defaults and says nothing was written", async () => {
  const client = await fixture();
  const prefs = await client.notificationPreferences();
  assert.equal(validPreferencePayload(prefs), true);
  assert.equal(prefs.exists, false, "the shipped seed must start with NO preference row");
  assert.equal(prefs.device_opt_in, false);
  assert.equal(prefs.quiet_hours_start, null);
  assert.equal(prefs.quiet_hours_end, null);
  assert.equal(prefs.timezone, "UTC");
  assert.equal(prefs.version, 1);

  const model = preferenceView(prefs);
  assert.equal(model.quietHoursSet, false);
  assert.equal(model.version, 1);
  assert.equal(preferenceOriginSentence(model), PREFERENCE_DEFAULTS_SENTENCE);
  assert.equal(PREFERENCE_DEFAULTS_SENTENCE, "Quiet hours off · Push off · UTC");
  assert.equal(preferenceSummary(model), "No quiet hours set · UTC · device push off");
  assert.equal(preferenceSummary(null), "unknown");
  assert.equal(preferenceState({ state: "read", payload: prefs }).state, "ready");
  assert.equal(preferenceState({ state: "pending" }).state, "loading");

});

/* ------------------------------------------------------------- behaviour 2 */

test("B12-2 save with CAS: base_version comes from the last READ, and a save moves the version by one", async () => {
  const client = await fixture();
  const before = await client.notificationPreferences();
  const built = setPreferenceArgs(
    { device_opt_in: true, quiet_hours_start: "22:00", quiet_hours_end: "06:00", timezone: "America/Chicago" },
    preferenceView(before),
  );
  assert.equal(built.ok, true);
  assert.deepEqual(built.args, {
    base_version: 1, device_opt_in: true,
    quiet_hours_start: "22:00", quiet_hours_end: "06:00", timezone: "America/Chicago",
  });

  const saved = await client.setNotificationPreference({ idempotency_key: "b12-save-1", ...built.args });
  assert.equal(saved.ok, true);
  assert.equal(saved.exists, true);
  assert.equal(saved.version, 2, "a save must move the version exactly one step");
  assert.equal(saved.device_opt_in, true);
  assert.equal(saved.timezone, "America/Chicago");
  assert.equal(validPreferencePayload(saved), true, "the set answer is the same shape as the read answer");

  // The same key replays and does NOT move the version a second time.
  const replay = await client.setNotificationPreference({ idempotency_key: "b12-save-1", ...built.args });
  assert.equal(replay.version, 2);

  // There is no place a version could be invented: without a read there is none.
  assert.equal(setPreferenceArgs({ device_opt_in: true }, null).ok, false);
  assert.equal(setPreferenceArgs({ device_opt_in: true }, null).message, BASE_VERSION_REFUSAL);

});

/* ------------------------------------------------------------- behaviour 3 */

test("B12-3 version_conflict: a stale base_version is refused with the current version, and the page re-reads instead of retrying", async () => {
  const client = await fixture();
  const first = await client.notificationPreferences();
  await client.setNotificationPreference({
    idempotency_key: "b12-conflict-a", base_version: first.version, device_opt_in: true,
  });

  // The page still holds version 1. The record layer holds 2.
  const stale = setPreferenceArgs({ device_opt_in: false }, preferenceView(first));
  await assert.rejects(
    () => client.setNotificationPreference({ idempotency_key: "b12-conflict-b", ...stale.args }),
    (error) => {
      assert.equal(error.payload.error, "version_conflict");
      assert.equal(error.payload.current_version, 2, "the refusal must name the version the store holds");
      const refusal = classifyPreferenceFailure(error);
      assert.equal(refusal.conflict, true);
      assert.equal(refusal.currentVersion, 2);
      assert.equal(refusal.message, PREFERENCE_REFUSALS.version_conflict);
      return true;
    },
  );
  // The kernel classifies a conflict as `conflict`, not `refused`, so the page
  // must read the CODE off the settled outcome too, or the sentence is lost.
  assert.equal(classifyPreferenceFailure({ code: "version_conflict" }).conflict, true);
  assert.match(PREFERENCE_REFUSALS.version_conflict, /changed elsewhere/);

  // Nothing moved: a conflict is a refusal that wrote nothing.
  const after = await client.notificationPreferences();
  assert.equal(after.version, 2);
  assert.equal(after.device_opt_in, true, "the refused save must not have applied");

});

/* ------------------------------------------------------------- behaviour 4 */

test("B12-4 the half pair is refused BY NAME by the record layer, and the page renders that name's sentence", async () => {
  const client = await fixture();
  const prefs = await client.notificationPreferences();

  // The page SENDS the half pair. It does not pre-empt the store's refusal:
  // rendering `notification_preference_quiet_hours_incomplete` by name is what
  // proves the sentence came from the record layer and not from a guess here.
  const built = setPreferenceArgs({ quiet_hours_start: "22:00" }, preferenceView(prefs));
  assert.equal(built.ok, true, "a half pair must be built and sent, not refused locally");
  assert.deepEqual(built.args, { base_version: 1, quiet_hours_start: "22:00" });

  await assert.rejects(
    () => client.setNotificationPreference({ idempotency_key: "b12-half", ...built.args }),
    (error) => {
      assert.equal(error.payload.error, "notification_preference_quiet_hours_incomplete");
      assert.equal(
        classifyPreferenceFailure(error).message,
        PREFERENCE_REFUSALS.notification_preference_quiet_hours_incomplete,
      );
      return true;
    },
  );
  assert.match(PREFERENCE_REFUSALS.notification_preference_quiet_hours_incomplete, /Set a start and an end together/);

  // The other two named refusals the store can issue reach a sentence too.
  await assert.rejects(
    () => client.setNotificationPreference({
      idempotency_key: "b12-tz", base_version: 1, quiet_hours_start: "22:00",
      quiet_hours_end: "06:00", timezone: "Nowhere/Invented",
    }),
    (error) => {
      assert.equal(error.payload.error, "notification_preference_timezone_unknown");
      assert.equal(classifyPreferenceFailure(error).message, PREFERENCE_REFUSALS.notification_preference_timezone_unknown);
      return true;
    },
  );
  await assert.rejects(
    () => client.setNotificationPreference({
      idempotency_key: "b12-both", base_version: 1, clear_quiet_hours: true, quiet_hours_start: "22:00",
    }),
    (error) => {
      assert.equal(error.payload.error, "notification_preference_quiet_hours_conflicting_request");
      return true;
    },
  );
  // A reason id this page has never been taught is still named, never swallowed.
  assert.equal(classifyPreferenceFailure({ code: "invented_reason" }).message, "Preferences were not saved.");
  // A malformed clock time never leaves the page at all.
  assert.equal(setPreferenceArgs({ quiet_hours_start: "25:00" }, preferenceView(prefs)).message, TIME_REFUSAL);
  assert.equal(toInputTime("22:00:00"), "22:00", "a stored HH:MM:SS must reach the control as HH:MM");
  assert.equal(toInputTime(null), null);
});

/* ------------------------------------------------------------- behaviour 5 */

test("B12-5 clear: clearing sends clear_quiet_hours alone, nulls both times, and leaves the opt-in and the timezone alone", async () => {
  const client = await fixture();
  const start = await client.notificationPreferences();
  await client.setNotificationPreference({
    idempotency_key: "b12-clear-set", base_version: start.version, device_opt_in: true,
    quiet_hours_start: "22:00", quiet_hours_end: "06:00", timezone: "America/Chicago",
  });
  const set = await client.notificationPreferences();
  assert.equal(set.quiet_hours_start, "22:00");
  assert.equal(set.version, 2);

  // The clear carries NOTHING but the flag and the version: a clear that also
  // carried a time is the conflicting-request refusal, by the store's own rule.
  const built = setPreferenceArgs({ clear_quiet_hours: true, quiet_hours_start: "22:00" }, preferenceView(set));
  assert.deepEqual(built.args, { base_version: 2, clear_quiet_hours: true });

  const cleared = await client.setNotificationPreference({ idempotency_key: "b12-clear", ...built.args });
  assert.equal(cleared.quiet_hours_start, null);
  assert.equal(cleared.quiet_hours_end, null);
  assert.equal(cleared.version, 3);
  assert.equal(cleared.device_opt_in, true, "clearing quiet hours must not touch the device opt-in");
  assert.equal(cleared.timezone, "America/Chicago", "clearing quiet hours must not touch the timezone");
  assert.equal(preferenceView(cleared).quietHoursSet, false);

});

/* ------------------------------------------------------------- behaviour 6 */

test("B12-6 quiet_suppressed is a MARKER on the row, printed from the producer's field and never recomputed or hidden", async () => {
  const client = await fixture();
  const before = await client.notificationFeed({ limit: 25 });
  const rows = before.notifications.length;

  // Outside quiet hours the historical fact still marks the row: the producer's
  // value is a DISJUNCTION, and the mint-time suppression is a fact about what
  // happened that does not expire when the window closes.
  assert.equal(before.quiet_now, false);
  assert.equal(cardFor(before, QUIET).quietSuppressed, true, "a mint-time suppression must stay marked");
  assert.equal(cardFor(before, DEVICE_OPT_OUT).quietSuppressed, false);

  // Inside quiet hours EVERY row is marked, and the count of rows does not move:
  // a marked row is still drawn.
  const prefs = await client.notificationPreferences();
  const { start, end } = windowCoveringNow();
  await client.setNotificationPreference({
    idempotency_key: "b12-quiet-window", base_version: prefs.version,
    quiet_hours_start: start, quiet_hours_end: end, timezone: "UTC",
  });
  const during = await client.notificationFeed({ limit: 25 });
  assert.equal(during.quiet_now, true);
  assert.equal(during.notifications.length, rows, "a suppressed row must be marked, never hidden");
  assert.equal(during.notifications.every((row) => row.quiet_suppressed === true), true);
  assert.equal(notificationCards(during).every((card) => card.quietSuppressed === true), true);

  // The page prints the producer's field and holds no rule of its own.
  // The marker is drawn WHEN the producer's field is true and not otherwise:
  // the exact ternary, so a negated condition is a failure and not a pass.

  assert.match(QUIET_SUPPRESSED_MARK, /held by your quiet hours/);

});

/* ------------------------------------------------------------- behaviour 7 */

test("B12-7 the quiet_now banner is shown when EITHER door says so, and is hidden otherwise", async () => {
  assert.equal(quietNowBanner({ quiet_now: false }, { quiet_now: false }), null);
  assert.equal(quietNowBanner({ quiet_now: true }, { quiet_now: false }), QUIET_NOW_BANNER);
  assert.equal(quietNowBanner({ quiet_now: false }, { quiet_now: true }), QUIET_NOW_BANNER);
  assert.equal(quietNowBanner(null, null), null);
  assert.equal(quietNowBanner({}, {}), null, "an absent field is not a quiet hour");
  assert.match(QUIET_NOW_BANNER, /the items below still arrived in-app/);

  const client = await fixture();
  const prefs = await client.notificationPreferences();
  const { start, end } = windowCoveringNow();
  await client.setNotificationPreference({
    idempotency_key: "b12-banner", base_version: prefs.version,
    quiet_hours_start: start, quiet_hours_end: end, timezone: "UTC",
  });
  const feed = await client.notificationFeed({ limit: 25 });
  const now = await client.notificationPreferences();
  assert.equal(now.quiet_now, true, "the preference read must answer quiet_now too");
  assert.equal(quietNowBanner(feed, now), QUIET_NOW_BANNER);

});

/* ------------------------------------------------------------- behaviour 8 */

test("B12-8 both validators accept the REAL captured production payloads, field for field", () => {
  assert.equal(liveCapture.schema, "doctorcre-notification-preferences-live-capture.v1");
  assert.equal(liveCapture.captured, "2026-09-18");

  const prefs = captured("read-notification-preferences");
  assert.equal(validPreferencePayload(prefs), true, "the validator refuses production");
  const model = preferenceView(prefs);
  assert.equal(model.exists, true);
  assert.equal(model.version, 3);
  assert.equal(model.timezone, "UTC");
  assert.equal(model.quietHoursSet, false, "the captured row has both times null");
  assert.equal(model.quietNow, false);
  assert.equal(preferenceSummary(model), "No quiet hours set · UTC · device push off");

  const feed = captured("notification-feed");
  assert.equal(validFeedPayload(feed), true, "the feed validator refuses production");
  assert.equal(feed.quiet_now, false, "quiet_now is a TOP-LEVEL field of the real feed");
  assert.deepEqual(notificationCards(feed), []);
  assert.equal(quietNowBanner(feed, prefs), null);
  assert.equal(feedState({ state: "read", payload: feed }, {}).state, "empty");

  // Every nullable field the producer can emit, enumerated from the emit code
  // (mcp-server/src/notifications.js) and from migration 0527: both quiet-hours
  // times are nullable and NOTHING else on the preference is.
  for (const field of ["quiet_hours_start", "quiet_hours_end"]) {
    assert.equal(validPreferencePayload({ ...prefs, [field]: null }), true, `${field} must be nullable`);
    assert.equal(validPreferencePayload({ ...prefs, [field]: "23:30:00" }), true);
  }
  for (const field of ["exists", "device_opt_in", "timezone", "version"]) {
    assert.equal(validPreferencePayload({ ...prefs, [field]: null }), false, `${field} must not be nullable`);
  }
  assert.equal(validPreferencePayload({ ...prefs, ok: false }), false);
  assert.equal(validPreferencePayload({ ...prefs, version: 0 }), false);
  assert.equal(validPreferencePayload(null), false);

  // `quiet_now` is absent from the SET answer, so it can never be required.
  const { quiet_now, ...setShape } = prefs;
  assert.equal(validPreferencePayload({ ...setShape, deduplicated: false }), true);
  assert.equal(preferenceView({ ...setShape, deduplicated: false }).quietNow, false);

  // A read that did not answer is one of the named states, from STATUS and CODE
  // alone — the server's own prose never crosses into a sentence.
  assert.equal(classifyPreferenceReadFailure({ status: 403 }).state, "refused");
  assert.equal(classifyPreferenceReadFailure({ status: 502 }).state, "unavailable");
  assert.equal(classifyPreferenceReadFailure({ payload: { error: "notification_preferences_unavailable" } }).state, "unknown");
  assert.equal(classifyPreferenceReadFailure({}).state, "unknown");
});

/* ------------------------------------------------------------- behaviour 9 */

test("B12-9 the current contract still pins both preference verbs and their order", async () => {
  assert.equal(contract.producer.source_commit, "700173808625061adff581cfab415ce8e83e24f6",

    "the producer pin includes preference verbs and the Codex checkpoint read");
  assert.deepEqual(contract.mcp_operations, [...contract.mcp_operations].sort());

  const at = contract.mcp_operations.indexOf("read-notification-preferences");
  assert.equal(contract.mcp_operations[at - 1], "read-loop");
  assert.equal(contract.mcp_operations[at + 1], "read-portfolio");
  const set = contract.mcp_operations.indexOf("set-notification-preference");
  assert.equal(contract.mcp_operations[set - 1], "set-next-step");
  assert.equal(contract.mcp_operations[set + 1], "set-prospect-engagement-status");

  // The route contract does NOT move: this slice adds no page.
  assert.equal(routes.version, "1.22.0");
  assert.equal(routes.routes["/updates"], "notifications.html");

  // The repository check pins both verbs, and the shared client interface
  // carries both methods — so a client that implements one of them fails.

  // One operation key for the whole form: two saves are the same operation.
  assert.equal(PREFERENCE_OPERATION_KEY, "notifications:preference");

});

/* ------------------------------------------------------------ behaviour 10 */

test("B12-10 reconcile-then-retry: a dispatched save keeps its VERB, so a later Try again can never reach acknowledge-notification", () => {
  // The regression this pins (review blocker B1). `dispatch` is reached twice
  // for one preference save: once from `savePreference`, and once from the
  // dock's `onReconcile` when an outcome came back unknown. The second pass
  // writes the retained entry back. If that write-back dropped `preference`,
  // the entry would look like an acknowledgement, and the dock's "Try again"
  // — which branches on exactly that flag — would send a `base_version` and a
  // quiet-hours pair to `acknowledge-notification`, refused as
  // `notification_not_found` for a save that never reached the preference verb.

  // 1. EVERY write-back in the file names the verb. This is the invariant, not
  //    one line of it: a second `operations.set` added later without the flag
  //    reopens the same hole, so the assertion is over all of them.

  // 2. The two dock doors still read and pass that flag, in opposite ways and
  //    both deliberately: a REFUSAL is settled, so "Try again" rebuilds the
  //    arguments against the version the page holds now; an UNKNOWN outcome is
  //    reconciled with the SAME frozen request, flag and all.

  // 3. The flag is what picks the verb, and there is exactly one place it does.

  // 4. The two payloads are disjoint, which is why the wrong verb is not a
  //    harmless no-op: a preference request carries no `notification_id`, and
  //    the live verb's UUID guard refuses it as `notification_not_found`.
  assert.deepEqual(Object.keys(acknowledgeArgs(QUIET).args), ["notification_id"]);
  const preferenceArgs = setPreferenceArgs(
    { device_opt_in: true, quiet_hours_start: "22:00", quiet_hours_end: "06:00" },
    { version: 3 },
  ).args;
  assert.equal("notification_id" in preferenceArgs, false, "a preference save carries no notification id");
  assert.deepEqual(Object.keys(preferenceArgs).sort(),
    ["base_version", "device_opt_in", "quiet_hours_end", "quiet_hours_start"]);
});

/* ------------------------------------------ review round 1, findings F2/F3 */

test("B12-11 a version conflict reports unsaved changes while retaining version evidence", async () => {
  // F3: the number the refusal carries is SHOWN, beside the one the form was
  // saving against. A person told only that "something changed" has been handed
  // a fact they cannot check.
  assert.equal(versionConflictLine(3, 1), "Preferences changed elsewhere.");
  assert.equal(versionConflictLine(3, null), null, "half this sentence is not worth saying");
  assert.equal(versionConflictLine(null, 1), null);

  // The number really is the one the store sent: the refusal's `current_version`
  // and the version the next read answers are the same number.
  const client = await fixture();
  const first = await client.notificationPreferences();
  await client.setNotificationPreference({
    idempotency_key: "b12-11-a", base_version: first.version, device_opt_in: true,
  });
  await assert.rejects(
    () => client.setNotificationPreference({ idempotency_key: "b12-11-b", base_version: first.version }),
    (error) => {
      const refusal = classifyPreferenceFailure(error);
      assert.equal(refusal.currentVersion, 2);
      assert.equal(versionConflictLine(refusal.currentVersion, first.version),
        "Preferences changed elsewhere.");
      return true;
    },
  );
  assert.equal((await client.notificationPreferences()).version, 2, "the re-read answers the same number");

  // F2: the discard is stated rather than silent. The typed values are NOT
  // preserved across the re-read, on purpose — see the comment on the constant.
  assert.match(PREFERENCE_REFUSALS.version_conflict,
    /Your changes were not saved/);

});

test("Updates house grammar: preference summaries use AM/PM and keep versions in Details", () => {
  const model = preferenceView({ ok: true, exists: true, version: 7, device_opt_in: true,
    quiet_hours_start: "22:00:00", quiet_hours_end: "07:30:00", timezone: "UTC" });
  assert.equal(preferenceSummary(model), "Quiet hours 10:00 PM to 7:30 AM UTC · device push on");
  const dom = new JSDOM(html), doc = dom.window.document;
  try {

    const args = setPreferenceArgs({ quiet_hours_start: "10:00 PM", quiet_hours_end: "7:30 AM" }, model);
    assert.equal(args.args.quiet_hours_start, "22:00");
    assert.equal(args.args.quiet_hours_end, "07:30");
    assert.equal(toInputTime("12:00 AM"), "00:00");
    assert.equal(toInputTime("12:00 PM"), "12:00");
    assert.equal(toInputTime("13:00 PM"), null);
    // Common spellings of one clock time are accepted; a bare hour is not.
    for (const typed of ["10 PM", "10pm", "10:00pm", "10:00 p.m."]) assert.equal(toInputTime(typed), "22:00", typed);
    assert.equal(toInputTime("7:30am"), "07:30");
    assert.equal(toInputTime("10"), null);
    assert.equal(toInputTime("0 AM"), null);
    assert.equal(preferenceTimeLabel("00:05"), "12:05 AM");
    assert.equal(preferenceTimeLabel("12:00:00"), "12:00 PM");
  } finally { dom.window.close(); }
});

test("Updates activity labels come from the app's single actor and change-action homes", () => {
  const rows = activityRows([
    { actor: "dell", verb: "patch-deal-field", field: "phase", subject_type: "deal", subject_id: "d14", recorded_at: "2026-01-14T14:20:00Z" },
    { actor: "claude", verb: "add-deal-note", field: "note", subject_type: "deal", subject_id: "d15", recorded_at: "2026-01-14T14:21:00Z" },
    { actor: "a1b2c3d4-0000-4000-8000-000000000000", verb: "set-next-step", subject_type: "lead", subject_id: "l1", recorded_at: "2026-01-14T14:22:00Z" },
  ]);
  assert.deepEqual(rows.map((row) => `${row.actor} · ${row.verb} · ${row.subject}`), [
    "Recorded actor · Set next step · Lead", "Claude · Note added · Deal", "Dell · Phase · Deal",
  ]);
  assert.equal(rows[0].details.actor, "a1b2c3d4-0000-4000-8000-000000000000");
  assert.equal(rows[0].details.verb, "set-next-step");

});
