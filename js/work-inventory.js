import { createPageBudget } from './read-budget.mjs';
import { pageDocContext, publishDocRead, setDocFilters } from './doc-context.js';
import { fetchRead, mountAutoRefresh, readWithDeadline, updatedLabel } from "./auto-refresh.mjs";
// V5-UX-C10 — Complete Work Inventory, DOM wiring.
//
// Every decision about the payload lives in ./work-inventory-model.js. This file
// only reads the canonical endpoint and paints, the same seam the Command Center
// uses: one same-origin fetch to /api/v1/..., no client-side authority, and a
// refused or failed read never keeps an older page alive as if it were current.
//
// Accessibility is load-bearing here, not decoration: one aria-live status line
// carries every state change, every control is a real button or input reachable
// by keyboard, targets clear 44px through the shared .btn/.field rules, and
// nothing is drag-only or hover-only.

import {
  COVERAGE_COPY, KIND_LABEL, WORK_INVENTORY_ENDPOINT, WORK_INVENTORY_KINDS, WORK_INVENTORY_LIMIT_DEFAULT,
  coverageOrbState, coverageSummary, dispositionState, filterItemsByStatusText, groupItemsByKind,
  inventoryRequestPath, listPhase, mergeInventoryPages, validWorkInventoryPayload,
} from "./work-inventory-model.js";
import {
  NO_PASSPORT_REASON, STAGE_LABEL, availableActions, deliveryStages, dispositionArgs,
  dispositionEffect, dispositionOptions, operationKeys, refusalMessage, renderCount, stageDenominator,
  validPassportPayload, validWorkRequestCard,
} from "./delivery-evidence-model.js";
import { createCommandDock } from "./command-dock.js";
import { performCommand } from "./command-feedback.mjs";
import { createLiveClient } from "./live-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountNotificationBadge, mountPrefs } from "./shell.js";
import { uuidv4 } from "./uuid.js";

const censusOrb = document.querySelector("#censusOrb");
const censusStatus = document.querySelector("#censusStatus");
const censusStatusLabel = document.querySelector("#censusStatusLabel");
const censusAsOf = document.querySelector("#censusAsOf");
const viewerLabel = document.querySelector("#viewerLabel");
const live = document.querySelector("#inventoryLive");
const kindChipBar = document.querySelector("#kindChips");
const kindChips = kindChipBar ? [...kindChipBar.querySelectorAll("button[data-kind]")] : [];
const kindReset = document.querySelector("#kindReset");
const statusFilter = document.querySelector("#statusFilter");
const requestPath = document.querySelector("#requestPath");
const coverageStrip = document.querySelector("#coverageStrip");
const coverageSummaryLine = document.querySelector("#coverageSummary");
const kindGroups = document.querySelector("#kindGroups");
const inventoryState = document.querySelector("#inventoryState");
const itemsCount = document.querySelector("#itemsCount");
const loadMore = document.querySelector("#loadMore");
const retryRead = document.querySelector("#retryRead");
const sourceLine = document.querySelector("#sourceLine");

/**
 * One place holds what this page believes. `kinds` starts as all six and
 * `statusText` starts empty, because showing every status is the DEFAULT and the
 * only thing this surface promises.
 */
const view = {
  kinds: [...WORK_INVENTORY_KINDS],
  statusText: "",
  status: "loading",
  payload: null,
  items: [],
  loadedPages: 1,
  message: null,
  sequence: 0,
};

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

function announce(text) {
  if (live && live.textContent !== text) live.textContent = text;
}

// Wire values belong in Details. Unrecognized values never become broker copy.
const STATUS_LABEL = {
  captured: "Captured", triaged: "Triaged", ready: "Ready", declined: "Declined",
  superseded: "Superseded", queued: "Queued", dormant: "Dormant", active: "Active",
  open: "Open", closed: "Closed", done: "Done", dropped: "Dropped", proposed: "Proposed",
  approved: "Approved", accepted: "Accepted", retired: "Retired", blocked: "Blocked",
  pending: "Pending", required: "Required", not_required: "Not required", needs_joe: "Needs Joe",
  needs_dell: "Needs Dell", eligible: "Eligible", claimed: "Claimed", reopened: "Reopened",
  verified_complete: "Verified", in_progress: "In progress", complete: "Complete",
};
const statusLabel = value => STATUS_LABEL[String(value ?? "").toLowerCase()] || "Status unavailable";
const recordTitle = item => item?.title || "Untitled record";
const stageLabel = state => ({ complete: "Verified", "not reached": "Not reached", unknown: "Not checked" }[state] || "Unavailable");

function formatUpdated(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "updated time unavailable";
  return date.toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}

