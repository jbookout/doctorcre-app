// V5-UX-B01 — the business workspace: DOM wiring only.
//
// Two models decide everything this file paints. The canonical command-center
// payload is validated and summarised by ./workspace-command-center-model.js,
// which is reused UNCHANGED: this page is a second reader of the same read, and
// a second copy of those rules would be a second answer to the same question.
// The Home section order, the Team review arithmetic and the words for an
// unverified section live in ./business-workspace-model.js.
//
// Three rules govern the read:
//
//   1. A response only paints if no newer read has been started since it left
//      (acceptsResponse). A retry that overtakes its predecessor never lets the
//      older answer land on top of the newer one.
//   2. A failed, refused or unreadable answer drops the payload. Nothing older
//      is kept on screen as though it were current.
//   3. The clock alone can make a fresh read stale, so the freshness signature
//      is watched on a tick and the page repaints when — and only when — the
//      displayed state actually changes.
//
// Quick add is the Tasks card: the same pure plan from ./task-records-model.js,
// the same kernel, the same receipt dock. The model is imported, never copied.
//
// This week and Waiting on others each take a read of their own — `today-triage`
// and a server-filtered `loop-board` — alongside the command-centre read, each
// under its own sequence guard, so a failure in one leaves the others standing.
// Calls has no read at all: its absence is literal markup, and nothing here
// writes to it.
import { createCommandDock } from "./command-dock.js";
import { createCommandState, performCommand } from "./command-feedback.mjs";
import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { deploymentIdentity, resolveDealroomBoot } from "./boot-mode.js";
import { mountDocDock, mountNotificationBadge, mountPrefs, wireTabs } from "./shell.js";
import { mountSearch } from "./search.js";
import { mountCharts } from "./charts.js";
import { parseChartsAddress } from "./charts-model.js";
import { parseSearchAddress } from "./search-model.js";
import { formatClock, formatDueStamp, parseQuickAdd } from "./visual-system.js";
import { operationKeys, partnerName, quickAddPlan, quickAddRecords } from "./task-records-model.js";
import {
  acceptsResponse, displayedFreshness, freshnessSignature, homeReadPhase,
  safeDestination, sourceIsFresh, summarizeWorkspaceScope, validWorkspacePayload, viewerWorkspaceLabel,
} from "./workspace-command-center-model.js";
import {
  WAITING_ROW_CAP, countFrames, dueWords, needLabel, sectionPulse, sectionReadFailed, teamReviewRows, thisWeekView,
  unavailableCopy, waitingView, weekRail,
} from "./business-workspace-model.js";
import { uuidv4 } from "./uuid.js";
import { browserDraftStorage, createLocalDrafts, matchingDraftId } from "./local-drafts.mjs";

const EXPIRY_TICK_MS = 5_000;
const SIGN_IN_HREF = "/auth/login?return_to=/business";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

/** One place holds what this page believes; nothing else keeps a copy. */
const view = {
  status: "loading", payload: null, message: null, sequence: 0, freshnessKey: null,
  // The Quick add record list and its OWN sequence. The board read is a second
  // read with a second lifetime, so it gets a second guard: a late board answer
  // must not paint over a newer one, and it must never touch view.sequence.
  records: Object.freeze([]), boardSequence: 0,
  // V5-UX-B01 — the two section reads. Each keeps its own last verified answer
  // and its own sequence; `day` is the local day the sections were last drawn
  // against, so crossing midnight is noticed and both sections are read again.
  week: { status: "loading", payload: null, readAt: null }, weekSequence: 0,
  waiting: { status: "loading", payload: null, readAt: null }, waitingSequence: 0,
  day: null,
};

let client = null;
let viewer = "joe";
let localDrafts = createLocalDrafts({ storage: null, viewer: 'unverified' });
let draftViewer = null;
let restoredDraftId = null;
const draftOperations = new Map();
let commandState = createCommandState();
let dock = { record: () => {}, mount: () => {}, render: () => {} };
/** What each open operation would send again: the dock's buttons need it. */
const operations = new Map();

function announce(text) {
  const live = $("homeLive");
  if (live && live.textContent !== text) live.textContent = text;
}

function showToast(text) {
  document.querySelectorAll(".toast").forEach((node) => node.remove());
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.textContent = text;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 4100);
}

/* -------------------------------------------------------------------- painting */

function openLink(destination, label = "Open") {
  return `<a class="btn" href="${escapeHtml(safeDestination(destination))}">${escapeHtml(label)}</a>`;
}

