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

import {
  ACKNOWLEDGE_SCOPE, APP_ROUTE_PATHS, DEVICE_OFF, EXPOSURE_STATEMENT, FEED_STATES,
  NO_PAGE_SENTENCE, QUIET_HOURS_EFFECT, QUIET_HOURS_UNAVAILABLE, SEVERITIES, SEVERITY_LABELS,
  acknowledgeArgs, acknowledgeOperationKey, activityRows, classifyReadFailure, deepLinkView,
  deliveryPhrases, feedState, notificationCards, unreadLine, validFeedPayload,
} from "../js/notifications-model.js";
import { classifyCommandOutcome } from "../js/command-feedback.mjs";
import { createFixtureClient } from "../js/fixture-client.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const html = await read("notifications.html");
const css = await read("css/notifications.css");
const pageJs = await read("js/notifications.js");
const routes = JSON.parse(await read("contracts/app-routes.v1.json"));
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
  assert.match(pageJs, /\$\("unreadLine"\)\.textContent = unreadLine\(payload\)/);
  assert.equal(/unread_count\s*=|notifications\.filter\(/.test(pageJs), false, "the page derives a count of its own");
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
  assert.match(css, /\.severity-chip\[data-severity="action_required"\]/);
  assert.match(css, /\.severity-chip\[data-severity="failure"\]/);
  assert.equal(/\[data-severity="(?!action_required|failure|\$)/.test(css), false, "a third severity is styled");
  assert.match(html, /Routine progress mints nothing/);
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
  assert.equal(deliveryPhrases([{ channel: "device", state: "queued" }])[0].phrase, "recorded as queued");
});

/* ------------------------------------------------------------------ clause 4 */

test("clause 4: the quiet-hours region says what is unavailable and carries no control", () => {
  const region = /<section class="card glass" data-section="quiet_hours"[\s\S]*?<\/section>/.exec(html);
  assert.ok(region, "the quiet-hours region is missing");
  const block = region[0];
  for (const tag of ["input", "select", "button", "textarea", "form"]) {
    assert.equal(new RegExp(`<${tag}[\\s>]`).test(block), false, `the quiet-hours region draws a <${tag}>`);
  }
  assert.match(QUIET_HOURS_UNAVAILABLE, /cannot be read or changed from this app yet/);
  assert.match(QUIET_HOURS_EFFECT, /holds a device push instead of dropping it/);
  assert.match(pageJs, /\$\("quietHoursUnavailable"\)\.textContent = QUIET_HOURS_UNAVAILABLE/);
  assert.match(pageJs, /\$\("quietHoursEffect"\)\.textContent = QUIET_HOURS_EFFECT/);
  // No preference verb is reachable from this page, because none exists.
  for (const verb of ["set-notification-preference", "notification-preferences", "setNotificationPreference"]) {
    assert.equal(html.includes(verb), false, `${verb} appears on the page`);
    assert.equal(pageJs.includes(verb), false, `${verb} appears in the page script`);
  }
});

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
  assert.equal(deepLinkView("/notifications").href, "/notifications");
  assert.equal(deepLinkView(null).path, null);
  assert.match(pageJs, /data-link="unrouted"/);
  assert.match(pageJs, /data-link="routed"/);
  assert.match(css, /\.note-link \{[^}]*overflow-wrap: anywhere; \}/);
});

/* ------------------------------------------------------------------ clause 6 */

