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
  needsJoeAdvisoryLabel, operationsBlocks, readPhase, sinceChangeLabel, stallCandidates, validCurrentWorkItemPayload, validCurrentWorkRequestsPayload,
  validIncidentBoardPayload, workInProgressLine, NO_CANONICAL_PAGE, STUCK_SILENCE_HOURS,
} from "./control-room-model.js";
// V5-UX-C13a: the enriched "Waiting for Joe" detail extends the row above
// rather than replacing it, and reuses the same pure card projection the
// Model Room tab's work-item history uses — one shape, read once each place.
import { needsJoeCardFields, refuseWorkRequestCard, workRequestCardRequest } from "./model-room-model.js";
import { snapshotFromReads, writeSnapshot } from "./status-model.js";
import { renderCount, stageDenominator } from "./delivery-evidence-model.js";
import { validWorkInventoryPayload, WORK_INVENTORY_ENDPOINT } from "./work-inventory-model.js";
import { acceptsResponse } from "./workspace-command-center-model.js";
import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { deploymentIdentity, resolveDealroomBoot } from "./boot-mode.js";
import { mountAtlas } from "./atlas.js";
import { mountSessions } from "./sessions.js";
import { mountModelRoom } from "./model-room.js";
import { mountDocDock, mountNotificationBadge, mountPrefs, wireTabs } from "./shell.js";
import { formatClock } from "./visual-system.js";

const $ = (id) => document.getElementById(id);
export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
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
  // V5-UX-C13a: the "Waiting for Joe" detail is fetched ONLY when a row's own
  // button is pressed — never for every row on dashboard load, which would
  // turn one lazy read into N eager ones and blur this page's time-to-glance.
  needsJoeDetail: { humanRef: null, state: "idle", payload: null, refusal: null },
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
    cadence: STUCK_SILENCE_HOURS,
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

  const stalls = stallCandidates(payload.current, { cadence: STUCK_SILENCE_HOURS });
  longestList.innerHTML = stalls.items.map((item) => rowHtml({
    title: item.title,
    meta: `${item.human_ref} · ${sinceChangeLabel(item.hours_since_last_change)}`,
  })).join("") || rowHtml({ title: "No held work to order", meta: `nothing has been held without a change for ${STUCK_SILENCE_HOURS} hours or more` });
}

function needsJoeDetailFieldsHtml(fields) {
  if (!fields.available) return `<p class="small">The detail could not be read: ${escapeHtml(fields.reason)}.</p>`;
  const row = (label, field) => `<dt>${escapeHtml(label)}</dt><dd>${
    field.present ? escapeHtml(field.value) : `not provided by the server${field.reason ? ` (${escapeHtml(field.reason)})` : ""}`
  }</dd>`;
  const evidenceRow = fields.evidence.present
    ? `<dt>evidence links</dt><dd>${
      fields.evidence.items.length
        ? fields.evidence.items.map((entry) => escapeHtml(typeof entry === "string" ? entry : JSON.stringify(entry))).join("; ")
        : escapeHtml(fields.evidence.emptyText)
    }</dd>`
    : `<dt>evidence links</dt><dd>not provided by the server (${escapeHtml(fields.evidence.reason)})</dd>`;
  return `<dl class="detail-rows">
    <dt>original request</dt><dd>${fields.originalRequest.present ? escapeHtml(fields.originalRequest.value) : `not provided by the server (${escapeHtml(fields.originalRequest.reason)})`}</dd>
    ${row("recommended answer", fields.recommendedAnswer)}
    ${row("business impact", fields.businessImpact)}
    ${evidenceRow}
  </dl>
  ${fields.originalRequest.present ? `<p class="caption">${escapeHtml(fields.originalRequest.label)}</p>` : ""}`;
}

