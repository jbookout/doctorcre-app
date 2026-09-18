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
import { createCommandDock } from "./command-dock.js";
import { createCommandState, performCommand } from "./command-feedback.mjs";
import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { deploymentIdentity, resolveDealroomBoot } from "./boot-mode.js";
import { mountDocDock, mountPrefs, wireTabs } from "./shell.js";
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
import { needLabel, teamReviewRows, unavailableCopy } from "./business-workspace-model.js";
import { uuidv4 } from "./uuid.js";

const EXPIRY_TICK_MS = 5_000;
const SIGN_IN_HREF = "/auth/login?return_to=/business";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

/** One place holds what this page believes; nothing else keeps a copy. */
const view = {
  status: "loading", payload: null, message: null, sequence: 0, freshnessKey: null, drafts: [],
  // The Quick add record list and its OWN sequence. The board read is a second
  // read with a second lifetime, so it gets a second guard: a late board answer
  // must not paint over a newer one, and it must never touch view.sequence.
  records: Object.freeze([]), boardSequence: 0,
};

let client = null;
let viewer = "joe";
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

function render() {
  const payload = view.payload;
  view.freshnessKey = payload ? freshnessSignature(payload) : null;
  const phase = homeReadPhase({ status: view.status, payload });
  const unauthorized = phase === "unauthorized";
  const verified = Boolean(payload) && validWorkspacePayload(payload) && sourceIsFresh(payload.source);

  const signIn = $("signInAgain");
  if (signIn) { signIn.hidden = !unauthorized; signIn.href = SIGN_IN_HREF; }
  const retry = $("retryRead");
  if (retry) retry.hidden = unauthorized || phase === "loading" || verified;

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
 */
async function loadBoardRecords() {
  const sequence = ++view.boardSequence;
  let records = [];
  try {
    const board = await client.getBoard();
    records = quickAddRecords(board?.deals);
  } catch {
    records = Object.freeze([]);
  }
  if (!acceptsResponse(view.boardSequence, sequence)) return;
  view.records = records;
  renderQuickAdd();
}

function settle({ status, payload = null, message = null }, sequence) {
  if (!acceptsResponse(view.sequence, sequence)) return;
  view.status = status;
  view.message = message;
  // A failed or refused read never keeps an older payload alive as if current.
  view.payload = status === "ready" ? payload : null;
  render();
}

/**
 * A local clock that has passed valid_until must stop presenting the counts as
 * current. The signature covers the read and each work card, so a card that
 * expires on its own deadline repaints while the overall read is still inside
 * its window.
 */
function watchExpiry() {
  setInterval(() => {
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
  bar.hidden = view.drafts.length === 0;
  list.innerHTML = view.drafts.map((text) => `<span class="chip">${escapeHtml(text)}</span>`).join("");
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
    showToast(`${summary} — confirmed`);
    // The capture changed the record layer, so the aggregate read is taken again
    // rather than patched here from what this page believes it just did.
    await load();
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
  $("retryRead")?.addEventListener("click", () => load());

  for (const id of ["quickAddInput", "quickAddDate"]) $(id)?.addEventListener("input", renderQuickAdd);
  $("quickAddDate")?.addEventListener("change", renderQuickAdd);

  $("quickAddForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const current = renderQuickAdd();
    if (!current) return;
    if (!current.plan.args) {
      announce(`Nothing was filed. ${current.plan.questions.join(" ")}`);
      return;
    }
    const operationKey = operationKeys.quickAdd(current.sentence, viewer);
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
    }
  });

  $("quickAddDraft")?.addEventListener("click", () => {
    const current = renderQuickAdd();
    const text = current?.parsed?.action || current?.sentence?.trim();
    if (!text) { announce("There is nothing to keep as a draft yet."); return; }
    view.drafts = [...view.drafts, text];
    renderDrafts();
    announce(`Draft kept on this page: ${text}. Nothing was written to the record.`);
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
  renderQuickAdd();
  renderDrafts();
  watchExpiry();
  const resolved = resolveDealroomBoot(globalThis.location || { hostname: "", search: "" });
  client = resolved.mode === "live" ? createLiveClient() : await createFixtureClient(resolved.options);
  // V5-UX-B05 — the Search tab. It is a tab on an already-admitted path, so no
  // route moves and no sign-in gate entry is needed: its address is a query
  // (?q= and ?kinds=) on /business, which the gate does not inspect. The tab is
  // selected when an address carries ?q=, so a saved view or a Back both land
  // on the surface they name.
  mountSearch({ client });
  if (parseSearchAddress(globalThis.location?.search || "").present) tabs?.select("tabSearch");
  // V5-UX-B06 — the Charts tab. Same admitted path, same reasoning: its address
  // is a query (?charts=1&group=&pick=) on /business, which the gate does not
  // inspect, so no route moves and no gate entry is needed. It reads the board
  // through the same adapter the workspace already uses, so there is exactly
  // one phase vocabulary and exactly one as-of.
  mountCharts({ client });
  if (parseChartsAddress(globalThis.location?.search || "").present) tabs?.select("tabCharts");
  viewer = client.selfActor || "joe";
  const boardRead = loadBoardRecords();
  await load();
  await boardRead;
}

boot();

export { view };
