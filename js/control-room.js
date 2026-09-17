// V5-UX-C01 — the Control Room: DOM wiring only.
//
// Every decision about a payload lives in ./control-room-model.js, and the
// census keeps the models it already has (stageDenominator, renderCount). This
// file reads, paints, and does nothing else. It writes nothing: there is no
// write verb on this surface.
//
// Four reads are taken INDEPENDENTLY and settled independently, which is the
// whole point of the slice: one collector failing makes its own areas unknown
// and leaves every other area exactly as verified as it was. The freshness of
// each read is the clock at the moment its answer landed, stated per section,
// and an answer that arrives after a newer read has started is dropped rather
// than painted over the newer one.
import {
  canonicalHref, coverageLine, dashboardTiles, groupedIncidents, incidentFilters, notInReleaseBlocks,
  readPhase, sinceChangeLabel, stallCandidates, validCurrentWorkItemPayload, validCurrentWorkRequestsPayload,
  validIncidentBoardPayload, workInProgressLine, NO_CANONICAL_PAGE,
} from "./control-room-model.js";
import { renderCount, stageDenominator } from "./delivery-evidence-model.js";
import { validWorkInventoryPayload, WORK_INVENTORY_ENDPOINT } from "./work-inventory-model.js";
import { acceptsResponse } from "./workspace-command-center-model.js";
import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { deploymentIdentity, resolveDealroomBoot } from "./boot-mode.js";
import { mountDocDock, mountPrefs, wireTabs } from "./shell.js";
import { formatClock } from "./visual-system.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

/** One place holds what this page believes; nothing else keeps a copy. */
const view = {
  status: "loading",
  sequence: 0,
  severity: "all",
  outage: null,
  reads: {
    incidents: { state: "pending" },
    work: { state: "pending" },
    needs_joe: { state: "pending" },
    census: { state: "pending" },
  },
};

let client = null;
let tabs = null;

function announce(text) {
  const live = $("roomLive");
  if (live && live.textContent !== text) live.textContent = text;
}

const asOf = (read) => (read?.state === "read" && formatClock(read.observed_at)
  ? `As of ${formatClock(read.observed_at)}`
  : `unknown${read?.reason ? ` · ${read.reason}` : ""}`);

const payloadOf = (id) => (view.reads[id]?.state === "read" ? view.reads[id].payload : null);

/** What a tile or a section is handed: an answer, or the reason there is none. */
function readFor(id) {
  const read = view.reads[id] || {};
  if (read.state === "read") return { state: "read", payload: read.payload };
  return { state: "unknown", reason: read.reason || "this read has not answered yet" };
}

/* -------------------------------------------------------------------- painting */

function renderCoverage() {
  const strip = $("coverageChips");
  if (!strip) return;
  const attempted = Object.fromEntries(Object.entries(view.reads).filter(([, read]) => read.state !== "pending"));
  const chips = coverageLine(attempted);
  strip.innerHTML = `<span class="chip-label">Each read states its own clock</span>${chips
    .map((chip) => `<span class="chip" data-state="${escapeHtml(chip.state)}">${escapeHtml(chip.text)}</span>`)
    .join("")}`;
}

function renderTiles() {
  const grid = $("questionTiles");
  if (!grid) return;
  const tiles = dashboardTiles({
    incidents: readFor("incidents"), work: readFor("work"),
    needsJoe: readFor("needs_joe"), census: readFor("census"),
  });
  grid.innerHTML = tiles.map((tile) => `<section class="card glass" data-tile="${escapeHtml(tile.id)}" data-state="${escapeHtml(tile.state)}">
    <p class="eyebrow">Question</p>
    <h2>${escapeHtml(tile.title)}</h2>
    <p class="tile-value" data-state="${escapeHtml(tile.state)}">${escapeHtml(tile.word)}</p>
    <p class="tile-sentence">${escapeHtml(tile.sentence)}</p>
    ${tile.open ? `<div class="row-wrap"><button class="btn" type="button" data-open="${escapeHtml(tile.id)}">${escapeHtml(tile.open.label)}</button></div>` : ""}
  </section>`).join("");
  for (const button of grid.querySelectorAll("button[data-open]")) {
    const tile = tiles.find((candidate) => candidate.id === button.dataset.open);
    button.addEventListener("click", () => openTile(tile));
  }
}