function renderNeedsJoeDetail() {
  const panel = $("needsJoeDetail");
  const title = $("needsJoeDetailTitle");
  const asOfLine = $("needsJoeDetailAsOf");
  const rows = $("needsJoeDetailRows");
  if (!panel || !title || !rows) return;
  const detail = view.needsJoeDetail;
  if (!detail.humanRef) { panel.hidden = true; return; }
  panel.hidden = false;
  title.textContent = `${detail.humanRef}, in full`;
  if (detail.state === "loading") {
    asOfLine.textContent = "Taking the work-request-card read…";
    rows.innerHTML = "";
    return;
  }
  if (detail.refusal) {
    asOfLine.textContent = `The detail could not be read: ${detail.refusal}.`;
    rows.innerHTML = "";
    return;
  }
  asOfLine.textContent = "As of this read";
  rows.innerHTML = needsJoeDetailFieldsHtml(needsJoeCardFields(detail.payload));
}

async function openNeedsJoeDetail(humanRef) {
  if (view.needsJoeDetail.humanRef === humanRef) {
    // A second press of the same row's button closes it, rather than
    // re-reading a card that already answered.
    view.needsJoeDetail = { humanRef: null, state: "idle", payload: null, refusal: null };
    renderNeedsJoeDetail();
    return;
  }
  view.needsJoeDetail = { humanRef, state: "loading", payload: null, refusal: null };
  renderNeedsJoeDetail();
  const args = workRequestCardRequest(humanRef);
  if (!args) {
    view.needsJoeDetail = { humanRef, state: "ready", payload: null, refusal: "work_request_ref_invalid" };
    renderNeedsJoeDetail();
    return;
  }
  try {
    const payload = await client.workRequestCard(args);
    if (view.needsJoeDetail.humanRef !== humanRef) return;
    const refusal = refuseWorkRequestCard(payload);
    view.needsJoeDetail = { humanRef, state: "ready", payload: refusal ? null : payload, refusal };
  } catch (error) {
    if (view.needsJoeDetail.humanRef !== humanRef) return;
    view.needsJoeDetail = {
      humanRef, state: "ready", payload: null,
      refusal: String(error?.payload?.error || error?.message || "the read did not answer"),
    };
  }
  renderNeedsJoeDetail();
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
    renderNeedsJoeDetail();
    return;
  }
  state.hidden = true;
  list.innerHTML = payload.items.map((item, index) => rowHtml({
    title: item.title,
    meta: [
      `${item.human_ref} · ${item.state}`,
      `source ${item.source.label || "unknown"} (${item.source.freshness || "unknown"})`,
      item.next_human_action || "no next action recorded",
      needsJoeAdvisoryLabel(payload, index),
    ].join(" · "),
    // V5-UX-C13a: extends this row with the original request, the recommended
    // answer, the business impact and evidence links — each shown only where
    // work-request-card actually carries it. The existing Open link, when the
    // item has a canonical page, is untouched.
    end: `${canonicalHref(item) ? `<a class="btn" href="${escapeHtml(canonicalHref(item))}">Open</a>` : ""}<button class="btn" type="button" data-needs-joe-detail="${escapeHtml(item.human_ref)}" aria-expanded="${view.needsJoeDetail.humanRef === item.human_ref}">${view.needsJoeDetail.humanRef === item.human_ref ? "Hide detail" : "Show more detail"}</button>`,
  })).join("") || rowHtml({ title: "No shared request carries a bounded next action", meta: "read from the shared queue" });
  for (const button of list.querySelectorAll("button[data-needs-joe-detail]")) {
    button.addEventListener("click", () => openNeedsJoeDetail(button.dataset.needsJoeDetail));
  }
  renderNeedsJoeDetail();
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