function rowHtml({ title, meta, action = "" }) {
  return `<li class="work-item" data-priority="ordinary">
    <div><h3>${escapeHtml(title)}</h3><div class="work-meta"><span>${escapeHtml(meta)}</span></div></div>
    <div class="stack-end">${action}</div>
  </li>`;
}

/**
 * One section, painted from one decided state. `section` is the model's section
 * id, which is what supplies the sentence a section says when its own read is
 * not verified — the page never writes that sentence itself.
 */
function setSection(id, { section, rows = null, value = null, unavailable = false, emptyTitle = null }) {
  const list = $(`${id}List`);
  const valueNode = $(`${id}Value`);
  const state = $(`${id}State`);
  if (list) list.innerHTML = unavailable || !rows ? "" : rows.join("");
  if (valueNode) {
    valueNode.textContent = unavailable ? "—" : value;
    valueNode.setAttribute("data-state", unavailable ? "unavailable" : "read");
    valueNode.hidden = unavailable;
  }
  if (!state) return;
  const empty = !unavailable && Boolean(emptyTitle) && (!rows || rows.length === 0);
  state.hidden = !unavailable && !empty;
  state.setAttribute("data-state", unavailable ? "offline" : "empty");
  state.innerHTML = state.hidden ? "" : `<h3>${escapeHtml(unavailable ? unavailableCopy(section) : emptyTitle)}</h3>`;
}

function setStatus(state, label) {
  $("homeOrb")?.setAttribute("data-state", state === "healthy" ? "healthy" : state === "refreshing" ? "refreshing" : state === "urgent" ? "urgent" : "still");
  $("homeStatus")?.setAttribute("data-state", state);
  const text = $("homeStatusLabel");
  if (text) text.textContent = label;
}

/** One line, and it states the freshness against the clock now — never the stamp the read carried. */
function renderFreshness(payload) {
  const line = $("homeFreshness");
  if (!line) return;
  if (!payload) {
    line.textContent = view.status === "unauthorized" ? "No verified read · your session has ended" : "No verified read";
    line.setAttribute("data-freshness", "missing");
    return;
  }
  const freshness = displayedFreshness(payload.source);
  const clock = formatClock(payload.source.observed_at);
  line.textContent = `As of ${clock || "an unreadable time"} · ${freshness}`;
  line.setAttribute("data-freshness", freshness);
}

function renderNeedsAction(payload, verified) {
  if (!verified) return setSection("needsAction", { section: "needs_action", unavailable: true });
  const rows = payload.needs_you_now
    .filter((item) => item.count > 0)
    .map((item) => rowHtml({
      title: needLabel(item.kind),
      meta: `${item.count} ${item.count === 1 ? "record" : "records"}`,
      action: openLink(item.destination),
    }));
  setSection("needsAction", { section: "needs_action", rows, emptyTitle: "Nothing flagged" });
}

function renderPipeline(payload, verified) {
  if (!verified) return setSection("pipeline", { section: "pipeline", unavailable: true });
  const rows = ["team", "mine"].map((scope) => {
    const summary = summarizeWorkspaceScope(payload, scope);
    const label = scope === "team" ? "Team" : "Mine";
    const destination = summary.activeDestination || summary.flaggedDestination;
    return rowHtml({
      title: `${label}: ${summary.active} active, ${summary.flagged} flagged`,
      meta: scope === "team" ? "the combined Deals view" : "the deals you own",
      action: destination ? openLink(destination) : "",
    });
  });
  setSection("pipeline", { section: "pipeline", rows });
}

function renderChanges(payload, verified) {
  const item = verified ? payload.recent_activity[0] : null;
  if (!item || item.state === "unavailable" || !sourceIsFresh(item.source)) return setSection("changes", { section: "changes", unavailable: true });
  const clock = formatClock(item.observed_at);
  setSection("changes", { section: "changes", value: `${item.count} ${item.count === 1 ? "change" : "changes"} since ${clock || "an unreadable time"}` });
}

function renderDocAtWork(payload, verified) {
  const item = verified ? payload.doc_at_work[0] : null;
  if (!item || item.state === "unavailable" || !sourceIsFresh(item.source)) return setSection("docWork", { section: "doc_at_work", unavailable: true });
  setSection("docWork", { section: "doc_at_work", value: `${item.count} ${item.count === 1 ? "piece" : "pieces"} of work in progress` });
}