/** A tile's Open switches tabs or moves to the section that lists the rows. */
function openTile(tile) {
  if (!tile?.open) return;
  if (tile.open.tab === "attention") {
    tabs?.select("tabAttention");
    announce("The incident queue is open.");
    return;
  }
  tabs?.select("tabDashboard");
  const section = $(tile.open.section);
  if (section) {
    section.setAttribute("tabindex", "-1");
    section.focus();
  }
  announce(`${tile.title}: the rows behind it are open.`);
}

function rowHtml({ title, meta, end = "" }) {
  return `<li class="work-item" data-priority="ordinary">
    <div><h3>${escapeHtml(title)}</h3><div class="work-meta"><span>${escapeHtml(meta)}</span></div></div>
    <div class="stack-end">${end}</div>
  </li>`;
}

function renderActiveWork() {
  const read = view.reads.work;
  const list = $("activeWorkList");
  const state = $("activeWorkState");
  const wip = $("wipLine");
  $("activeWorkAsOf").textContent = asOf(read);
  $("longestAsOf").textContent = asOf(read);
  const payload = payloadOf("work");
  const verified = Boolean(payload) && validCurrentWorkItemPayload(payload);
  const longestList = $("longestList");
  const longestState = $("longestState");

  if (!verified) {
    list.innerHTML = "";
    longestList.innerHTML = "";
    state.hidden = false;
    longestState.hidden = false;
    wip.textContent = "unknown";
    wip.setAttribute("data-state", "unavailable");
    return;
  }
  state.hidden = true;
  longestState.hidden = true;
  const line = workInProgressLine(payload.wip);
  wip.textContent = line.text;
  wip.setAttribute("data-state", line.known ? "read" : "unavailable");

  list.innerHTML = payload.current.map((item) => rowHtml({
    title: item.title,
    meta: [
      `${item.human_ref} · ${item.state}`,
      `run by ${item.executor || item.owner || "nobody named"}`,
      sinceChangeLabel(item.hours_since_last_change),
      item.blocker ? `blocked: ${item.blocker.code}${item.blocker.detail ? ` — ${item.blocker.detail}` : ""}` : "no blocker recorded",
    ].join(" · "),
    end: canonicalHref(item) ? `<a class="btn" href="${escapeHtml(canonicalHref(item))}">Open</a>` : "",
  })).join("") || rowHtml({ title: "Nothing is held right now", meta: "the queue may still hold ready work, which this read deliberately does not show" });

  const stalls = stallCandidates(payload.current, { cadence: null });
  longestList.innerHTML = stalls.items.map((item) => rowHtml({
    title: item.title,
    meta: `${item.human_ref} · ${sinceChangeLabel(item.hours_since_last_change)} · ${stalls.reason}`,
  })).join("") || rowHtml({ title: "No held work to order", meta: stalls.reason });
}

function renderNeedsJoe() {
  const read = view.reads.needs_joe;
  $("needsJoeAsOf").textContent = asOf(read);
  const list = $("needsJoeList");
  const state = $("needsJoeState");
  const payload = payloadOf("needs_joe");
  if (!payload || !validCurrentWorkRequestsPayload(payload)) {
    list.innerHTML = "";
    state.hidden = false;
    return;
  }
  state.hidden = true;
  list.innerHTML = payload.items.map((item) => rowHtml({
    title: item.title,
    meta: [
      `${item.human_ref} · ${item.state}`,
      `source ${item.source.label || "unknown"} (${item.source.freshness || "unknown"})`,
      item.next_human_action || "no next action recorded",
    ].join(" · "),
    end: canonicalHref(item) ? `<a class="btn" href="${escapeHtml(canonicalHref(item))}">Open</a>` : "",
  })).join("") || rowHtml({ title: "No shared request carries a bounded next action", meta: "read from the shared queue" });
}

