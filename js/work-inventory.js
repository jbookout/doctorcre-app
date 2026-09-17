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
  validPassportPayload, validPortfolioPayload, validWorkRequestCard,
} from "./delivery-evidence-model.js";
import { createCommandDock } from "./command-dock.js";
import { createCommandState, performCommand } from "./command-feedback.mjs";
import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountDocDock, mountPrefs } from "./shell.js";
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
  message: null,
  sequence: 0,
};

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

function announce(text) {
  if (live && live.textContent !== text) live.textContent = text;
}

function formatObserved(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Observed time unavailable";
  return `Observed ${date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
}

function formatUpdated(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "updated time unavailable";
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
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
  if (requestPath) requestPath.textContent = `Request: ${inventoryRequestPath({ kinds: view.kinds, limit: WORK_INVENTORY_LIMIT_DEFAULT })}`;
}

function coverageRow(entry) {
  const orb = coverageOrbState(entry.state);
  const total = Number.isInteger(entry.count_total) ? `${entry.count_total} in this source` : "total not claimed";
  const reason = entry.reason ? ` · ${escapeHtml(entry.reason)}` : "";
  const capped = entry.page_capped === true ? " · more rows remain behind the page limit" : "";
  const excluded = Number.isInteger(entry.excluded_other_tenant) && entry.excluded_other_tenant > 0
    ? ` · ${entry.excluded_other_tenant} row(s) outside this tenant were dropped` : "";
  return `<li class="work-item" data-kind="${escapeHtml(entry.kind)}" data-coverage="${escapeHtml(entry.state)}">
    <div><h3>${escapeHtml(KIND_LABEL[entry.kind] || entry.kind)}</h3>
      <div class="work-meta"><span><b>${escapeHtml(entry.count_returned)}</b> shown</span><span>${escapeHtml(total)}</span><span class="mono">${escapeHtml(entry.source_ref)}</span></div>
      <p class="small">${escapeHtml(COVERAGE_COPY[entry.state] || "Coverage unknown.")}${reason}${capped}${excluded}</p>
    </div>
    <span class="status" data-state="${escapeHtml(orb)}"><span class="orb" data-state="${escapeHtml(orb)}" aria-hidden="true"></span> ${escapeHtml(entry.state)}</span>
  </li>`;
}

function renderCoverage(payload) {
  if (!coverageStrip) return;
  coverageStrip.innerHTML = payload.coverage.map(coverageRow).join("");
  const summary = coverageSummary(payload.coverage);
  if (!coverageSummaryLine) return;
  const total = summary.total === null ? "no census-wide total is claimed" : `${summary.total} records counted across every source`;
  coverageSummaryLine.textContent = `${summary.complete.length} of ${summary.sources} sources complete · ${summary.partial.length} partial · ${summary.unavailable.length} unavailable · ${total}`;
  coverageSummaryLine.setAttribute("data-stale", payload.census_complete ? "false" : "true");
}

function relatedHtml(item) {
  if (item.unlinked) return '<span class="chip" aria-label="No related record is recorded for this item">unlinked</span>';
  return item.related.map((link) => `<span class="chip"><span class="chip-label">${escapeHtml(link.kind)}</span>${escapeHtml(link.id)}</span>`).join("");
}

function itemRow(item) {
  const open = item.open
    ? `<a class="btn" href="${escapeHtml(item.open)}">Open</a>`
    : '<span class="small">No surface owns this record yet</span>';
  return `<li class="work-item" data-kind="${escapeHtml(item.kind)}">
    <div>
      <h3>${escapeHtml(item.title || item.id)}</h3>
      <div class="work-meta">
        <span>${escapeHtml(KIND_LABEL[item.kind] || item.kind)}</span>
        <span class="mono">${escapeHtml(item.id)}</span>
        <span>version <b>${escapeHtml(item.version ?? "unversioned")}</b></span>
        <span>status <b>${escapeHtml(item.status ?? "unstated")}</b></span>
        <span>updated ${escapeHtml(formatUpdated(item.updated_at))}</span>
      </div>
      <div class="chip-bar">${relatedHtml(item)}</div>
    </div>
    ${open}
  </li>`;
}

function renderGroups(visible) {
  if (!kindGroups) return;
  const groups = groupItemsByKind(visible, view.kinds);
  kindGroups.innerHTML = groups.map((group) => `<section aria-labelledby="group-${escapeHtml(group.kind)}">
      <div class="card-heading"><div><p class="eyebrow">${escapeHtml(group.kind)}</p><h3 id="group-${escapeHtml(group.kind)}">${escapeHtml(group.label)}</h3></div><span class="as-of">${group.items.length} shown</span></div>
      ${group.items.length === 0
        ? '<p class="small">No row from this source is in the records read so far.</p>'
        : `<ul class="work-list">${group.items.map(itemRow).join("")}</ul>`}
    </section>`).join("");
}

const STATE_COPY = {
  loading: { title: "Reading the complete work inventory…", copy: "Six canonical sources are being read at request time. Nothing below is cached." },
  no_access: { title: "Your session has ended", copy: "Sign in again to read the inventory. No count is shown from a session that has ended." },
  offline: { title: "The census could not be read", copy: "Nothing here has been inferred, and no earlier page is being shown as current." },
  empty: { title: "Every source answered, and there is no work", copy: "All six sources reported complete coverage and returned no records. This is an empty inventory, not a failed read." },
  no_match: { title: "No record matches this status filter", copy: "The census returned records; your status text excluded all of them. Clear the filter to see every status again." },
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
    inventoryState.innerHTML = `<h3>This census is incomplete, not empty</h3>
      <p>${escapeHtml(payload?.source?.safe_explanation || "At least one source could not be enumerated in full.")}</p>
      <p class="small">${summary.unavailable.length} source(s) unavailable · ${summary.partial.length} partial. Work held only in those sources is missing from the list below.</p>`;
    return;
  }
  const copy = STATE_COPY[phase] || STATE_COPY.offline;
  inventoryState.innerHTML = `<h3>${escapeHtml(copy.title)}</h3><p>${escapeHtml(view.message || copy.copy)}</p>`;
}

function render() {
  renderFilters();
  const visible = filterItemsByStatusText(view.items, view.statusText);
  const phase = listPhase({ status: view.status, payload: view.payload, visible: visible.length });

  if (view.status === "loading") setCensusStatus("refreshing", "Reading the census…");
  else if (view.status === "unauthorized") setCensusStatus("unknown", "Session ended");
  else if (view.status === "error") setCensusStatus("urgent", "Census read unavailable");
  else if (view.payload) setCensusStatus(coverageOrbState(coverageSummary(view.payload.coverage).worst), view.payload.census_complete ? "Census complete" : "Census incomplete");

  if (!view.payload) {
    if (coverageStrip) coverageStrip.innerHTML = `<li class="work-item"><div><h3>Coverage unavailable</h3><p class="small">No source has answered, so no source is shown as healthy.</p></div><span class="status" data-state="unknown"><span class="orb" data-state="unknown" aria-hidden="true"></span> unknown</span></li>`;
    if (coverageSummaryLine) coverageSummaryLine.textContent = "Coverage unknown until the census answers.";
    if (kindGroups) kindGroups.innerHTML = "";
    if (itemsCount) itemsCount.textContent = view.status === "loading" ? "Reading…" : "No verified read";
    if (censusAsOf) censusAsOf.textContent = view.status === "loading" ? "Reading canonical state…" : "No verified read";
    if (sourceLine) sourceLine.textContent = "Source pending";
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
  if (viewerLabel) viewerLabel.textContent = payload.viewer === "joe" ? "Joe’s workspace" : payload.viewer === "dell" ? "Dell’s workspace" : "Partner workspace";
  if (censusAsOf) censusAsOf.textContent = `${formatObserved(payload.source.observed_at)} · freshness ${payload.source.freshness}`;
  renderCoverage(payload);
  renderGroups(visible);
  renderState(phase, payload);
  if (itemsCount) itemsCount.textContent = view.statusText
    ? `${visible.length} of ${view.items.length} records read match this status filter`
    : `${view.items.length} records read`;
  if (sourceLine) sourceLine.textContent = `Source: ${payload.source.source} · ${payload.source.source_ref} · correlation ${payload.source.correlation_id}`;
  if (loadMore) {
    loadMore.hidden = !payload.next_cursor;
    loadMore.disabled = false;
    loadMore.textContent = "Load more";
  }
  if (retryRead) retryRead.hidden = true;
  renderStages(visible, payload);
  renderDisposition(visible);
  announce(payload.census_complete
    ? `${visible.length} records shown. Every source answered completely.`
    : `${visible.length} records shown. This census is incomplete: ${coverageSummary(payload.coverage).unavailable.length} source(s) unavailable.`);
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

let client = null;
let commandState = createCommandState();
let dock = { record: () => {}, mount: () => {}, render: () => {} };
/** The popup's own state: what is being decided, and the draft that survives a refusal. */
const decision = { ref: null, choice: null, refusal: null };

const workRequestRows = (visible) => visible.filter((item) => item.kind === "work_request");

/**
 * The portfolio this record names, or null. The passport does not carry one and
 * neither does the card, so the only honest source is what the census itself
 * linked: a related portfolio node. No portfolio named means the Approved cell
 * stays unknown — it is never inferred from a plan or a title.
 */
function portfolioRefFor(item, card) {
  if (card && typeof card.plan?.portfolio_ref === "string" && card.plan.portfolio_ref !== "") return card.plan.portfolio_ref;
  const link = (item.related || []).find((entry) => entry.kind === "portfolio_node");
  return link ? link.id : null;
}

function stagesFor(ref) {
  const read = evidence.get(ref);
  if (!read) return deliveryStages(null);
  if (read.refusal) return deliveryStages(null).map((row) => ({ ...row, reason: read.refusal }));
  return read.stages;
}

function stageCellHtml(row) {
  const title = row.state === "complete" ? row.evidence_ref || "" : row.reason || "";
  return `<td class="stage-cell" data-stage="${escapeHtml(row.stage)}" data-stage-label="${escapeHtml(STAGE_LABEL[row.stage] || row.stage)}" data-state="${escapeHtml(row.state)}" title="${escapeHtml(title)}">${escapeHtml(row.state)}</td>`;
}

function stageRowHtml(item) {
  const cells = stagesFor(item.id).map(stageCellHtml).join("");
  return `<tr data-record="${escapeHtml(item.id)}">
    <td data-stage-label="Record">${escapeHtml(item.title || item.id)} <span class="mono">${escapeHtml(item.id)}</span></td>
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
      ? "<h3>No work request is in the records read so far</h3>"
      : "<h3>Census incomplete: no stage can be counted</h3>";
  }
  const denominator = payload.census_complete ? stageDenominator(payload.coverage) : { known: false, total: null, reason: "the census is incomplete" };
  const proven = rows.filter((item) => stagesFor(item.id).some((cell) => cell.stage === "consumer_proven" && cell.state === "complete")).length;
  const count = renderCount(proven, denominator);
  if (stagesCount) stagesCount.textContent = `${rows.length} work request(s) on this page`;
  if (stageDenominatorLine) {
    stageDenominatorLine.textContent = count === "unknown"
      ? `Consumer proven: unknown — ${denominator.reason || "this source claimed no total"}.`
      : `Consumer proven: ${count} of every work request this source holds.`;
  }
}