function setCensusStatus(state, label) {
  if (censusOrb) censusOrb.setAttribute("data-state", state);
  if (censusStatus) censusStatus.setAttribute("data-state", state);
  if (censusStatusLabel) censusStatusLabel.textContent = label;
}

/* ---------------------------------------------------------------- preferences */
// Theme, density and motion are one icon button each, and js/shell.js owns all
// three for every surface. This page kept its own copy until B01; three copies
// of one rule is three places for it to drift.
/* -------------------------------------------------------------------- painting */

function renderFilters() {
  kindChips.forEach((chip) => chip.setAttribute("aria-pressed", view.kinds.includes(chip.dataset.kind) ? "true" : "false"));
  if (kindReset) kindReset.disabled = view.kinds.length === WORK_INVENTORY_KINDS.length;
  if (requestPath) requestPath.textContent = `Request: ${inventoryRequestPath({ kinds: view.kinds, limit: WORK_INVENTORY_LIMIT_DEFAULT })}${view.message ? ` · ${view.message}` : ""}`;
}

function coverageRow(entry) {
  const orb = coverageOrbState(entry.state);
  const total = Number.isInteger(entry.count_total) ? `${entry.count_total} items` : "total not claimed";
  const capped = entry.page_capped === true ? " · more rows remain behind the page limit" : "";
  const excluded = Number.isInteger(entry.excluded_other_tenant) && entry.excluded_other_tenant > 0
    ? ` · ${entry.excluded_other_tenant} row(s) outside this tenant were dropped` : "";
  return `<li class="work-item" data-kind="${escapeHtml(entry.kind)}" data-coverage="${escapeHtml(entry.state)}">
    <div><h3>${escapeHtml(KIND_LABEL[entry.kind] || entry.kind)}</h3>
      <div class="work-meta"><span><b>${escapeHtml(entry.count_returned)}</b> shown</span><span>${escapeHtml(total)}</span></div>
      <div class="work-meta">${escapeHtml(capped + excluded)}</div>
    </div>
    <span class="status" data-state="${escapeHtml(orb)}"><span class="orb" data-state="${escapeHtml(orb)}" aria-hidden="true"></span> ${escapeHtml(entry.state === "complete" ? "Available" : COVERAGE_COPY[entry.state] || "Unavailable")}</span>
  </li>`;
}

function renderCoverage(payload) {
  if (!coverageStrip) return;
  coverageStrip.innerHTML = payload.coverage.map(coverageRow).join("");
  const summary = coverageSummary(payload.coverage);
  if (!coverageSummaryLine) return;
  const total = summary.total === null ? "no census-wide total is claimed" : `${summary.total} records counted across all areas`;
  coverageSummaryLine.textContent = `${summary.complete.length} of ${summary.sources} areas available · ${summary.partial.length} partial · ${summary.unavailable.length} unavailable · ${total}`;
  coverageSummaryLine.setAttribute("data-stale", payload.census_complete ? "false" : "true");
}

function relatedHtml(item) {
  if (item.unlinked) return '<span class="chip">No related record</span>';
  return item.related.map((link) => {
    const related = view.items.find(entry => entry.kind === link.kind && entry.id === link.id);
    return `<span class="chip">${escapeHtml(related?.title || KIND_LABEL[link.kind] || "Related record")}</span>`;
  }).join("");
}

function itemRow(item) {
  const open = item.open
    ? `<a class="btn" href="${escapeHtml(item.open)}" target="_blank" rel="noopener">Open</a>`
    : '<span class="small">No surface owns this record yet</span>';
  return `<li class="work-item" data-kind="${escapeHtml(item.kind)}">
    <div>
      <h3>${escapeHtml(recordTitle(item))}</h3>
      <div class="work-meta">
        <span>${escapeHtml(KIND_LABEL[item.kind] || item.kind)}</span>
        <span><b>${escapeHtml(statusLabel(item.status))}</b></span>
        <span>updated ${escapeHtml(formatUpdated(item.updated_at))}</span>
      </div>
      <div class="chip-bar">${relatedHtml(item)}</div>
    </div>
    <div class="stack-end"><button class="btn btn-quiet" type="button" data-details-kind="${escapeHtml(item.kind)}" data-details="${escapeHtml(item.id)}">Details</button>${open}</div>
  </li>`;
}

function renderGroups(visible) {
  if (!kindGroups) return;
  const groups = groupItemsByKind(visible, view.kinds);
  kindGroups.innerHTML = groups.map((group) => `<section aria-labelledby="group-${escapeHtml(group.kind)}">
      <div class="card-heading"><div><h3 id="group-${escapeHtml(group.kind)}">${escapeHtml(group.label)}</h3></div><span class="as-of">${group.items.length} shown</span></div>
      ${group.items.length === 0
        ? '<p class="small">No items shown</p>'
        : `<ul class="work-list">${group.items.map(itemRow).join("")}</ul>`}
    </section>`).join("");
}

