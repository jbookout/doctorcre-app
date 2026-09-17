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
  coverageOrbState, coverageSummary, filterItemsByStatusText, groupItemsByKind, inventoryRequestPath,
  listPhase, mergeInventoryPages, validWorkInventoryPayload,
} from "./work-inventory-model.js";
import { DEFAULT_PREFERENCES, preferenceAttributes, resolvePreferences } from "./visual-system.js";

const PREFS_KEY = "doctorcre.visual-preferences";

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

function storedPreferences() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch { return {}; }
}

function persistPreferences(preferences) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(preferences)); } catch { /* a convenience, never a requirement */ }
}

function systemPreferences() {
  return { prefersReducedMotion: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true };
}

function applyPreferences(preferences) {
  Object.entries(preferenceAttributes(preferences)).forEach(([attribute, value]) => document.documentElement.setAttribute(attribute, value));
  document.querySelectorAll("[data-pref]").forEach((group) => {
    const key = group.getAttribute("data-pref");
    group.querySelectorAll("button[data-value]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.value === preferences[key])));
  });
}

function wirePreferences() {
  let current = resolvePreferences({ ...DEFAULT_PREFERENCES, ...storedPreferences() }, systemPreferences());
  applyPreferences(current);
  document.querySelectorAll("[data-pref]").forEach((group) => {
    const key = group.getAttribute("data-pref");
    group.querySelectorAll("button[data-value]").forEach((button) => button.addEventListener("click", () => {
      current = resolvePreferences({ ...current, [key]: button.dataset.value }, systemPreferences());
      persistPreferences(current);
      applyPreferences(current);
      const note = document.querySelector("#prefsLive");
      if (note) note.textContent = `${key} set to ${current[key]}`;
    }));
  });
}

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
  announce(payload.census_complete
    ? `${visible.length} records shown. Every source answered completely.`
    : `${visible.length} records shown. This census is incomplete: ${coverageSummary(payload.coverage).unavailable.length} source(s) unavailable.`);
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

wirePreferences();
read();

export { WORK_INVENTORY_ENDPOINT };