function renderDelivery() {
  const read = view.reads.census;
  $("deliveryAsOf").textContent = asOf(read);
  const payload = payloadOf("census");
  const value = $("deliveryValue");
  const reason = $("deliveryReason");
  const state = $("deliveryState");
  if (!payload || !validWorkInventoryPayload(payload)) {
    value.textContent = "unknown";
    value.setAttribute("data-state", "unavailable");
    reason.textContent = view.reads.census?.reason || "the census did not answer.";
    state.hidden = false;
    return;
  }
  state.hidden = true;
  const denominator = stageDenominator(payload.coverage);
  const returned = payload.items.filter((item) => item.kind === "work_request").length;
  value.textContent = renderCount(returned, denominator);
  value.setAttribute("data-state", denominator.known ? "read" : "unavailable");
  reason.textContent = denominator.known
    ? "Work requests read on this page, against the census's own total."
    : `No denominator: ${denominator.reason}.`;
}

function renderScopeBlocks() {
  const root = $("dashboardScopeBlocks");
  if (!root) return;
  const dashboardBlocks = new Set(["changed", "accomplishments", "detected_and_repaired", "resources"]);
  root.innerHTML = notInReleaseBlocks().filter((block) => dashboardBlocks.has(block.id)).map((block) => `
    <div class="state-block" data-state="not_in_release" data-block="${escapeHtml(block.id)}">
      <h3>${escapeHtml(block.title)}</h3><p>${escapeHtml(block.reason)} · ${escapeHtml(block.slice)}</p>
    </div>`).join("");
}

function renderIncidents() {
  const read = view.reads.incidents;
  $("attentionAsOf").textContent = asOf(read);
  const chips = $("severityChips");
  const groups = $("incidentGroups");
  const state = $("attentionState");
  const payload = payloadOf("incidents");
  if (!payload || !validIncidentBoardPayload(payload)) {
    chips.innerHTML = `<span class="chip-label">Severity</span>`;
    groups.innerHTML = "";
    state.hidden = false;
    return;
  }
  state.hidden = true;
  chips.innerHTML = `<span class="chip-label">Severity</span>${incidentFilters(payload.incidents)
    .map((filter) => `<button class="chip" type="button" data-severity="${escapeHtml(filter.id)}" aria-pressed="${filter.id === view.severity}">${escapeHtml(filter.label)} · ${filter.count}</button>`)
    .join("")}`;
  for (const chip of chips.querySelectorAll("button[data-severity]")) {
    chip.addEventListener("click", () => { view.severity = chip.dataset.severity; renderIncidents(); });
  }

  const grouped = groupedIncidents(payload.incidents, { severity: view.severity });
  groups.innerHTML = grouped.map((group) => `
    <section class="card" data-group="${escapeHtml(group.severity)}" aria-label="${escapeHtml(group.severity)}">
      <div class="card-heading"><div><p class="eyebrow">${escapeHtml(group.severity)}</p><h3>${group.count} ${group.count === 1 ? "incident" : "incidents"}</h3></div></div>
      <ul class="work-list">
        ${group.incidents.map((card) => `<li class="work-item" data-incident="${escapeHtml(card.ref)}" data-priority="ordinary">
          <div>
            <h3>${escapeHtml(card.title)}</h3>
            <div class="work-meta"><span>${escapeHtml(`${card.ref} · ${card.severity} · ${card.state} · ${card.age} · ${card.owner} · seen ${card.occurrences === null ? "unknown" : card.occurrences} times`)}</span></div>
            <div class="work-meta"><span>${escapeHtml(card.recommendedNext ? `Recommended next: ${card.recommendedNext}` : "Recommended next: the ledger recorded none")}</span></div>
            ${card.readyToClose ? `<div class="work-meta"><span>Ready to close, by this read</span></div>` : ""}
          </div>
          <div class="stack-end"><button class="btn" type="button" data-incident-open="${escapeHtml(card.ref)}">Open the card</button></div>
        </li>`).join("")}
      </ul>
    </section>`).join("") || `<div class="state-block" data-state="empty"><h3>No incident matches this severity</h3></div>`;

  for (const button of groups.querySelectorAll("button[data-incident-open]")) {
    button.addEventListener("click", () => openIncident(button.dataset.incidentOpen));
  }
}

