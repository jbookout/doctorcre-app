// V5-UX-C14 — the incident page: DOM wiring only.
//
// Every decision about a payload, a reference or a sentence lives in
// ./incidents-model.js, and every decision about what a command DID lives in
// the shared kernel (./command-feedback.mjs) and its dock. This file reads,
// paints, and sends exactly one write.
//
// Three shapes govern the file:
//
//   1. The reference comes from the query string and from nowhere else. No
//      reference, or one that is not the ledger's shape, is a refusal card plus
//      the open list — a bare page that is useful rather than empty.
//   2. Each read stamps its OWN clock at the moment its answer landed, and a
//      read that did not answer is unknown in the app's words. The server's
//      text never reaches the page.
//   3. The one write goes through performCommand with one operation key and
//      one idempotency key, and its receipt is the shared dock's. An unknown
//      outcome keeps its entry so the dock's "Check outcome" re-sends the SAME
//      frozen request; that reconcile is the kernel's and nothing is added to
//      it here.
import { createCommandDock } from "./command-dock.js";
import { createCommandState, performCommand } from "./command-feedback.mjs";
import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountDocDock, mountNotificationBadge, mountPrefs } from "./shell.js";
import { formatClock } from "./visual-system.js";
import { groupedIncidents, validIncidentBoardPayload } from "./control-room-model.js";
import {
  HYPOTHESIS_EYEBROW, REFUSAL_SENTENCE, REF_REFUSAL, factRows, hypothesisRows, incidentHeader,
  linkArgs, linkOperationKey, linkRows, occurrenceRows, refFromSearch, validIncidentDetailPayload,
  whoCanClearLine,
} from "./incidents-model.js";
import { uuidv4 } from "./uuid.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

/** One place holds what this page believes; nothing else keeps a copy. */
const view = {
  ref: null,
  refState: "missing",
  sequence: 0,
  detail: { state: "pending" },
  list: { state: "pending" },
};

let client = null;
let commandState = createCommandState();
let dock = { record: () => {}, mount: () => {}, render: () => {} };
/** What each open operation would send again: the dock's buttons need it. */
const operations = new Map();

function announce(text) {
  const live = $("incidentLive");
  if (live && live.textContent !== text) live.textContent = text;
}

const asOf = (read) => (read?.state === "read" && formatClock(read.observed_at)
  ? `As of ${formatClock(read.observed_at)}`
  : `unknown${read?.state === "unknown" ? ` · ${read.reason}` : ""}`);

const show = (id, visible) => { const node = $(id); if (node) node.hidden = !visible; };

/* -------------------------------------------------------------------- painting */

function rowHtml({ title, meta, end = "" }) {
  return `<li class="work-item" data-priority="ordinary">
    <div><h3>${escapeHtml(title)}</h3><div class="work-meta"><span>${escapeHtml(meta)}</span></div></div>
    <div class="stack-end">${end}</div>
  </li>`;
}

/** The refusal card and the open list behind it. */
function renderList() {
  const read = view.list;
  $("refusalSentence").textContent = REF_REFUSAL;
  $("listAsOf").textContent = asOf(read);
  const root = $("incidentList");
  const payload = read.state === "read" ? read.payload : null;
  if (!payload || !validIncidentBoardPayload(payload)) {
    root.innerHTML = "";
    show("listState", true);
    return;
  }
  show("listState", false);
  root.innerHTML = groupedIncidents(payload.incidents).map((group) => `
    <section class="card" data-group="${escapeHtml(group.severity)}" aria-label="${escapeHtml(group.severity)}">
      <div class="card-heading"><div><p class="eyebrow">${escapeHtml(group.severity)}</p><h3>${group.count} ${group.count === 1 ? "incident" : "incidents"}</h3></div></div>
      <ul class="work-list">
        ${group.incidents.map((card) => rowHtml({
          title: card.title,
          meta: `${card.ref} · ${card.severity} · ${card.state} · ${card.age} · ${card.owner}`,
          end: card.href ? `<a class="btn" href="${escapeHtml(card.href)}">Open</a>` : "",
        })).join("")}
      </ul>
    </section>`).join("") || `<div class="state-block" data-state="empty"><h3>No open incident is on the ledger</h3></div>`;
}