const STATE_COPY = {
  loading: { title: "Loading…" },
  no_access: { title: "Sign-in required" },
  offline: { title: "Work temporarily unavailable" },
  empty: { title: "No work" },
  no_match: { title: "No matches" },
};

function renderState(phase, payload) {
  if (!inventoryState) return;
  inventoryState.hidden = phase === "ready";
  inventoryState.setAttribute("data-state", phase === "ready" ? "loading" : phase);
  if (phase === "ready") { inventoryState.innerHTML = ""; return; }
  if (phase === "partial") {
    // THE FAILURE THIS SLICE EXISTS TO PREVENT. An incomplete census must never
    // look like "no work", so the census's own explanation is the loudest thing
    // in this region — above the list, before any count.
    const summary = coverageSummary(payload?.coverage || []);
    inventoryState.setAttribute("data-state", "partial");
    inventoryState.innerHTML = `<h3>Partly available</h3>
      <div class="work-meta">${summary.unavailable.length} areas unavailable · ${summary.partial.length} partly available</div>`;
    return;
  }
  const copy = STATE_COPY[phase] || STATE_COPY.offline;
  inventoryState.innerHTML = `<h3>${escapeHtml(copy.title)}</h3>`;
}

function render() {
  renderFilters();
  const visible = view.items.filter(item => filterItemsByStatusText([{ status: statusLabel(item.status) }], view.statusText).length > 0);
  setDocFilters({ kinds:view.kinds, status:view.statusText });
  if (view.status === 'ready') publishDocRead('workInventory', { items:visible }, []);
  const phase = listPhase({ status: view.status, payload: view.payload, visible: visible.length });

  if (view.status === "loading") setCensusStatus("refreshing", "Reading the census…");
  else if (view.status === "unauthorized") setCensusStatus("unknown", "Session ended");
  else if (view.status === "error") setCensusStatus("urgent", "Census read unavailable");
  else if (view.payload) setCensusStatus(coverageOrbState(coverageSummary(view.payload.coverage).worst), view.payload.census_complete ? "Census complete" : "Census incomplete");

  if (!view.payload) {
    if (coverageStrip) coverageStrip.innerHTML = `<li class="work-item"><div><h3>Coverage unavailable</h3></div><span class="status" data-state="unknown"><span class="orb" data-state="unknown" aria-hidden="true"></span> Unavailable</span></li>`;
    if (coverageSummaryLine) coverageSummaryLine.textContent = "Coverage unknown until the census answers.";
    if (kindGroups) kindGroups.innerHTML = "";
    if (itemsCount) itemsCount.textContent = view.status === "loading" ? "Reading…" : "Unavailable";
    if (censusAsOf) censusAsOf.textContent = view.status === "loading" ? "Updating…" : "Unavailable";
    if (sourceLine) sourceLine.textContent = "";
    if (loadMore) loadMore.hidden = true;
    if (retryRead) retryRead.hidden = view.status !== "error" && view.status !== "unauthorized";
    if (stageRowsBody) stageRowsBody.innerHTML = "";
    if (dispositionRows) dispositionRows.innerHTML = "";
    if (stagesCount) stagesCount.textContent = "unknown";
    if (dispositionCount) dispositionCount.textContent = "unknown";
    if (stageDenominatorLine) stageDenominatorLine.textContent = "Denominator unknown until the census answers.";
    renderState(phase, null);
    announce(phase === "loading" ? "Reading the complete work inventory." : (STATE_COPY[phase] || STATE_COPY.offline).title);
    return;
  }

  const payload = view.payload;
  if (viewerLabel) viewerLabel.textContent = payload.viewer === "joe" ? "Joe's Workspace" : payload.viewer === "dell" ? "Dell's Workspace" : "Partner workspace";
  if (censusAsOf) censusAsOf.textContent = updatedLabel(payload.source.observed_at);
  renderCoverage(payload);
  renderGroups(visible);
  renderState(phase, payload);
  if (itemsCount) itemsCount.textContent = view.statusText
    ? `${visible.length} of ${view.items.length} items`
    : `${view.items.length} items`;
  if (sourceLine) sourceLine.textContent = "";
  if (loadMore) {
    loadMore.hidden = !payload.next_cursor;
    loadMore.disabled = false;
    loadMore.textContent = "Load more";
  }
  if (retryRead) retryRead.hidden = true;
  renderStages(visible, payload);
  renderDisposition(visible);
  announce(payload.census_complete
    ? `${visible.length} records shown. All areas available.`
    : `${visible.length} records shown. This census is incomplete: ${coverageSummary(payload.coverage).unavailable.length} areas unavailable.`);
}