function openIncident(ref) {
  const payload = payloadOf("incidents");
  const row = payload?.incidents?.find((candidate) => candidate.ref === ref);
  const dialog = $("incidentDialog");
  if (!row || !dialog) return;
  $("incidentDialogTitle").textContent = row.title;
  $("incidentRows").innerHTML = Object.entries(row)
    .filter(([, value]) => value !== null && value !== undefined && typeof value !== "object")
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd>`)
    .join("");
  const href = canonicalHref(row);
  $("incidentRecordLine").innerHTML = href
    ? `<a class="btn" href="${escapeHtml(href)}">Open the record</a>`
    : escapeHtml(NO_CANONICAL_PAGE);
  dialog.showModal();
  announce(`${row.ref} is open.`);
}

function renderStatus() {
  const attempted = Object.fromEntries(Object.entries(view.reads).filter(([, read]) => read.state !== "pending"));
  const phase = readPhase({ status: view.status, reads: attempted });
  const words = {
    loading: "Taking the reads…",
    no_access: "Session ended",
    offline: "No read answered",
    partial: "Some reads did not answer",
    ready: "Every read answered",
  };
  $("roomStatus")?.setAttribute("data-state", phase === "ready" ? "healthy" : phase === "loading" ? "refreshing" : phase === "partial" ? "attention" : "urgent");
  $("roomOrb")?.setAttribute("data-state", phase === "ready" ? "healthy" : phase === "loading" ? "refreshing" : "urgent");
  $("roomStatusLabel").textContent = words[phase];
  const freshness = $("roomFreshness");
  freshness.setAttribute("data-freshness", phase);
  freshness.textContent = phase === "loading"
    ? "Taking the reads…"
    : `${words[phase]} · ${deploymentIdentity(client?.mode).detail}`;
  const retry = $("retryRead");
  if (retry) retry.hidden = phase === "loading";
  announce(words[phase]);
  return phase;
}

function render() {
  renderStatus();
  renderCoverage();
  renderTiles();
  renderActiveWork();
  renderNeedsJoe();
  renderDelivery();
  renderIncidents();
  renderScopeBlocks();
}

/* --------------------------------------------------------------------- reading */

/** One read, settled on its own. A failure names its area and nothing else. */
async function take(id, run, refusal) {
  const sequence = view.sequence;
  try {
    const payload = await run();
    if (!acceptsResponse(view.sequence, sequence)) return;
    view.reads[id] = { state: "read", payload, observed_at: new Date().toISOString() };
  } catch (error) {
    if (!acceptsResponse(view.sequence, sequence)) return;
    const status = Number(error?.status || 0);
    if (status === 401 || status === 403) view.status = "unauthorized";
    view.reads[id] = { state: "unknown", reason: status === 401 || status === 403 ? "the session has ended" : refusal };
  }
  render();
}

async function census() {
  // The fixture's outage switch covers the census too, because CR-AC-02 has to
  // be demonstrable for EVERY leg and this one is a plain HTTP read rather than
  // a client method the fixture could refuse for us.
  if (view.outage === "census") throw new Error("census outage requested by the fixture switch");
  const response = await fetch(`${WORK_INVENTORY_ENDPOINT}?kinds=work_request`, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!response.ok) {
    const error = new Error(`census -> ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function load() {
  view.sequence += 1;
  view.status = "loading";
  for (const id of Object.keys(view.reads)) view.reads[id] = { state: "pending" };
  render();
  view.status = "ready";
  await Promise.all([
    take("incidents", () => client.incidentBoard({ state: "open" }), "the incident ledger refused or could not be reached"),
    take("work", () => client.currentWorkItem(), "the held-work read refused or could not be reached"),
    take("needs_joe", () => client.currentWorkRequests(), "the shared request read refused or could not be reached"),
    take("census", () => census(), "the census refused or could not be reached"),
  ]);
  render();
}

/* ------------------------------------------------------------------------ boot */

async function boot() {
  mountPrefs();
  mountDocDock("Control Room");
  tabs = wireTabs("controlRoomTabs");
  $("incidentClose")?.addEventListener("click", () => $("incidentDialog")?.close());
  $("retryRead")?.addEventListener("click", () => load());
  renderScopeBlocks();
  const location = globalThis.location || { hostname: "", search: "" };
  const resolved = resolveDealroomBoot(location);
  const outage = new URLSearchParams(location.search || "").get("outage");
  view.outage = resolved.mode === "live" ? null : outage;
  client = resolved.mode === "live"
    ? createLiveClient()
    : await createFixtureClient({ ...resolved.options, ...(outage ? { outage } : {}) });
  const label = $("viewerLabel");
  if (label) label.textContent = client.selfActor === "dell" ? "Dell's workspace" : "Joe's workspace";
  await load();
}

boot();

export { view };