function renderTeamReview(payload, verified) {
  const avatar = $("viewerAvatar");
  const name = $("viewerName");
  if (avatar) { avatar.setAttribute("data-partner", viewer); avatar.textContent = partnerName(viewer).slice(0, 1); }
  if (name) name.textContent = partnerName(viewer);
  if (!verified) return setSection("teamReview", { section: "team_review", unavailable: true });
  const rows = teamReviewRows(payload.metrics).map((row) => rowHtml({
    title: `${row.label}: ${row.value}`,
    meta: row.id === "flagged" ? "flagged for attention" : "in the active Deals list",
    action: openLink(row.destination),
  }));
  setSection("teamReview", { section: "team_review", rows });
}

/* ------------------------------------------ This week and Waiting on others */

/** The reader's own calendar day. The week is theirs, not the server's. */
function localDay(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The page setting and the operating system both stop motion; either is enough. */
function motionReduced() {
  return document.documentElement.dataset.motion === "reduced"
    || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

/**
 * Paint a region only when what it shows has changed. The rows it paints carry
 * data-enter, so they animate in exactly when they are new — never on a repaint
 * that changes nothing, which would make the page twitch on every tick.
 */
const painted = new WeakMap();
function paintIfChanged(node, html) {
  if (!node || painted.get(node) === html) return false;
  painted.set(node, html);
  node.innerHTML = html;
  return true;
}

/** A state block that animates between states instead of cutting, and only on a change. */
function setOwnState(id, state, text) {
  const node = $(id);
  if (!node) return;
  const hidden = state === null;
  const key = hidden ? "" : `${state}|${text}`;
  if (node.dataset.shown === key) return;
  node.dataset.shown = key;
  node.hidden = hidden;
  if (hidden) { node.innerHTML = ""; return; }
  node.setAttribute("data-state", state);
  node.innerHTML = `<h3>${escapeHtml(text)}</h3>`;
  node.removeAttribute("data-enter");
  void node.offsetWidth;
  node.setAttribute("data-enter", "true");
}

/** A count that climbs to the value it read, or lands on it at once when motion is reduced. */
const counting = new WeakMap();
function countTo(node, to, format) {
  if (!node) return;
  const previous = Number.parseInt(node.dataset.count ?? "", 10);
  const start = Number.isInteger(previous) ? previous : 0;
  node.dataset.count = String(to);
  const frames = countFrames(start, to, { reduced: motionReduced() });
  cancelAnimationFrame(counting.get(node));
  let index = 0;
  const step = () => {
    node.textContent = format(frames[index]);
    index += 1;
    if (index < frames.length) counting.set(node, requestAnimationFrame(step));
  };
  step();
}

function setValue(id, value, format) {
  const node = $(id);
  if (!node) return;
  node.hidden = value === null;
  node.setAttribute("data-state", value === null ? "unavailable" : "read");
  if (value === null) { node.textContent = "—"; delete node.dataset.count; return; }
  countTo(node, value, format);
}

function readCaption(read, detail) {
  const clock = formatClock(read.readAt);
  return `Read at ${clock || "an unreadable time"} · ${detail}`;
}

function railHtml(rail) {
  const dots = (count) => "<i></i>".repeat(Math.min(count, 4));
  const cells = rail.days.map((day) => `<li class="week-day" data-today="${day.today}" data-count="${day.count}"><span>${escapeHtml(day.label)}</span><span class="week-day-dots">${dots(day.count)}</span></li>`);
  if (rail.overdue) cells.unshift(`<li class="week-day" data-overdue="true" data-count="${rail.overdue}"><span>Late</span><span class="week-day-dots">${dots(rail.overdue)}</span></li>`);
  return cells.join("");
}

function weekRowHtml(row) {
  const priority = row.overdue ? "overdue" : row.offset <= 1 ? "deadline" : "ordinary";
  const subject = row.subject ? `${row.subject}${row.ref ? ` · ${row.ref}` : ""}` : row.ref || "";
  return `<li class="work-item home-row" data-priority="${priority}" data-enter="true">
    <div><h3>${escapeHtml(row.what)}</h3><div class="work-meta"><span>${escapeHtml(row.kindLabel)}</span>${subject ? `<span>${escapeHtml(subject)}</span>` : ""}<span>${escapeHtml(row.owner ? partnerName(row.owner) : "Team")}</span></div></div>
    <div class="stack-end"><span class="due-chip" data-overdue="${row.overdue}">${escapeHtml(dueWords(row.offset))}</span></div>
  </li>`;
}

function waitingRowHtml(row) {
  const followUp = row.offset === null ? "" : row.offset < 0 ? `Follow-up ${dueWords(row.offset)}` : `Follow-up ${dueWords(row.offset).toLowerCase()}`;
  return `<li class="work-item home-row" data-priority="${row.overdue ? "overdue" : "blocked"}" data-enter="true">
    <div><h3>${escapeHtml(row.title)}</h3><div class="work-meta"><span>Waiting on: ${escapeHtml(row.waitingOn || "a named counterparty")}</span><span>#${escapeHtml(row.number)} · ${escapeHtml(partnerName(row.owner))}</span>${row.since ? `<span>${escapeHtml(row.since)}</span>` : ""}</div>
      <svg class="waiting-flow" viewBox="0 0 120 8" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path class="flow-path" d="M2 4 H118"></path></svg></div>
    <div class="stack-end">${followUp ? `<span class="due-chip" data-overdue="${row.overdue}">${escapeHtml(followUp)}</span>` : ""}</div>
  </li>`;
}

/** What a section with no answer in hand shows: still reading, or unverified. */
function pendingView(read) {
  return { state: read.status === "loading" ? "loading" : "unavailable", rows: [], overdue: 0, held: 0, capped: false };
}

function renderThisWeek() {
  const read = view.week;
  const week = read.payload ? thisWeekView(view.week.payload, { today: localDay() }) : pendingView(read);
  $("thisWeekPulse")?.setAttribute("data-state", read.status === "refreshing" ? "refreshing" : sectionPulse(week));
  if (week.state !== "read") {
    paintIfChanged($("thisWeekList"), "");
    paintIfChanged($("thisWeekRail"), "");
    setValue("thisWeekValue", null);
    setOwnState("thisWeekState", week.state === "loading" ? "loading" : "offline", week.state === "loading" ? "Reading this week…" : unavailableCopy("this_week"));
    const caption = $("thisWeekCaption");
    if (caption) caption.textContent = "";
    return;
  }
  paintIfChanged($("thisWeekRail"), railHtml(weekRail(week.rows, localDay())));
  paintIfChanged($("thisWeekList"), week.rows.map(weekRowHtml).join(""));
  setValue("thisWeekValue", week.rows.length, (count) => `${count} due${week.overdue ? ` · ${week.overdue} overdue` : ""}`);
  setOwnState("thisWeekState", week.rows.length ? null : "empty", "Nothing due this week");
  const caption = $("thisWeekCaption");
  if (caption) {
    caption.textContent = readCaption(read, "critical dates for the next seven days, and follow-ups due today or overdue")
      + (week.capped ? " · the read stopped at its row limit, so later dates may be missing" : "");
  }
}

function renderWaiting() {
  const read = view.waiting;
  const waiting = read.payload ? waitingView(read.payload, { today: localDay() }) : pendingView(read);
  $("waitingPulse")?.setAttribute("data-state", read.status === "refreshing" ? "refreshing" : sectionPulse(waiting));
  if (waiting.state !== "read") {
    paintIfChanged($("waitingList"), "");
    setValue("waitingValue", null);
    setOwnState("waitingState", waiting.state === "loading" ? "loading" : "offline", waiting.state === "loading" ? "Reading waiting work…" : unavailableCopy("waiting_on_others"));
    const caption = $("waitingCaption");
    if (caption) caption.textContent = "";
    return;
  }
  paintIfChanged($("waitingList"), waiting.rows.map(waitingRowHtml).join(""));
  setValue("waitingValue", waiting.rows.length, (count) => `${count} waiting`);
  setOwnState("waitingState", waiting.rows.length ? null : "empty", "Nothing waiting on a counterparty");
  const caption = $("waitingCaption");
  if (caption) {
    caption.textContent = readCaption(read, "open work whose blocker is a named counterparty")
      + (waiting.held ? ` · ${waiting.held} more ${waiting.held === 1 ? "is" : "are"} held jointly or by the system, on Tasks` : "")
      + (waiting.capped ? " · the read stopped at its row limit, so some may be missing" : "");
  }
}

/**
 * Retry is offered while any read on Home is unverified, and it re-reads all of
 * them. A section counts as unverified from what its answer projects to, not
 * from the transport alone: an RPC that succeeded with an unreadable answer
 * paints "could not be verified", and must offer the way out too.
 */
function renderRetry() {
  const retry = $("retryRead");
  if (!retry) return;
  const phase = homeReadPhase({ status: view.status, payload: view.payload });
  const countsVerified = Boolean(view.payload) && validWorkspacePayload(view.payload) && sourceIsFresh(view.payload.source);
  const today = localDay();
  const sectionFailed = sectionReadFailed(view.week, (payload) => thisWeekView(payload, { today }))
    || sectionReadFailed(view.waiting, (payload) => waitingView(payload, { today }));
  retry.hidden = phase === "unauthorized" || phase === "loading" || (countsVerified && !sectionFailed);
}

function renderSections() {
  view.day = localDay();
  renderThisWeek();
  renderWaiting();
  renderRetry();
}

function render() {
  const payload = view.payload;
  view.freshnessKey = payload ? freshnessSignature(payload) : null;
  const phase = homeReadPhase({ status: view.status, payload });
  const unauthorized = phase === "unauthorized";
  const verified = Boolean(payload) && validWorkspacePayload(payload) && sourceIsFresh(payload.source);

  const signIn = $("signInAgain");
  if (signIn) { signIn.hidden = !unauthorized; signIn.href = SIGN_IN_HREF; }
  renderRetry();

  const label = $("viewerLabel");
  if (label) label.textContent = payload ? viewerWorkspaceLabel(payload.viewer) : "Partner workspace";

  if (phase === "loading") setStatus("refreshing", "Reading the command centre…");
  else if (unauthorized) setStatus("unknown", "Session ended");
  else if (!verified) setStatus("urgent", "Command centre read unavailable");
  else setStatus("healthy", `Read from the command centre · ${deploymentIdentity(client?.mode).detail}`);

  renderFreshness(payload);
  renderNeedsAction(payload, verified);
  renderPipeline(payload, verified);
  renderChanges(payload, verified);
  renderDocAtWork(payload, verified);
  renderTeamReview(payload, verified);

  if (unauthorized) announce("Sign in again to read the command centre. Nothing is shown from a session that has ended.");
  else if (phase === "loading") announce("Reading the command centre…");
  else if (!verified) announce(view.message || unavailableCopy("needs_action"));
  else announce(`${payload.needs_you_now.filter((item) => item.count > 0).length} flagged group(s) shown.`);
}

/* --------------------------------------------------------------------- reading */

async function load() {
  const sequence = ++view.sequence;
  view.status = view.payload ? "refreshing" : "loading";
  render();
  try {
    const payload = await client.commandCenter();
    if (!acceptsResponse(view.sequence, sequence)) return;
    if (!validWorkspacePayload(payload)) {
      return settle({ status: "error", message: "The canonical read returned an unexpected shape, so no count is shown as current." }, sequence);
    }
    settle({ status: "ready", payload }, sequence);
  } catch (error) {
    if (!acceptsResponse(view.sequence, sequence)) return;
    const status = Number(error?.status || 0);
    if (status === 401 || status === 403) return settle({ status: "unauthorized" }, sequence);
    settle({ status: "error", message: "The workspace could not reach the canonical read. Nothing here has been inferred." }, sequence);
  }
}

/**
 * The Quick add record list, read from the Deal Room board.
 *
 * The command-centre read is an aggregate of counts and destinations and names
 * no deal, so the names Quick add matches against come from their own read of
 * `deal-room-board` — already in the pinned interface, so no contract moves.
 * It runs ALONGSIDE the command-centre read, never chained to it: the counts
 * paint whether or not the board answers. A failed or unanswered board read
 * leaves Quick add with an empty list — no guessed names, and no record-layer
 * error text on a page whose own read succeeded.
 *
 * V5-UX-B06 — the read is now passed IN rather than taken here, because the
 * Charts tab needs the same answer and the page promises one board read at one
 * as-of. Two consumers of one promise is one call; two calls would be two
 * snapshots of the same board taken milliseconds apart.
 */
async function loadBoardRecords(boardRead) {
  const sequence = ++view.boardSequence;
  let records = [];
  let actor = null;
  try {
    const board = await boardRead;
    records = quickAddRecords(board?.deals);
    actor = board?.actor || null;
  } catch {
    records = Object.freeze([]);
  }
  if (!acceptsResponse(view.boardSequence, sequence)) return;
  if (actor && actor !== draftViewer) {
      const saved = createLocalDrafts({ storage: browserDraftStorage(), viewer: actor });
      if (!draftViewer) for (const draft of localDrafts.list()) saved.save(draft.sentence, draft.dueDate);
      localDrafts = saved;
      draftViewer = actor;
      restoredDraftId = null;
      viewer = actor;
      renderDrafts();
  }
  view.records = records;
  renderQuickAdd();
}

function readBoard() {
  return client.getBoard({ workspace: 'all' });
}

/**
 * V5-UX-B01 — This week, read from `today-triage`. A refused or failed answer
 * drops the payload, exactly as the command-centre read does: an older week is
 * never left on screen as though it were current. A newer read in flight keeps
 * the last verified answer visible and says it is refreshing.
 */
async function loadThisWeek() {
  const sequence = ++view.weekSequence;
  view.week = { ...view.week, status: view.week.payload ? "refreshing" : "loading" };
  renderSections();
  let next;
  try {
    const payload = await client.todayTriage();
    next = { status: "ready", payload, readAt: new Date().toISOString() };
  } catch {
    next = { status: "error", payload: null, readAt: null };
  }
  if (!acceptsResponse(view.weekSequence, sequence)) return;
  view.week = next;
  renderSections();
}

/**
 * V5-UX-B01 — Waiting on others, read from `loop-board` with the counterparty
 * filter applied by the record layer, so the page receives only the rows it
 * shows. Only `open_loop` is read: a `team_loop` refuses a blocker, so it can
 * never be waiting on anyone.
 */
async function loadWaiting() {
  const sequence = ++view.waitingSequence;
  view.waiting = { ...view.waiting, status: view.waiting.payload ? "refreshing" : "loading" };
  renderSections();
  let next;
  try {
    const payload = await client.loopBoard({ kind: "open_loop", status: "open", blocker: "counterparty", limit: WAITING_ROW_CAP });
    next = { status: "ready", payload, readAt: new Date().toISOString() };
  } catch {
    next = { status: "error", payload: null, readAt: null };
  }
  if (!acceptsResponse(view.waitingSequence, sequence)) return;
  view.waiting = next;
  renderSections();
}

/** Both section reads, started together and never chained to the command centre. */
function readSections() {
  loadThisWeek();
  loadWaiting();
}

function settle({ status, payload = null, message = null }, sequence) {
  if (!acceptsResponse(view.sequence, sequence)) return;
  view.status = status;
  view.message = message;
  // A failed or refused read never keeps an older payload alive as if current.
  view.payload = status === "ready" ? payload : null;
  render();
  renderDrafts();
}

/**
 * A local clock that has passed valid_until must stop presenting the counts as
 * current. The signature covers the read and each work card, so a card that
 * expires on its own deadline repaints while the overall read is still inside
 * its window.
 */
function watchExpiry() {
  setInterval(() => {
    // Crossing midnight moves "today", and work that became due overnight is
    // not in the old answer at all, so both sections are READ again. The old
    // answer stays up, re-derived against the new day and marked refreshing,
    // until the new one lands; readSections records the day at once, so the
    // next tick does not read again. An unchanged day repaints nothing.
    if (view.day !== localDay()) readSections();
    if (!view.payload || view.status === "loading") return;
    const signature = freshnessSignature(view.payload);
    if (signature === view.freshnessKey) return;
    view.freshnessKey = signature;
    render();
  }, EXPIRY_TICK_MS);
}

/* ---------------------------------------------------------------- Quick add */

/**
 * The Related row. One match names the record; more than one names none of
 * them and asks, in the row itself, which one the sentence meant.
 */
function relatedCell(parsed) {
  if (parsed.related) return escapeHtml(parsed.related);
  const candidates = parsed.relatedCandidates || [];
  if (candidates.length > 1) {
    return `Two records match, say which: ${candidates.map((name) => escapeHtml(name)).join(", ")}`;
  }
  return "<i>none</i>";
}

function renderQuickAdd() {
  const input = $("quickAddInput");
  if (!input) return null;
  const sentence = input.value;
  // Quick add matches against the records this page's own board read carries.
  const parsed = parseQuickAdd(sentence, { now: Date.now(), viewer, records: view.records });
  const picked = $("quickAddDate")?.value || null;
  const effective = picked ? { ...parsed, due: picked, dueLabel: formatDueStamp(picked, parsed.dueTime) } : parsed;
  const preview = $("quickAddParsed");
  if (preview) {
    preview.innerHTML = [
      `<div><span>Action</span>${effective.action ? escapeHtml(effective.action) : "<i>unknown</i>"}</div>`,
      `<div><span>Owner</span>${escapeHtml(partnerName(effective.owner))}${effective.ownerDefaulted ? " <i>(you, by default)</i>" : ""}</div>`,
      `<div><span>Due</span>${effective.due ? escapeHtml(formatDueStamp(effective.due, effective.dueTime)) : "<i>none</i>"}</div>`,
      `<div><span>Related</span>${relatedCell(effective)}</div>`,
    ].join("");
  }
  const plan = quickAddPlan(effective, { viewer, sentence });
  const question = $("quickAddQuestion");
  if (question) {
    question.textContent = plan.args
      ? `${plan.summary} · files as ${plan.kind === "team_loop" ? "a team record" : "a personal record"}`
      : `Keep it as a draft, or answer: ${plan.questions.join(" ")}`;
  }
  return { plan, sentence, parsed: effective };
}

function renderDrafts() {
  const bar = $("draftBar");
  const list = $("draftList");
  if (!bar || !list) return;
  const drafts = localDrafts?.list() || [];
  bar.hidden = drafts.length === 0 || view.status === 'unauthorized';
  bar.querySelector('.chip-label').textContent = draftViewer && localDrafts.isPersisted()
    ? 'Drafts on this device · select to review' : 'Drafts kept on this page only · select to review';
  if (view.status === 'unauthorized') { list.innerHTML = ''; return; }
  list.innerHTML = drafts.map((draft) =>
    `<button class="chip" type="button" data-restore-draft="${escapeHtml(draft.id)}">${escapeHtml(draft.sentence)}${draft.dueDate ? ` · ${escapeHtml(draft.dueDate)}` : ""}</button>`
  ).join("");
}

async function dispatch(operationKey, args, send, summary) {
  const result = await performCommand({
    operationKey,
    args,
    getState: () => commandState,
    setState: (next) => { commandState = next; },
    newKey: uuidv4,
    call: (request) => send(request),
  });
  operations.set(operationKey, { ...(operations.get(operationKey) || {}), args, send, summary });
  dock.record(operationKey, {
    summary, status: result.status, reason: result.message || null,
    retry: result.retry, undo: false, request: result.request,
  });
  if (result.message) announce(result.message);
  if (result.status === "ok") {
    const draftId = draftOperations.get(operationKey);
    if (draftId) {
      localDrafts.remove(draftId);
      draftOperations.delete(operationKey);
      if (restoredDraftId === draftId) restoredDraftId = null;
      renderDrafts();
    }
    showToast(`${summary} — confirmed`);
    // The capture changed the record layer, so the aggregate read is taken again
    // rather than patched here from what this page believes it just did.
    await load();
  } else if (result.status === 'refused' || result.status === 'conflict') {
    draftOperations.delete(operationKey);
  }
  return result;
}

function mountDock() {
  const root = $("receiptDock");
  if (!root) return;
  dock = createCommandDock({
    root,
    // A refusal is settled: the kernel dropped the entry, so a retry is a new key.
    onDispatch: (operationKey) => {
      const entry = operations.get(operationKey);
      if (entry?.args) dispatch(operationKey, entry.args, entry.send, entry.summary);
    },
    // An unknown outcome is reconciled by re-sending the SAME frozen request.
    onReconcile: (operationKey) => {
      const entry = operations.get(operationKey);
      if (entry?.args) dispatch(operationKey, entry.args, entry.send, entry.summary);
    },
    onUndo: null,
  });
  dock.mount();
}

/* ---------------------------------------------------------------------- wiring */

function wire() {
  $("retryRead")?.addEventListener("click", () => { load(); readSections(); });

  for (const id of ["quickAddInput", "quickAddDate"]) $(id)?.addEventListener("input", renderQuickAdd);
  $("quickAddDate")?.addEventListener("change", renderQuickAdd);

  $("quickAddForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (globalThis.navigator?.onLine === false) {
      announce("Offline. Keep this as a draft on this device; reconnect and review it before saving.");
      return;
    }
    if (!draftViewer) {
      announce("Confirming your account. Keep this as a draft until it is ready.");
      return;
    }
    const current = renderQuickAdd();
    if (!current) return;
    if (!current.plan.args) {
      announce(`Nothing was filed. ${current.plan.questions.join(" ")}`);
      return;
    }
    const operationKey = operationKeys.quickAdd(current.sentence, viewer);
    const matchedId = matchingDraftId(localDrafts.list(), restoredDraftId, current.sentence, $("quickAddDate")?.value || "");
    if (matchedId) draftOperations.set(operationKey, matchedId);
    operations.set(operationKey, { summary: current.plan.summary, send: (request) => client.addLoop(request) });
    const result = await dispatch(operationKey, current.plan.args, (request) => client.addLoop(request), current.plan.summary);
    // A refusal keeps the person's sentence exactly where it is; only an
    // accepted capture clears the input.
    if (result.status === "ok") {
      const input = $("quickAddInput");
      const date = $("quickAddDate");
      if (input) input.value = "";
      if (date) date.value = "";
      renderQuickAdd();
      renderDrafts();
    }
  });

  $("quickAddDraft")?.addEventListener("click", () => {
    const sentence = $("quickAddInput")?.value || "";
    const dueDate = $("quickAddDate")?.value || "";
    const draft = localDrafts?.save(sentence, dueDate);
    if (!draft) { announce("There is nothing to keep as a draft yet."); return; }
    renderDrafts();
    announce(localDrafts.isPersisted()
      ? "Draft saved on this device only. Reconnect and review it before filing."
      : "Draft kept on this page only; this browser could not save it for a reload.");
  });

  $("draftList")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-restore-draft]");
    const draft = localDrafts?.list().find((item) => item.id === button?.dataset.restoreDraft);
    if (!draft) return;
    restoredDraftId = draft.id;
    $("quickAddInput").value = draft.sentence;
    $("quickAddDate").value = draft.dueDate;
    renderQuickAdd();
    $("quickAddInput").focus();
    announce("Draft restored for review. Nothing was sent.");
  });
}

