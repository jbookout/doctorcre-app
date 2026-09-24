// V5-UX-B12a — the notifications page: DOM wiring only.
//
// Every decision about a payload, a state or a sentence lives in
// ./notifications-model.js, and every decision about what a command DID lives
// in the shared kernel (./command-feedback.mjs) and its dock. This file reads,
// paints, and sends exactly one write.
//
// Four shapes govern the file:
//
//   1. The unread count is painted from the payload and from nothing else. The
//      list is capped at LIMIT while the count is over every row the recipient
//      holds, so a count derived from the cards would be a different number
//      wearing the same label.
//   2. Each read stamps its OWN clock when its answer landed, and a read that
//      did not answer is one of the named states in the app's words. The
//      server's prose never reaches the page: only its STATUS and its CODE
//      cross this boundary.
//   3. The one write goes through performCommand with one operation key per
//      notification id and one idempotency key, and its receipt is the shared
//      dock's. An unknown outcome keeps its entry so "Check outcome" re-sends
//      the SAME frozen request.
//   4. The quiet-hours panel is now a REAL form over WR-000116's two doors, and
//      every save is a compare-and-swap on the version the page last READ. The
//      form is never the source of that version: a `version_conflict` re-reads
//      the preference, re-renders the fields from the answer, and says so, and
//      it is never retried automatically — the value on screen changed, so the
//      person decides again. A suppressed row is MARKED, never hidden.
import { createCommandDock } from "./command-dock.js";
import { createCommandState, performCommand } from "./command-feedback.mjs";
import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountDocDock, mountNotificationBadge, mountPrefs } from "./shell.js";
import { formatClock } from "./visual-system.js";
import {
  ACKNOWLEDGE_SCOPE, EXPOSURE_STATEMENT, PREFERENCE_OPERATION_KEY, QUIET_HOURS_EFFECT,
  QUIET_HOURS_SCOPE, QUIET_SUPPRESSED_MARK,
  acknowledgeArgs, acknowledgeOperationKey, activityRows, classifyPreferenceFailure,
  classifyPreferenceReadFailure, classifyReadFailure, feedState, notificationCards,
  preferenceOriginSentence, preferenceState, preferenceSummary, preferenceView,
  quietNowBanner, setPreferenceArgs, unreadLine, versionConflictLine,
} from "./notifications-model.js";
import { uuidv4 } from "./uuid.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

/** The cap this page asks for, and the number it compares the count against. */
const LIMIT = 25;

/** One place holds what this page believes; nothing else keeps a copy. */
const view = {
  after: null,
  sequence: 0,
  feed: { state: "pending" },
  activity: { state: "pending" },
  preference: { state: "pending" },
};

let client = null;
let commandState = createCommandState();
let dock = { record: () => {}, mount: () => {}, render: () => {} };
/** What each open operation would send again: the dock's buttons need it. */
const operations = new Map();
/** True while a save is in flight, and true while the fields hold an edit. */
let saving = false;
let dirty = false;

function announce(text) {
  const live = $("feedLive");
  if (live && live.textContent !== text) live.textContent = text;
}

const asOf = (read) => (read?.state === "read" && formatClock(read.observed_at)
  ? `As of ${formatClock(read.observed_at)}`
  : "unknown");

/* -------------------------------------------------------------------- painting */

function cardHtml(card) {
  const delivery = card.delivery
    .map((row) => `<li data-channel="${escapeHtml(row.channel)}" data-delivery="${escapeHtml(row.state)}">${escapeHtml(row.phrase)}</li>`)
    .join("");
  const link = card.link.path
    ? (card.link.href
      ? `<p class="note-link" data-link="routed"><a href="${escapeHtml(card.link.href)}">${escapeHtml(card.link.path)}</a></p>`
      : `<p class="note-link" data-link="unrouted"><span class="mono">${escapeHtml(card.link.path)}</span> — ${escapeHtml(card.link.sentence)}</p>`)
    : "";
  const quiet = card.quietSuppressed
    ? `<p class="quiet-mark" data-quiet="suppressed">${escapeHtml(QUIET_SUPPRESSED_MARK)}</p>`
    : "";
  const act = card.read
    ? `<p class="read-mark" data-read="true">Acknowledged at ${escapeHtml(card.readClock || "unknown")}</p>`
    : `<div class="note-act"><button class="btn btn-primary" type="button" data-ack="${escapeHtml(card.id)}">Acknowledge this notification</button></div>`;
  return `<li class="work-item" data-priority="${card.severity === "failure" ? "overdue" : "deadline"}" data-notification="${escapeHtml(card.id)}">
    <div>
      <div class="note-top">
        <span class="severity-chip" data-severity="${escapeHtml(card.severity || "unknown")}">${escapeHtml(card.severityLabel)}</span>
        <span class="read-mark">${escapeHtml(card.clock)}</span>
      </div>
      <h3 class="note-reason">${escapeHtml(card.reason)}</h3>
      <p class="note-subject">${escapeHtml(card.subject)}</p>
      <ul class="note-delivery">${delivery}</ul>
      ${quiet}
      ${link}
      ${act}
    </div>
  </li>`;
}