function dispositionRowHtml(item) {
  const card = cards.get(item.id) || null;
  const { state, source: stateSource } = dispositionState(item, card);
  const stateMarker = stateSource === "census" ? ` <span class="small">from the census read</span>` : "";
  const actions = card
    ? availableActions(card).map((action) => (action.available
      ? `<button class="btn btn-secondary" type="button" data-action="${escapeHtml(action.choice)}" data-record="${escapeHtml(item.id)}">${escapeHtml(action.label)}</button>`
      : `<span class="small">${escapeHtml(action.label)}: ${escapeHtml(action.reason)}</span>`)).join("")
    : `<button class="btn" type="button" data-open-card="${escapeHtml(item.id)}">Read this record</button>`;
  const options = card
    ? `<div class="chip-bar">${dispositionOptions(card).map((option) => `<span class="chip"><span class="chip-label">${escapeHtml(option.label)}</span>${escapeHtml(option.available ? "available" : "not available here")}</span>`).join("")}</div>`
    : "";
  return `<li class="work-item" data-record="${escapeHtml(item.id)}">
    <div>
      <h3>${escapeHtml(item.title || item.id)}</h3>
      <div class="work-meta"><span class="mono">${escapeHtml(item.id)}</span><span>state <b>${escapeHtml(state)}</b>${stateMarker}</span></div>
      ${options}
    </div>
    <div class="stack-end">${actions}</div>
  </li>`;
}