/* ------------------------------------------------ delivery evidence (C11) */
//
// Two cards below the census, over the SAME rows the census already read and
// the same filter the person already applied. Nothing here reads a second work
// store, nothing counts against anything but coverage[].count_total, and no cell
// is ever painted positive from the absence of a field.
//
// Evidence is read LAZILY, one record at a time, on a button. A page that read a
// passport for every row on load would be a different product: it would hammer
// the record layer to paint a table most of which nobody is looking at.

const stageRowsBody = document.querySelector("#stageRows");
const stagesState = document.querySelector("#stagesState");
const stagesCount = document.querySelector("#stagesCount");
const stageDenominatorLine = document.querySelector("#stageDenominatorLine");
const dispositionRows = document.querySelector("#dispositionRows");
const dispositionCount = document.querySelector("#dispositionCount");

/** What has actually been READ, per record ref. Absent means unknown, not absent. */
const evidence = new Map();
const cards = new Map();
const cardReadSequence = new Map();
const details = { ref: null, kind: null, mode: null, status: null, sequence: 0 };

let client = null;
let commandState = {};
let dock = { record: () => {}, mount: () => {}, render: () => {} };
/** The popup's own state: what is being decided, and the draft that survives a refusal. */
const decision = { ref: null, choice: null, refusal: null };

const workRequestRows = (visible) => visible.filter((item) => item.kind === "work_request");

function stagesFor(ref) {
  const read = evidence.get(ref);
  if (!read) return deliveryStages(null);
  if (read.refusal) return deliveryStages(null).map((row) => ({ ...row, reason: read.refusal }));
  return read.stages;
}

function stageCellHtml(row) {
  return `<td class="stage-cell" data-stage="${escapeHtml(row.stage)}" data-stage-label="${escapeHtml(STAGE_LABEL[row.stage] || row.stage)}" data-state="${escapeHtml(row.state)}">${escapeHtml(stageLabel(row.state))}</td>`;
}

function stageRowHtml(item) {
  const cells = stagesFor(item.id).map(stageCellHtml).join("");
  return `<tr data-record="${escapeHtml(item.id)}">
    <td data-stage-label="Record">${escapeHtml(recordTitle(item))}</td>
    ${cells}
    <td data-stage-label="Evidence"><button class="btn btn-quiet" type="button" data-evidence="${escapeHtml(item.id)}">Evidence</button></td>
  </tr>`;
}

function renderStages(visible, payload) {
  if (!stageRowsBody) return;
  const rows = workRequestRows(visible);
  stageRowsBody.innerHTML = rows.map(stageRowHtml).join("");
  if (stagesState) {
    // An incomplete census degrades the WHOLE card: rows still render, every
    // cell still says what it knows, and no stage is counted at all.
    stagesState.hidden = payload.census_complete && rows.length > 0;
    stagesState.setAttribute("data-state", payload.census_complete ? "unknown" : "partial");
    stagesState.innerHTML = payload.census_complete
      ? "<h3>No work requests shown</h3>"
      : "<h3>Census incomplete: no stage can be counted</h3>";
  }
  const denominator = payload.census_complete ? stageDenominator(payload.coverage) : { known: false, total: null, reason: "the census is incomplete" };
  const proven = rows.filter((item) => stagesFor(item.id).some((cell) => cell.stage === "consumer_proven" && cell.state === "complete")).length;
  const count = renderCount(proven, denominator);
  if (stagesCount) stagesCount.textContent = `${rows.length} work request(s) on this page`;
  if (stageDenominatorLine) {
    stageDenominatorLine.textContent = count === "unknown"
      ? `Consumer proven: unknown — ${denominator.reason || "this area has no total"}.`
      : `Consumer proven: ${count} of every work request listed here.`;
  }
}

function dispositionRowHtml(item) {
  const card = cards.get(item.id) || null;
  const { state } = dispositionState(item, card);
  return `<li class="work-item" data-record="${escapeHtml(item.id)}">
    <div>
      <h3>${escapeHtml(recordTitle(item))}</h3>
      <div class="work-meta"><span><b>${escapeHtml(statusLabel(state))}</b></span></div>
    </div>
    <div class="stack-end"><button class="btn" type="button" data-open-card="${escapeHtml(item.id)}">Open details</button></div>
  </li>`;
}

function renderDisposition(visible) {
  if (!dispositionRows) return;
  const rows = workRequestRows(visible);
  dispositionRows.innerHTML = rows.map(dispositionRowHtml).join("");
  if (dispositionCount) dispositionCount.textContent = `${rows.length} work request(s) on this page`;
}

/* ------------------------------------------------------------- lazy reads */

const detailRowsHtml = rows => rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("");