/** V5-UX-C14: the two Operations cards, in the house not-in-release style. */
function renderOperations() {
  const root = $("operationsBlocks");
  if (!root) return;
  root.innerHTML = operationsBlocks().map((block) => `
    <div class="state-block" data-state="not_in_release" data-operations="${escapeHtml(block.id)}">
      <h3>${escapeHtml(block.title)}</h3>
      <p>${escapeHtml(block.body)}</p>
      ${block.rule ? `<p class="operations-rule">${escapeHtml(block.rule)}</p>` : ""}
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
  renderOperations();
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
  // V5-UX-C15 (C21): leave a timestamped last-known picture on THIS device so
  // /status can show it when this page is unreachable. It records which reads
  // answered and when — never a row, a title or a count.
  storeSnapshot();
}

/** Never blocks a read and never throws: a device that refuses storage is fine. */
function storeSnapshot() {
  let storage = null;
  try {
    storage = globalThis.localStorage || null;
  } catch {
    return;
  }
  writeSnapshot(storage, snapshotFromReads(view.reads, Date.now()));
}

/* ------------------------------------------------------------------------ boot */

/**
 * Mounted once, on demand. mountAtlas itself refuses a second mount.
 *
 * V5-UX-C09: hands atlas.js the SAME incident-board read this dashboard
 * already takes (a getter, since that read settles asynchronously and can
 * still be pending the first time a reader opens this tab) and the same
 * record-layer client, so an incident marked on the atlas resolves to the
 * exact incident this dashboard shows — never a second incident-board read.
 */
function openAtlas(node = null) {
  mountAtlas({ outage: view.outage, node, getIncidentsRead: () => view.reads.incidents, client });
}

/**
 * V5-UX-S02: the session-identity read is LAZY for the same reason the atlas
 * read is. It fires on the first selection of the Sessions tab, never on page
 * boot, and mountSessions itself refuses a second mount.
 */
function openSessions() {
  mountSessions({ outage: view.outage });
}

/**
 * V5-UX-C12: the Model Room's three reads are LAZY for the same reason. They
 * fire on the first selection of the tab, never on page boot, and
 * mountModelRoom itself refuses a second mount. Nothing here polls.
 */
function openModelRoom() {
  mountModelRoom({ outage: view.outage });
}


async function boot() {
  mountPrefs();
  mountDocDock("Control Room");
  tabs = wireTabs("controlRoomTabs");
  // V5-UX-C07: the atlas read is LAZY. It fires on the first selection of the
  // Atlas tab, never on page boot, so the four dashboard reads above keep the
  // Control Room's time-to-glance. A  deep link selects the tab,
  // which is what mounts it.
  document.getElementById("controlRoomTabs")?.addEventListener("click", (event) => {
    if (event.target.closest("#tabAtlas")) openAtlas();
    if (event.target.closest("#tabSessions")) openSessions();
    if (event.target.closest("#tabModelRoom")) openModelRoom();
  }, true);
  $("incidentClose")?.addEventListener("click", () => $("incidentDialog")?.close());
  $("retryRead")?.addEventListener("click", () => load());
  renderOperations();
  renderScopeBlocks();
  const location = globalThis.location || { hostname: "", search: "" };
  const resolved = resolveDealroomBoot(location);
  const outage = new URLSearchParams(location.search || "").get("outage");
  view.outage = resolved.mode === "live" ? null : outage;
  client = resolved.mode === "live"
    ? createLiveClient()
    : await createFixtureClient({ ...resolved.options, ...(outage ? { outage } : {}) });
  mountNotificationBadge(client);
  // ?tab=atlas&node=<id> is a query on an already admitted path, so it needs no
  // new route and no gate change. Back restores the previous selection.
  const parameters = new URLSearchParams(location.search || "");
  if (parameters.get("tab") === "atlas") {
    tabs?.select("tabAtlas");
    openAtlas(parameters.get("node"));
  }
  if (parameters.get("tab") === "sessions") {
    tabs?.select("tabSessions");
    openSessions();
  }
  if (parameters.get("tab") === "model-room") {
    tabs?.select("tabModelRoom");
    openModelRoom();
  }
  const label = $("viewerLabel");
  if (label) label.textContent = client.selfActor === "dell" ? "Dell's workspace" : "Joe's workspace";
  await load();
}

boot();

export { view };