function renderDisposition(visible) {
  if (!dispositionRows) return;
  const rows = workRequestRows(visible);
  dispositionRows.innerHTML = rows.map(dispositionRowHtml).join("");
  if (dispositionCount) dispositionCount.textContent = `${rows.length} work request(s) on this page`;
}

/* ------------------------------------------------------------- lazy reads */

async function readEvidence(ref) {
  const item = view.items.find((entry) => entry.id === ref) || null;
  if (!item || !client) return;
  let passport = null;
  let portfolio = null;
  let refusal = null;
  try {
    const answer = await client.engineeringPassport({ work_request: ref });
    if (validPassportPayload(answer)) passport = answer;
    else refusal = "the passport answered in a shape this page does not read";
  } catch (error) {
    refusal = refusalMessage(error?.payload?.error || "unreadable", { ref });
  }
  const portfolioRef = portfolioRefFor(item, cards.get(ref) || null);
  if (passport && portfolioRef) {
    try {
      const answer = await client.readPortfolio({ portfolio_ref: portfolioRef });
      if (validPortfolioPayload(answer)) portfolio = answer;
    } catch {
      portfolio = null;
    }
  }
  evidence.set(ref, { passport, portfolio, refusal, stages: passport ? deliveryStages(passport, portfolio) : deliveryStages(null) });
  render();
  openEvidence(ref);
}