function closeDetails() {
  details.sequence++;
  details.ref = null;
  details.kind = null;
  details.mode = null;
  const dialog = document.querySelector("#evidenceDialog");
  if (dialog?.open) dialog.close();
}

function renderRecordDetails() {
  const item = view.items.find(entry => entry.kind === details.kind && entry.id === details.ref);
  const rows = document.querySelector("#evidenceRows");
  const actions = document.querySelector("#evidenceActions");
  const card = details.status === "ready" && details.kind === "work_request" ? cards.get(details.ref) : null;
  document.querySelector("#evidenceTitle").textContent = recordTitle(item);
  document.querySelector("#evidenceEyebrow").textContent = "Details";
  document.querySelector("#evidenceRetry").hidden = details.status !== "unavailable";
  actions.innerHTML = "";
  if (details.status === "loading") {
    rows.innerHTML = "<dt>Details</dt><dd>Loading…</dd>";
    return;
  }
  if (details.status === "unavailable" || !item) {
    rows.innerHTML = "<dt>Details unavailable</dt><dd>Unavailable</dd>";
    return;
  }
  rows.innerHTML = detailRowsHtml([
    ["Area", KIND_LABEL[item.kind]], ["Status", statusLabel(card?.state || item.status)],
    ["Updated", formatUpdated(item.updated_at)], ["Record reference", item.id],
    ["Version", card?.version ?? item.version ?? "Unversioned"],
    ["Recorded status", card?.state || item.status || "Unstated"], ["Source", item.source_ref],
    ["Related records", item.related.map(link => `${link.kind}: ${link.id}`).join(" · ") || "None"],
  ]);
  if (!card) {
    rows.innerHTML += "<dt>Additional details</dt><dd>Unavailable here</dd>";
    return;
  }
  // The existing card operation returns the record, including fields beyond
  // the disposition contract. Keep that full read in Details, never in a row.
  rows.innerHTML += `<dt>Record data</dt><dd><pre class="record-data">${escapeHtml(JSON.stringify(card, null, 2))}</pre></dd>`;
  actions.innerHTML = availableActions(card).map(action => action.available
    ? `<button class="btn btn-secondary" type="button" data-action="${escapeHtml(action.choice)}" data-record="${escapeHtml(item.id)}">${escapeHtml(action.label)}</button>`
    : `<span class="small">${escapeHtml(action.label)}: ${escapeHtml(action.reason)}</span>`).join("");
  rows.innerHTML += detailRowsHtml(dispositionOptions(card).map(option => [option.label, option.available ? "Available" : "Unavailable here"]));
}