function renderFeed() {
  const read = view.feed;
  $("feedAsOf").textContent = asOf(read);
  const state = feedState(read, { after: view.after, limit: LIMIT });
  const block = $("feedState");
  block.setAttribute("data-state", state.state);
  $("feedStateTitle").textContent = state.sentence || "";
  block.hidden = state.state === "ready";
  const payload = read.state === "read" ? read.payload : null;
  $("unreadLine").textContent = unreadLine(payload);
  $("feedOrb").setAttribute(
    "data-state",
    state.state === "ready" || state.state === "empty" ? "healthy"
      : ["refused", "unavailable", "unknown"].includes(state.state) ? "urgent" : "still",
  );
  $("feedList").innerHTML = notificationCards(payload).map(cardHtml).join("");
  const banner = $("quietNowBanner");
  const sentence = quietNowBanner(payload, view.preference.payload);
  banner.textContent = sentence || "";
  banner.setAttribute("data-quiet", sentence ? "now" : "off");
  banner.hidden = !sentence;
}

/**
 * The preference panel. The fields are painted from the ANSWER and never from
 * what was typed: a save that landed shows what the record layer now holds, and
 * a save that was refused shows what it still holds. While a save is in flight
 * the form is disabled, because a second save would carry the same stale
 * version and earn a conflict this page could have prevented.
 */
function renderPreference() {
  const read = view.preference;
  const state = preferenceState(read);
  const block = $("prefState");
  block.setAttribute("data-state", state.state);
  $("prefStateTitle").textContent = state.sentence || "";
  block.hidden = state.state === "ready";
  $("prefAsOf").textContent = asOf(read);
  const model = state.state === "ready" ? preferenceView(read.payload) : null;
  $("prefOrigin").textContent = preferenceOriginSentence(model);
  $("prefSummary").textContent = preferenceSummary(model);
  const form = $("prefForm");
  form.hidden = !model;
  form.setAttribute("data-disabled", String(saving));
  for (const id of ["deviceOptIn", "quietStart", "quietEnd", "quietTimezone", "prefSave", "prefClear"]) {
    const field = $(id);
    if (field) field.disabled = saving || !model;
  }
  if (!model || dirty) return;
  $("deviceOptIn").checked = model.deviceOptIn;
  $("quietStart").value = model.start || "";
  $("quietEnd").value = model.end || "";
  $("quietTimezone").value = model.timezone;
}

function renderActivity() {
  const read = view.activity;
  $("activityAsOf").textContent = asOf(read);
  const payload = read.state === "read" ? read.payload : null;
  const rows = activityRows(payload?.events);
  $("activityState").hidden = Boolean(payload);
  $("activityList").innerHTML = rows.map((row) => `<li class="work-item" data-priority="ordinary">
    <div><h3>${escapeHtml(row.actor)} · ${escapeHtml(row.verb)}</h3>
    <div class="work-meta"><span>${escapeHtml(row.subject)} · ${escapeHtml(row.clock)}</span></div></div>
    <div class="stack-end"></div>
  </li>`).join("") || (payload
    ? `<li class="work-item" data-priority="ordinary"><div><h3>No event has been recorded yet</h3><div class="work-meta"><span>read from the change stream</span></div></div><div class="stack-end"></div></li>`
    : "");
}

function render() {
  renderFeed();
  renderActivity();
  renderPreference();
}

/* --------------------------------------------------------------------- reading */

/**
 * One read, settled on its own. A failure is classified from its STATUS and its
 * CODE, which is what tells a decision apart from a silence; the server's own
 * text is never carried into the sentence a person reads.
 */
async function takeFeed() {
  const sequence = view.sequence;
  if (view.feed.state === "read") view.feed = { ...view.feed, refreshing: true };
  render();
  try {
    const args = view.after ? { after: view.after, limit: LIMIT } : { limit: LIMIT };
    const payload = await client.notificationFeed(args);
    if (view.sequence !== sequence) return;
    view.feed = { state: "read", payload, observed_at: new Date().toISOString() };
  } catch (error) {
    if (view.sequence !== sequence) return;
    view.feed = classifyReadFailure(error);
  }
  render();
}