test("clause 6: one acknowledgement, one operation key, one idempotency key, replayed on a second click", async () => {
  assert.equal(acknowledgeOperationKey(QUIET), `notifications:ack:${QUIET}`);
  assert.notEqual(acknowledgeOperationKey(QUIET), acknowledgeOperationKey(DEVICE_OPT_OUT));
  assert.deepEqual(acknowledgeArgs(` ${QUIET} `).args, { notification_id: QUIET });
  assert.equal(acknowledgeArgs("not-a-uuid").ok, false);

  assert.match(pageJs, /import \{ createCommandState, performCommand \} from "\.\/command-feedback\.mjs"/);
  assert.match(pageJs, /await performCommand\(\{/);
  assert.match(pageJs, /newKey: uuidv4/);
  assert.match(pageJs, /client\.acknowledgeNotification\(request\)/);
  assert.match(pageJs, /createCommandDock\(\{/, "the dock is not mounted");
  assert.equal(/idempotency_key/.test(pageJs), false, "the page mints its own key instead of the kernel's");

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
  assert.match(pageJs, /onReconcile: \(operationKey\) => \{/);
  assert.match(pageJs, /const entry = operations\.get\(operationKey\);/);
  assert.match(pageJs, /if \(entry\?\.args\) dispatch\(operationKey, entry\.args, entry\.summary\);/);
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
  assert.match(ACKNOWLEDGE_SCOPE, /does not complete, close or change the work/);
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
  assert.match(pageJs, /block\.setAttribute\("data-state", state\.state\)/);
  // The server's own words never reach the page: only a status and a code do.
  assert.equal(/error\.message|await response\.text\(\)|error\.body/.test(pageJs), false, "the page can paint the server's words");
});

/* ----------------------------------------------------------------- clause 10 */

test("clause 10: the route, the versions, the producer pin and the two verbs are in the contracts", () => {
  assert.equal(routes.version, "1.10.0");
  assert.equal(contract.version, "1.11.0");
  assert.equal(contract.producer.source_commit, "6d3396e6949b54164b0ac24417a5da3d3b3ac618");
  assert.equal(routes.routes["/notifications"], "notifications.html");
  for (const verb of ["notification-feed", "acknowledge-notification"]) {
    assert.ok(contract.mcp_operations.includes(verb), `${verb} is not pinned`);
  }
  assert.equal(contract.mcp_operations.length, 46);
  assert.deepEqual(contract.mcp_operations, [...contract.mcp_operations].sort(), "the operation list is sorted");
  // The model's route list is served to a browser with no build step, so it is
  // a COPY of the contract. This is what stops the copy drifting from it.
  assert.deepEqual([...APP_ROUTE_PATHS], Object.keys(routes.routes), "the model's route list has drifted from the contract");
});

/* -------------------------------------------------------------- the shared shell */

test("the page is the shared shell, the activity panel is its own thing, and 44px holds at 360px", async () => {
  assert.match(html, /<title>Notifications · DoctorCRE<\/title>/);
  assert.match(html, /<a href="\/notifications" aria-current="page">Notifications<\/a>/);
  assert.match(html, /data-theme="dark" data-density="comfortable" data-motion="full"/);
  assert.match(html, /<meta name="theme-color" content="#07111f">/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/system\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/notifications\.css">/);
  assert.match(html, /<button class="doc-fab" type="button" id="docFab"/);
  assert.equal([...html.matchAll(/class="doc-chat glass" id="docChat"/g)].length, 1, "Doc appears once");
  assert.match(html, /<div id="receiptDock" class="receipt-dock"/, "the dock is not mounted");
  assert.match(html, /<p id="prefsLive" class="sr-only" aria-live="polite">/);
  assert.doesNotMatch(html, /<p class="(?:intro|lede|description)"/);
  assert.doesNotMatch(html, /\bTODO\b/);
  for (const match of html.replace(/\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/g, "<iso>").matchAll(/\b\d{1,2}:\d{2}\b(.{0,4})/g)) {
    assert.match(match[1], /^\s*(AM|PM)/, `"${match[0]}" prints without AM or PM`);
  }

  // An event is not a notification, and the two are never merged.
  assert.match(html, /data-section="activity"/);
  assert.match(html, /data-section="feed"/);
  assert.ok(/data-section="feed"/.exec(html).index < /data-section="activity"/.exec(html).index, "the activity panel is above the feed");
  assert.match(html, /This is the activity stream, not your feed\./);
  assert.match(css, /\[data-section="activity"\] \{ border-style: dashed; \}/);
  const rows = activityRows([
    { actor: "joe", verb: "set-next-step", subject_type: "deal", subject_id: "d14", recorded_at: "2026-01-14T14:20:00.000Z" },
    { actor: null, verb: "add-deal-note", subject_id: "d05", recorded_at: "not a time" },
    { verb: "" },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].actor, "unattributed", "the newest event is not first");
  assert.equal(rows[1].clock, "2:20 PM");
  assert.equal(rows[1].subject, "deal d14");

  // Mobile first: one column, a full-width target, and the 44px floor.
  assert.match(css, /\.btn \{ min-height: var\(--touch\); \}/);
  assert.match(css, /\.chip \{ min-height: var\(--touch\); [^}]*\}/);
  assert.match(css, /\.severity-chip \{[^}]*min-height: var\(--touch\);/);
  assert.match(css, /\.note-act \.btn \{ width: 100%; \}/);
  assert.match(css, /#feedList \.work-item \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.equal(/[^-]width:\s*\d{3,}px/.test(css), false, "a fixed pixel width can force a horizontal scroll");
  assert.match(EXPOSURE_STATEMENT, /on a shared or unlocked phone/);
  assert.match(html, /<p class="caption" id="exposureStatement">/);
});