async function openRecordDetails(kind, ref) {
  if (!view.items.some(item => item.kind === kind && item.id === ref)) return;
  const sequence = ++details.sequence;
  Object.assign(details, { kind, ref, mode: "record", status: kind === "work_request" ? "loading" : "ready" });
  renderRecordDetails();
  const dialog = document.querySelector("#evidenceDialog");
  if (dialog && typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
  if (kind !== "work_request") return;
  const card = await readCard(ref);
  // Closing the popup or selecting another record cancels its presentation.
  if (sequence !== details.sequence) return;
  details.status = card ? "ready" : "unavailable";
  renderRecordDetails();
}

async function readEvidence(ref) {
  const item = view.items.find((entry) => entry.id === ref) || null;
  if (!item || !client) return;
  // Opening or closing another popup while this read waits supersedes it.
  const sequence = ++details.sequence;
  let passport = null;
  let refusal = null;
  try {
    const answer = await client.engineeringPassport({ work_request: ref });
    if (validPassportPayload(answer)) passport = answer;
    else refusal = "the passport answered in a shape this page does not read";
  } catch (error) {
    refusal = refusalMessage(error?.payload?.error || "unreadable", { ref });
  }
  evidence.set(ref, { passport, refusal, stages: deliveryStages(passport) });
  render();
  if (sequence === details.sequence) openEvidence(ref);
}

function openEvidence(ref) {
  const dialog = document.querySelector("#evidenceDialog");
  const title = document.querySelector("#evidenceTitle");
  const rows = document.querySelector("#evidenceRows");
  const read = evidence.get(ref) || {};
  details.sequence++;
  Object.assign(details, { ref, kind: "work_request", mode: "evidence" });
  if (title) title.textContent = recordTitle(view.items.find(item => item.kind === "work_request" && item.id === ref));
  document.querySelector("#evidenceEyebrow").textContent = "Delivery evidence";
  document.querySelector("#evidenceActions").innerHTML = "";
  document.querySelector("#evidenceRetry").hidden = Boolean(read.passport) && !read.refusal;
  if (rows) {
    const detail = [
      ["Stages", stagesFor(ref).map((cell) => `${STAGE_LABEL[cell.stage]}: ${stageLabel(cell.state)}`).join(" · ")],
      ["Stage details", stagesFor(ref).map(cell => `${STAGE_LABEL[cell.stage]}: ${cell.evidence_ref || cell.reason || "Unavailable"}`).join(" · ")],
      ["Closure", read.passport ? `${read.passport.closure_state} · ${Object.entries(read.passport.closure).map(([name, facet]) => `${name} ${facet.state}`).join(", ")}` : "unknown"],
      ["Reviewer facts", read.passport ? String(read.passport.current_reviewer_facts.length) : "unknown"],
      ["Plan", read.passport ? `${read.passport.stale_conflict.state === "stale" ? "stale" : "current"}` : "unknown"],
      ["Reason", read.refusal || (read.passport ? "" : NO_PASSPORT_REASON)],
    ];
    rows.innerHTML = detail.filter(([, value]) => value !== "").map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("");
  }
  if (dialog && typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
}

/** The fresh read every write is built from, and the one the row's state shows. */
async function readCard(ref, { signal } = {}) {
  if (!client) return null;
  const sequence = (cardReadSequence.get(ref) || 0) + 1;
  cardReadSequence.set(ref, sequence);
  const current = () => !signal?.aborted && cardReadSequence.get(ref) === sequence;
  try {
    const args = { work_request: ref };
    const answer = await readWithDeadline(current => client.workRequestCard(args, { signal: current }), { signal });
    if (!current()) return null;
    if (!validWorkRequestCard(answer) || answer.human_ref !== ref) throw new Error("Card unavailable");
    cards.set(ref, answer);
    render();
    return answer;
  } catch {
    if (!current()) return null;
    cards.delete(ref);
    render();
    announce("Record details unavailable. Retry the read.");
    return null;
  }
}

/* ---------------------------------------------------------------- the popup */

const field = (id) => document.querySelector(id);

function renderDispositionForm() {
  const card = cards.get(decision.ref) || null;
  const choice = decision.choice;
  const shape = choice === "shape";
  field("#dispositionDialogTitle").textContent = recordTitle(view.items.find(item => item.kind === "work_request" && item.id === decision.ref));
  field("#dispositionDialogEyebrow").textContent = shape ? "Shape disposition" : choice === "decline" ? "Decline" : "Supersede";
  field("#dispositionSuccessorField").hidden = choice !== "supersede";
  field("#dispositionShapeField").hidden = !shape;
  field("#dispositionSurfaceField").hidden = !shape || field("#dispositionShape").value !== "not_required";
  field("#dispositionReasonLabel").textContent = shape ? "Rationale" : "Why";
  field("#dispositionEffect").textContent = dispositionEffect(choice, decision.ref, {
    successor: field("#dispositionSuccessor").value,
    disposition: shape ? field("#dispositionShape").value : "",
  });
  const refusal = field("#dispositionRefusal");
  refusal.hidden = !decision.refusal;
  refusal.textContent = decision.refusal || "";
  field("#dispositionReread").hidden = !decision.refusal;
  field("#dispositionConfirm").disabled = !card;
}

function openDisposition(ref, choice) {
  closeDetails();
  decision.ref = ref;
  decision.choice = choice;
  decision.refusal = null;
  // The input, the selection and the draft are kept across a refusal, so the
  // only field cleared is the one belonging to a different record.
  renderDispositionForm();
  const dialog = field("#dispositionDialog");
  if (dialog && typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
  field("#dispositionReason").focus();
}

// One label per classified outcome, so the visible line and the live
// announcement keep the same certainty.
const outcomeLabel = status => ({
  ok: "Changes saved", unknown: "Outcome unavailable", in_flight: "Still sending",
  blocked: "An earlier change is unresolved",
}[status] || "Changes were not saved");

async function submitDisposition() {
  const ref = decision.ref;
  const choice = decision.choice;
  // ALWAYS a fresh read immediately before the write: the base_version a command
  // carries comes from that read and from nothing on screen.
  const card = await readCard(ref);
  if (!card) {
    decision.refusal = refusalMessage("unreadable", { ref });
    renderDispositionForm();
    return;
  }
  let args;
  try {
    args = dispositionArgs({
      card, choice,
      reason: field("#dispositionReason").value,
      successor: field("#dispositionSuccessor").value,
      fixedSurfaceRef: field("#dispositionSurface").value,
      disposition: choice === "shape" ? field("#dispositionShape").value : "",
    });
  } catch (error) {
    decision.refusal = error.message;
    renderDispositionForm();
    return;
  }
  const operationKey = operationKeys[choice](ref);
  const summary = `${{ decline: "Decline", supersede: "Supersede", shape: "Shape disposition" }[choice]}: ${recordTitle(view.items.find(item => item.kind === "work_request" && item.id === ref))}`;
  field("#commandStatus").textContent = `${summary} · Saving…`;
  dock.record(operationKey, { summary, status: "sending", undo: false });
  const send = (request) => (choice === "decline" ? client.declineWorkRequest(request)
    : choice === "supersede" ? client.supersedeWorkRequest(request)
      : client.setWorkShapeDisposition(request));
  const result = await performCommand({
    operationKey, args,
    getState: () => commandState,
    setState: (next) => { commandState = next; },
    newKey: uuidv4,
    call: send,
  });
  field("#commandStatus").textContent = `${summary} · ${outcomeLabel(result.status)}`;
  dock.record(operationKey, {
    summary, status: result.status, reason: result.message || null,
    retry: result.retry, undo: false, request: result.request,
  });
  if (result.status === "ok") {
    // A replayed answer is the recorded result of THIS operation, so it is
    // confirmed exactly as much as a first answer is.
    announce(`${summary}${result.replayed ? " Already recorded under the same safety key; confirmed." : " Confirmed."}`);
    decision.refusal = null;
    closeDisposition();
    cards.delete(ref);
    evidence.delete(ref);
    await read();
    return;
  }
  decision.refusal = result.reason === "version_conflict"
    ? `Changed elsewhere. ${result.message || ""}`.trim()
    : result.message || refusalMessage(result.code, { ref });
  renderDispositionForm();
  announce(`${outcomeLabel(result.status)}. Review the open record details.`);
}

function closeDisposition() {
  const dialog = field("#dispositionDialog");
  if (dialog?.open) dialog.close();
  decision.ref = null;
  decision.choice = null;
  decision.refusal = null;
}

/* --------------------------------------------------------------------- reading */

const accepts = (sequence) => sequence === view.sequence;

async function read({ cursor = null, append = false, background = false, signal } = {}) {
  const sequence = ++view.sequence;
  if (!append) {
    view.status = "loading";
    view.payload = null;
    view.items = [];
    view.message = null;
    render();
  } else if (loadMore) {
    loadMore.disabled = true;
    loadMore.setAttribute("aria-busy", "true");
    loadMore.textContent = "Loading…";
  }
  const cancel = () => {
    if (!accepts(sequence)) return;
    settle({ status: "error", message: "Work refresh timed out." }, sequence, append);
    view.sequence += 1;
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (signal?.aborted) { cancel(); return; }
    const path = inventoryRequestPath({ kinds: view.kinds, limit: WORK_INVENTORY_LIMIT_DEFAULT, cursor });
    const response = await fetchRead(path, { headers: { accept: "application/json" }, cache: "no-store", signal });
    if (!accepts(sequence)) return;
    if (response.status === 401 || response.status === 403) return settle({ status: "unauthorized" }, sequence, append);
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      if (!accepts(sequence)) return;
      if (failure.error === "AUTHENTICATION_REQUIRED" || failure.error === "AUTHORIZATION_REFUSED") return settle({ status: "unauthorized" }, sequence, append);
      const message = failure.error === "DEPENDENCY_UNAVAILABLE" ? "Work updates incomplete."
        : failure.error === "FRESHNESS_UNKNOWN" ? "CARR could not establish the freshness of this census, so no count is shown as current."
          : failure.error === "not_found" ? "This census endpoint is not available on this host."
            : "The census read failed. Nothing here has been inferred.";
      return settle({ status: "error", message }, sequence, append);
    }
    let payload = await response.json().catch(() => null);
    if (!accepts(sequence)) return;
    if (!validWorkInventoryPayload(payload)) {
      return settle({ status: "error", message: "The census returned an unexpected shape, so no part of it is shown as an inventory." }, sequence, append);
    }
    if (background) {
      const takePage = createPageBudget();
      for (let page = 1; page < view.loadedPages && payload.next_cursor; page++) {
        takePage();
        const next = await fetchRead(inventoryRequestPath({ kinds: view.kinds, limit: WORK_INVENTORY_LIMIT_DEFAULT, cursor: payload.next_cursor }), { headers: { accept: "application/json" }, cache: "no-store", signal });
        if (!accepts(sequence)) return;
        if (!next.ok) throw new Error("Work page unavailable");
        const incoming = await next.json();
        if (!accepts(sequence)) return;
        if (!validWorkInventoryPayload(incoming)) throw new Error("Work page unavailable");
        payload = { ...incoming, items: mergeInventoryPages(payload.items, incoming.items) };
      }
    } else view.loadedPages = append ? view.loadedPages + 1 : 1;
    settle({ status: "ready", payload }, sequence, append);
  } catch {
    if (!accepts(sequence)) return;
    settle({ status: "error", message: "The browser could not reach the census read. Nothing here has been inferred." }, sequence, append);
  } finally { signal?.removeEventListener("abort", cancel); }
}

function settle({ status, payload = null, message = null }, sequence, append) {
  if (!accepts(sequence)) return;
  view.status = status;
  if (status !== 'ready') pageDocContext?.clear();
  view.message = message;
  if (status === "ready") {
    // The newest page's coverage and source govern; the item list accumulates.
    view.items = append ? mergeInventoryPages(view.items, payload.items) : [...payload.items];
    view.payload = payload;
  } else {
    view.payload = null;
    view.items = [];
  }
  render();
  if (status === "ready" && append && loadMore) loadMore.removeAttribute("aria-busy");
}

/* ---------------------------------------------------------------------- wiring */

function toggleKind(kind) {
  if (!WORK_INVENTORY_KINDS.includes(kind)) return;
  const next = view.kinds.includes(kind) ? view.kinds.filter((entry) => entry !== kind) : [...view.kinds, kind];
  // Deselecting the last source would ask CARR for nothing and show nothing,
  // which is the empty-queue illusion again. The census keeps at least one leg.
  if (next.length === 0) {
    announce("Select at least one category.");
    return;
  }
  view.kinds = WORK_INVENTORY_KINDS.filter((entry) => next.includes(entry));
  read();
}

kindChips.forEach((chip) => chip.addEventListener("click", () => toggleKind(chip.dataset.kind)));
kindReset?.addEventListener("click", () => {
  view.kinds = [...WORK_INVENTORY_KINDS];
  read();
  kindReset.blur();
});
statusFilter?.addEventListener("input", () => {
  view.statusText = statusFilter.value;
  render();
});
loadMore?.addEventListener("click", () => {
  if (view.payload?.next_cursor) read({ cursor: view.payload.next_cursor, append: true });
});
retryRead?.addEventListener("click", () => read());

stageRowsBody?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-evidence]");
  if (button) readEvidence(button.dataset.evidence);
});
dispositionRows?.addEventListener("click", (event) => {
  const open = event.target.closest("button[data-open-card]");
  if (open) openRecordDetails("work_request", open.dataset.openCard);
});
kindGroups?.addEventListener("click", event => {
  const button = event.target.closest("button[data-details]");
  if (button) openRecordDetails(button.dataset.detailsKind, button.dataset.details);
});
document.querySelector("#evidenceActions")?.addEventListener("click", event => {
  const action = event.target.closest("button[data-action]");
  if (action) openDisposition(action.dataset.record, action.dataset.action);
});
document.querySelector("#evidenceRetry")?.addEventListener("click", () => {
  if (details.mode === "evidence") readEvidence(details.ref);
  else if (details.mode === "record") openRecordDetails(details.kind, details.ref);
});
document.querySelector("#evidenceClose")?.addEventListener("click", closeDetails);
document.querySelector("#evidenceDialog")?.addEventListener("cancel", closeDetails);
document.querySelector("#dispositionClose")?.addEventListener("click", closeDisposition);
document.querySelector("#dispositionCancel")?.addEventListener("click", closeDisposition);
document.querySelector("#dispositionShape")?.addEventListener("change", renderDispositionForm);
document.querySelector("#dispositionSuccessor")?.addEventListener("input", renderDispositionForm);
// The reconcile a conflict actually needs: read the card again and show what it
// holds now. Nothing is retried, and the person decides from the fresh state.
document.querySelector("#dispositionReread")?.addEventListener("click", async () => {
  const card = await readCard(decision.ref);
  decision.refusal = card ? `This record now reads ${card.state} at version ${card.version}. Decide from that.` : refusalMessage("unreadable", { ref: decision.ref });
  renderDispositionForm();
});
document.querySelector("#dispositionForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  submitDisposition();
});

function mountDock() {
  const root = document.querySelector("#receiptDock");
  if (!root) return;
  dock = createCommandDock({
    root,
    onDispatch: () => announce("Open the record again and decide from what it holds now; a refused command is not retried blind."),
    onReconcile: () => announce("Open the record again to check what it holds; nothing is re-sent from here."),
    onUndo: null,
  });
  dock.mount();
}

async function boot() {
  mountPrefs();

  mountDock();
  const resolved = resolveDealroomBoot(globalThis.location || { hostname: "", search: "" });
  client = resolved.mode === "live" ? createLiveClient() : await (await import("./fixture-client.js")).createFixtureClient(resolved.options);
  mountNotificationBadge(client);
  await read();
  mountAutoRefresh({ document, window: globalThis.window, refresh: async ({ signal }) => { await read({ background: true, signal }); if (!signal.aborted && decision.ref) await readCard(decision.ref, { signal }); } });
}

boot();

export { WORK_INVENTORY_ENDPOINT };