/**
 * The preference read. It passes NOTHING: the verb declares zero properties,
 * and the client method takes no arguments, so there is no place an actor, a
 * tenant or a filter could be introduced here.
 */
async function takePreference() {
  const sequence = view.sequence;
  try {
    const payload = await client.notificationPreferences();
    if (view.sequence !== sequence) return;
    view.preference = { state: "read", payload, observed_at: new Date().toISOString() };
  } catch (error) {
    if (view.sequence !== sequence) return;
    view.preference = classifyPreferenceReadFailure(error);
  }
  render();
}

async function takeActivity() {
  const sequence = view.sequence;
  try {
    const payload = await client.getChanges(null);
    if (view.sequence !== sequence) return;
    view.activity = { state: "read", payload, observed_at: new Date().toISOString() };
  } catch {
    if (view.sequence !== sequence) return;
    view.activity = { state: "unknown" };
  }
  render();
}

async function load() {
  view.sequence += 1;
  await Promise.all([takeFeed(), takeActivity(), takePreference()]);
  const state = feedState(view.feed, { after: view.after, limit: LIMIT });
  announce(state.sentence || unreadLine(view.feed.payload));
}

/* --------------------------------------------------------------------- writing */

async function dispatch(operationKey, args, summary, preference = false) {
  const result = await performCommand({
    operationKey,
    args,
    getState: () => commandState,
    setState: (next) => { commandState = next; },
    newKey: uuidv4,
    call: (request) => (preference
      ? client.setNotificationPreference(request)
      : client.acknowledgeNotification(request)),
  });
  // THE FLAG IS CARRIED, and this is the whole of blocker B1. `dispatch` is
  // reached twice for one preference save — once from `savePreference` and once
  // from the dock's reconcile — and a write-back that dropped `preference`
  // would leave the retained entry looking like an acknowledgement. The next
  // "Try again" would then send a base_version and a quiet-hours pair to
  // `acknowledge-notification`, which refuses it as `notification_not_found`:
  // a preference save reported as a missing notification, having never reached
  // the preference verb at all. Every `operations.set` in this file names the
  // verb, and B12-10 asserts that of all of them.
  operations.set(operationKey, { args, summary, preference });
  dock.record(operationKey, {
    summary, status: result.status, reason: result.message || null,
    retry: result.retry, undo: false, request: result.request,
  });
  if (result.message) announce(result.message);
  // Only the record layer knows what the feed now holds, so a settled write
  // re-reads it rather than marking the card this page hoped for.
  if (result.status === "ok") await load();
  return result;
}

function acknowledge(id) {
  const built = acknowledgeArgs(id);
  if (!built.ok) {
    announce(built.message);
    return;
  }
  const operationKey = acknowledgeOperationKey(built.args.notification_id);
  const summary = `Acknowledge notification ${built.args.notification_id}`;
  dock.record(operationKey, { summary, status: "sending", undo: false });
  dispatch(operationKey, built.args, summary);
}

/* --------------------------------------------------- the preference write */

/**
 * One save. The arguments are built from the form and from the LAST READ's
 * version; a refusal is rendered by the record layer's own reason id, and a
 * `version_conflict` re-reads before it says anything, so the sentence a person
 * reads is true about the values now on screen.
 */
async function savePreference(form) {
  const model = view.preference.state === "read" ? preferenceView(view.preference.payload) : null;
  const built = setPreferenceArgs(form, model);
  const message = $("prefMessage");
  if (!built.ok) {
    message.textContent = built.message;
    announce(built.message);
    return built;
  }
  saving = true;
  message.textContent = "";
  renderPreference();
  const summary = form.clear_quiet_hours === true
    ? "Clear quiet hours"
    : `Save notification preferences (version ${built.args.base_version})`;
  dock.record(PREFERENCE_OPERATION_KEY, { summary, status: "sending", undo: false });
  const result = await performCommand({
    operationKey: PREFERENCE_OPERATION_KEY,
    args: built.args,
    getState: () => commandState,
    setState: (next) => { commandState = next; },
    newKey: uuidv4,
    call: (request) => client.setNotificationPreference(request),
  });
  operations.set(PREFERENCE_OPERATION_KEY, { args: built.args, summary, preference: true });
  saving = false;
  let sentence = result.message || null;
  if (result.status === "refused" || result.status === "conflict") {
    // The kernel classifies `version_conflict` as a CONFLICT and every other
    // reason id as a REFUSAL, and both are settled answers that saved nothing,
    // so both are rendered by the record layer's own name for them.
    const refusal = classifyPreferenceFailure(result);
    sentence = refusal.message;
    // A conflict is not retried: the stored value moved, so the form is re-read
    // and re-rendered at the FRESH version and the person decides again.
    if (refusal.conflict) {
      dirty = false;
      await takePreference();
      // F3: the number the refusal named, SHOWN. It is preferred from the
      // refusal itself when the refusal carried it, and otherwise taken from
      // the re-read that just landed — the two are the same number, and the
      // re-read is the one the person is now looking at.
      const fresh = view.preference.state === "read" ? preferenceView(view.preference.payload) : null;
      const current = refusal.currentVersion ?? fresh?.version ?? null;
      const line = versionConflictLine(current, built.args.base_version);
      if (line) sentence = `${sentence} ${line}`;
    }
  }
  dock.record(PREFERENCE_OPERATION_KEY, {
    summary, status: result.status, reason: sentence, retry: result.retry, undo: false,
    request: result.request,
  });
  if (result.status === "ok") {
    dirty = false;
    await load();
    sentence = sentence || "Saved. This is what the record layer now holds.";
  }
  $("prefMessage").textContent = sentence || "";
  if (sentence) announce(sentence);
  renderPreference();
  return result;
}