function openEvidence(ref) {
  const dialog = document.querySelector("#evidenceDialog");
  const title = document.querySelector("#evidenceTitle");
  const rows = document.querySelector("#evidenceRows");
  const read = evidence.get(ref) || {};
  if (title) title.textContent = ref;
  if (rows) {
    const detail = [
      ["Stages", stagesFor(ref).map((cell) => `${STAGE_LABEL[cell.stage]}: ${cell.state}`).join(" · ")],
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
async function readCard(ref) {
  if (!client) return null;
  try {
    const answer = await client.workRequestCard({ work_request: ref });
    if (!validWorkRequestCard(answer)) {
      announce(`${ref}: the card answered in a shape this page does not read.`);
      return null;
    }
    cards.set(ref, answer);
    render();
    return answer;
  } catch (error) {
    announce(`${ref}: ${refusalMessage(error?.payload?.error || "unreadable", { ref })}`);
    return null;
  }
}

/* ---------------------------------------------------------------- the popup */

const field = (id) => document.querySelector(id);

function renderDispositionForm() {
  const card = cards.get(decision.ref) || null;
  const choice = decision.choice;
  const shape = choice === "shape";
  field("#dispositionDialogTitle").textContent = decision.ref || "Record";
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
  const summary = dispositionEffect(choice, ref, { successor: args.superseded_by || "", disposition: args.disposition || "" });
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
    ? `someone else changed this record; read again. ${result.message || ""}`.trim()
    : result.message || refusalMessage(result.code, { ref });
  renderDispositionForm();
  announce(decision.refusal);
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

async function read({ cursor = null, append = false } = {}) {
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
  try {
    const path = inventoryRequestPath({ kinds: view.kinds, limit: WORK_INVENTORY_LIMIT_DEFAULT, cursor });
    const response = await fetch(path, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!accepts(sequence)) return;
    if (response.status === 401 || response.status === 403) return settle({ status: "unauthorized" }, sequence, append);
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      if (!accepts(sequence)) return;
      if (failure.error === "AUTHENTICATION_REQUIRED" || failure.error === "AUTHORIZATION_REFUSED") return settle({ status: "unauthorized" }, sequence, append);
      const message = failure.error === "DEPENDENCY_UNAVAILABLE" ? "A source CARR depends on is unavailable right now, so no partial census is presented as whole."
        : failure.error === "FRESHNESS_UNKNOWN" ? "CARR could not establish the freshness of this census, so no count is shown as current."
          : failure.error === "not_found" ? "This census endpoint is not available on this host."
            : "The census read failed. Nothing here has been inferred.";
      return settle({ status: "error", message }, sequence, append);
    }
    const payload = await response.json().catch(() => null);
    if (!accepts(sequence)) return;
    if (!validWorkInventoryPayload(payload)) {
      return settle({ status: "error", message: "The census returned an unexpected shape, so no part of it is shown as an inventory." }, sequence, append);
    }
    settle({ status: "ready", payload }, sequence, append);
  } catch {
    if (!accepts(sequence)) return;
    settle({ status: "error", message: "The browser could not reach the census read. Nothing here has been inferred." }, sequence, append);
  }
}

function settle({ status, payload = null, message = null }, sequence, append) {
  if (!accepts(sequence)) return;
  view.status = status;
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
    announce("At least one source must stay selected. Nothing was changed.");
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
  if (open) { readCard(open.dataset.openCard); return; }
  const action = event.target.closest("button[data-action]");
  if (action) openDisposition(action.dataset.record, action.dataset.action);
});
document.querySelector("#evidenceClose")?.addEventListener("click", () => document.querySelector("#evidenceDialog")?.close());
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
  mountDocDock("Complete Work Inventory");
  mountDock();
  const resolved = resolveDealroomBoot(globalThis.location || { hostname: "", search: "" });
  client = resolved.mode === "live" ? createLiveClient() : await createFixtureClient(resolved.options);
  await read();
}

boot();

export { WORK_INVENTORY_ENDPOINT };