/* ------------------------------------------------------------------------ boot */

async function boot() {
  mountPrefs();
  const doc = mountDocDock("Business home");
  const tabs = wireTabs("businessTabs");
  // Doc history is Doc's own history view. Doc owns that surface, so the tab
  // asks Doc for it and never renders a second copy of it here.
  const openDocHistory = (event) => {
    event?.preventDefault?.();
    if (typeof doc?.openHistory === "function") doc.openHistory();
    else doc?.open?.("Doc history");
  };
  $("tabDocHistory")?.addEventListener("click", openDocHistory);
  $("mobileDocHistory")?.addEventListener("click", openDocHistory);
  mountDock();
  wire();
  window.addEventListener('online', () => {
    if (!client) return;
    load();
    readSections();
    loadBoardRecords(readBoard());
  });
  renderQuickAdd();
  renderDrafts();
  watchExpiry();
  const resolved = resolveDealroomBoot(globalThis.location || { hostname: "", search: "" });
  client = resolved.mode === "live" ? createLiveClient() : await createFixtureClient(resolved.options);
  mountNotificationBadge(client);
  // V5-UX-B05 — the Search tab. It is a tab on an already-admitted path, so no
  // route moves and no sign-in gate entry is needed: its address is a query
  // (?q= and ?kinds=) on /business, which the gate does not inspect. The tab is
  // selected when an address carries ?q=, so a saved view or a Back both land
  // on the surface they name.
  mountSearch({ client });
  if (parseSearchAddress(globalThis.location?.search || "").present) tabs?.select("tabSearch");
  viewer = client.selfActor || "joe";
  if (client.selfActor) {
    localDrafts = createLocalDrafts({ storage: browserDraftStorage(), viewer });
    draftViewer = viewer;
  }
  renderDrafts();
  // V5-UX-B06 — ONE board read for the whole page, taken here and shared. Quick
  // add's record list and every chart on the Charts tab are derived from this
  // single answer, so /business issues exactly one `deal-room-board` call per
  // load and the tab's totals are the same as-of as the page's own.
  const boardRead = readBoard();
  // V5-UX-B06 — the Charts tab. Same admitted path, same reasoning: its address
  // is a query (?charts=1&group=&pick=) on /business, which the gate does not
  // inspect, so no route moves and no gate entry is needed. It reads nothing of
  // its own: it is handed the page's board, so there is exactly one phase
  // vocabulary and exactly one as-of.
  mountCharts({ client, board: boardRead, onRestore: () => tabs?.select("tabCharts") });
  if (parseChartsAddress(globalThis.location?.search || "").present) tabs?.select("tabCharts");
  const quickAddRead = loadBoardRecords(boardRead);
  // V5-UX-B01 — This week and Waiting on others read alongside the counts.
  readSections();
  await load();
  await quickAddRead;
}

boot();

export { view };