/** What the four controls currently say, read once, at submit time. */
const formValues = () => ({
  device_opt_in: $("deviceOptIn").checked,
  quiet_hours_start: $("quietStart").value,
  quiet_hours_end: $("quietEnd").value,
  timezone: $("quietTimezone").value,
});

/**
 * The timezone suggestions, from the BROWSER's own IANA database. It is a
 * convenience and never a validator: `pg_timezone_names` is the list that
 * decides, and a name this list does not carry is still sent and still refused
 * by name.
 */
function mountTimezoneNames() {
  const list = $("timezoneNames");
  if (!list || typeof Intl.supportedValuesOf !== "function") return;
  let names = [];
  try { names = Intl.supportedValuesOf("timeZone"); } catch { return; }
  list.innerHTML = names.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
}

function mountDock() {
  const root = $("receiptDock");
  if (!root) return;
  dock = createCommandDock({
    root,
    // A refusal is settled: the kernel dropped the entry, so this starts over
    // with the same arguments and a new key, which is the only correct retry.
    onDispatch: (operationKey) => {
      const entry = operations.get(operationKey);
      if (!entry?.args) return;
      // The preference save rebuilds its arguments from the form and from the
      // version the page holds NOW, because a refused save may have been
      // refused precisely for holding a stale one.
      if (entry.preference) savePreference(formValues());
      else dispatch(operationKey, entry.args, entry.summary);
    },
    // An unknown outcome is reconciled by re-sending the SAME frozen request;
    // the kernel returns the retained one, so the same arguments are passed.
    onReconcile: (operationKey) => {
      const entry = operations.get(operationKey);
      if (!entry?.args) return;
      // An unknown outcome is reconciled with the SAME frozen request, for the
      // preference too: the kernel returns the retained one, so the retained
      // base_version and key are what go back, never a rebuilt pair.
      dispatch(operationKey, entry.args, entry.summary, entry.preference === true);
    },
    onUndo: null,
  });
  dock.mount();
}

/* ------------------------------------------------------------------------ boot */

async function boot() {
  mountPrefs();
  mountDocDock("Notifications");
  mountDock();
  $("quietHoursEffect").textContent = QUIET_HOURS_EFFECT;
  $("quietHoursScope").textContent = QUIET_HOURS_SCOPE;
  $("exposureStatement").textContent = EXPOSURE_STATEMENT;
  mountTimezoneNames();
  const footnote = $("vocabularyLine");
  if (footnote) footnote.textContent = `${footnote.textContent} ${ACKNOWLEDGE_SCOPE}`;
  const location = globalThis.location || { hostname: "", search: "" };
  const params = new URLSearchParams(location.search || "");
  view.after = params.get("after") || null;
  $("retryRead")?.addEventListener("click", () => load());
  $("prefForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    savePreference(formValues());
  });
  $("prefForm")?.addEventListener("input", () => { dirty = true; });
  $("prefClear")?.addEventListener("click", () => {
    dirty = false;
    savePreference({ clear_quiet_hours: true });
  });
  $("feedList")?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-ack]") : null;
    if (target) acknowledge(target.getAttribute("data-ack"));
  });
  const boot_ = resolveDealroomBoot(location);
  const outage = params.get("outage");
  client = boot_.mode === "live"
    ? createLiveClient()
    : await createFixtureClient({ ...boot_.options, ...(outage ? { outage } : {}) });
  mountNotificationBadge(client);
  await load();
}

boot();

export { view };