function renderDetail() {
  const read = view.detail;
  $("incidentAsOf").textContent = asOf(read);
  const payload = read.state === "read" ? read.payload : null;
  const verified = Boolean(payload) && validIncidentDetailPayload(payload);
  for (const id of ["detailBlock", "factsBlock", "hypothesesBlock", "occurrencesBlock", "linksBlock"]) show(id, verified);
  show("unknownBlock", read.state === "unknown");
  if (read.state === "unknown") {
    $("unknownSentence").textContent = `This incident is unknown: ${read.reason}.`;
    $("incidentOrb").setAttribute("data-state", "urgent");
  }
  if (!verified) {
    $("incidentChips").innerHTML = "";
    return;
  }
  $("incidentOrb").setAttribute("data-state", "healthy");
  const row = payload.incident;
  const header = incidentHeader(row);
  $("pageTitle").textContent = header.title;
  $("detailTitle").textContent = header.title;
  $("incidentRef").textContent = header.ref;
  $("incidentChips").innerHTML = [
    ["Severity", header.severity], ["State", header.state], ["Environment", header.environment],
    ["Owner", header.owner], ["Age", header.age], ["Recurrence", header.occurrences],
  ].map(([label, value]) => `<span class="chip" data-chip="${escapeHtml(label.toLowerCase())}">${escapeHtml(`${label}: ${value}`)}</span>`).join("");
  $("whoCanClear").textContent = whoCanClearLine(row);
  $("hypothesesEyebrow").textContent = HYPOTHESIS_EYEBROW;

  $("factList").innerHTML = factRows(payload.facts).map((fact) => rowHtml({
    title: fact.statement, meta: `source ${fact.source} · recorded at ${fact.clock}`,
  })).join("") || rowHtml({ title: "No fact is recorded on this incident yet", meta: "read from the operational ledger" });

  $("hypothesisList").innerHTML = hypothesisRows(payload.hypotheses).map((row_) => rowHtml({
    title: row_.statement, meta: `${row_.status} · recorded at ${row_.clock}`,
  })).join("") || rowHtml({ title: "No hypothesis is recorded on this incident yet", meta: "read from the operational ledger" });

  $("occurrenceList").innerHTML = occurrenceRows(payload.occurrences).map((row_) => rowHtml({
    title: row_.note, meta: `seen at ${row_.clock}`,
  })).join("") || rowHtml({ title: "No further occurrence is recorded", meta: "read from the operational ledger" });

  $("linkList").innerHTML = linkRows(payload.links).map((link) => rowHtml({
    title: link.label, meta: `${link.ref} · ${link.kind}`,
    end: link.href ? `<a class="btn" href="${escapeHtml(link.href)}">Open</a>` : "",
  })).join("") || rowHtml({ title: "Nothing is linked to this incident yet", meta: "read from the operational ledger" });
}

function render() {
  const detail = view.refState === "ok";
  show("refusalBlock", !detail);
  if (detail) renderDetail(); else renderList();
}

/* --------------------------------------------------------------------- reading */

/** One read, settled on its own. The server's words never survive this guard. */
async function take(slot, run) {
  const sequence = view.sequence;
  try {
    const payload = await run();
    if (view.sequence !== sequence) return;
    view[slot] = { state: "read", payload, observed_at: new Date().toISOString() };
  } catch {
    if (view.sequence !== sequence) return;
    view[slot] = { state: "unknown", reason: REFUSAL_SENTENCE };
  }
  render();
}

async function load() {
  view.sequence += 1;
  if (view.refState === "ok") {
    view.detail = { state: "pending" };
    render();
    await take("detail", () => client.getIncident({ ref: view.ref, fact_limit: 50 }));
    announce(view.detail.state === "read" ? `${view.ref} is open.` : `${view.ref} could not be read.`);
    return;
  }
  view.list = { state: "pending" };
  render();
  await take("list", () => client.incidentBoard({ state: "open" }));
  announce(REF_REFUSAL);
}

/* --------------------------------------------------------------------- writing */

async function dispatch(operationKey, args, summary) {
  const result = await performCommand({
    operationKey,
    args,
    getState: () => commandState,
    setState: (next) => { commandState = next; },
    newKey: uuidv4,
    call: (request) => client.linkIncidentWorkRequest(request),
  });
  operations.set(operationKey, { args, summary });
  dock.record(operationKey, {
    summary, status: result.status, reason: result.message || null,
    retry: result.retry, undo: false, request: result.request,
  });
  if (result.message) announce(result.message);
  // Only the record layer knows what the incident now holds, so a settled
  // write re-reads it rather than appending the row this page hoped for.
  if (result.status === "ok") await load();
  return result;
}

function linkWorkRequest(raw) {
  const built = linkArgs(view.ref, raw);
  if (!built.ok) {
    announce(built.message);
    const hint = $("linkHint");
    if (hint) hint.textContent = built.message;
    return;
  }
  $("linkHint").textContent = "A work request looks like WR-000123.";
  const operationKey = linkOperationKey(view.ref, built.workRequest);
  const summary = `Link ${built.workRequest} to ${view.ref}`;
  dock.record(operationKey, { summary, status: "sending", undo: false });
  dispatch(operationKey, built.args, summary);
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
      if (entry?.args) dispatch(operationKey, entry.args, entry.summary);
    },
    // An unknown outcome is reconciled by re-sending the SAME frozen request;
    // the kernel returns the retained one, so the same arguments are passed.
    onReconcile: (operationKey) => {
      const entry = operations.get(operationKey);
      if (entry?.args) dispatch(operationKey, entry.args, entry.summary);
    },
    onUndo: null,
  });
  dock.mount();
}

/* ------------------------------------------------------------------------ boot */

async function boot() {
  mountPrefs();
  mountDocDock("Incident");
  mountDock();
  const location = globalThis.location || { hostname: "", search: "" };
  const resolved = refFromSearch(location.search || "");
  view.refState = resolved.state;
  view.ref = resolved.ref;
  if (resolved.state === "ok") $("incidentRef").textContent = resolved.ref;
  $("retryRead")?.addEventListener("click", () => load());
  $("linkForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    linkWorkRequest($("linkInput")?.value || "");
  });
  const boot_ = resolveDealroomBoot(location);
  const outage = new URLSearchParams(location.search || "").get("outage");
  client = boot_.mode === "live"
    ? createLiveClient()
    : await createFixtureClient({ ...boot_.options, ...(outage ? { outage } : {}) });
  mountNotificationBadge(client);
  await load();
}

boot();

export { view };
