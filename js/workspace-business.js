import { fetchRead, mountAutoRefresh, updatedLabel } from "./auto-refresh.mjs";
// Clients and Vendors: the browser half of the Journey 1 business read.
//
// THE URL IS THE VIEW'S MEMORY. Search text, every filter, the sort, the page
// and the open record all live in the address, so Back restores a place instead
// of reloading a default, and opening a record never costs the reader the list
// they were reading. Scroll rides in the history entry beside it.
//
// A LATE ANSWER NEVER PAINTS. Every read carries a sequence number, and the
// server's echoed query has to be the query that was asked; a response failing
// either test is dropped rather than allowed to repaint someone else's filter
// over the one on screen.
//
// A SIGN-OUT ERASES EVERYTHING THIS VIEW HOLDS. One 401 clears the list, the
// open record, the remembered answers Back would repaint and both in-flight
// generations (see expireSession). Ordinary trouble — unreachable, offline, a
// refused filter — deliberately does none of that.
//
// NOTHING HERE COUNTS OR FILTERS. The total, the page window and the matching
// set are the server's answers; this file renders them or says why it cannot.

import {
  DATASET_LABEL, DATASET_ROUTE, DATASET_SINGULAR, MAX_QUERY_LENGTH, PIPELINE_FILTERS, PIPELINE_LABEL, SORTS,
  SOURCE_LABEL, acceptsResponse, cachedPayload, createBusinessState, datasetForPath, defaultQuery,
  displayedFreshness, echoesQuery, emptyCopy, expireSession, filterChips, freshnessSignature, hasActiveFilters,
  isSessionExpiry, listPhase, listRequestUrl, ownerPresentation, pageSummary, panelModality, panelTabTarget,
  parseViewState, partyKindText, recordRequestUrl, recordSections, recordedCode, recordedValue, refusalCopy,
  rememberPayload, restoreSession, rowTone, sameQuery, scrollIntent, searchBoxValue, sourceIsFresh,
  validListPayload, validRecordPayload, viewHref,
} from "./workspace-business-model.js";
import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountNotificationBadge } from "./shell.js";
import { activityCopy, activityRequest, activityState } from "./record-activity-model.js";
import { loadEvidence, renderEvidence } from "./correspondence.js";

const EXPIRY_TICK_MS = 5_000;
const SEARCH_DEBOUNCE_MS = 350;

const dom = {
  title: document.querySelector("#pageTitle"),
  intro: document.querySelector("#pageIntro"),
  viewer: document.querySelector("#viewerWorkspace"),
  healthOrb: document.querySelector("#healthOrb"),
  healthLabel: document.querySelector("#healthLabel"),
  observedAt: document.querySelector("#observedAt"),
  form: document.querySelector("#filterForm"),
  search: document.querySelector("#searchInput"),
  filterA: document.querySelector("#filterA"),
  filterB: document.querySelector("#filterB"),
  filterC: document.querySelector("#filterC"),
  filterALabel: document.querySelector("#filterALabel"),
  filterBLabel: document.querySelector("#filterBLabel"),
  filterCLabel: document.querySelector("#filterCLabel"),
  sort: document.querySelector("#sortSelect"),
  scopeSwitch: document.querySelector("#scopeSwitch"),
  scopeNote: document.querySelector("#scopeNote"),
  reset: document.querySelector("#resetFilters"),
  chips: document.querySelector("#chipBar"),
  notices: document.querySelector("#noticeRegion"),
  summary: document.querySelector("#resultSummary"),
  listRegion: document.querySelector("#listRegion"),
  list: document.querySelector("#recordList"),
  pager: document.querySelector("#pager"),
  source: document.querySelector("#listSource"),
  panel: document.querySelector("#recordPanel"),
  panelTitle: document.querySelector("#recordTitle"),
  panelEyebrow: document.querySelector("#recordEyebrow"),
  panelBody: document.querySelector("#recordBody"),
  panelClose: document.querySelector("#recordClose"),
  navClients: document.querySelector("#navClients"),
  navVendors: document.querySelector("#navVendors"),
};

// The phone bar is the only navigation a reader has under 767px, and on these two
// pages it marked nothing at all: no current tab in markup and none in script,
// while Home's bar has carried aria-current="page" since it shipped. These links
// have no ids, so they are addressed the way a reader addresses them — by where
// they go.
const phoneNavLinks = [...document.querySelectorAll(".mobile-nav a[href]")];

const scopeButtons = dom.scopeSwitch ? [...dom.scopeSwitch.querySelectorAll("[data-owner]")] : [];

// One place holds what this view believes. Every renderer reads it, and the
// session-state transitions live in the model so they can be tested without a
// browser.
const view = Object.assign(createBusinessState(), { freshnessKey: null, returnFocusId: null });
// V5-UX-B04: the open record's recent activity, verified against its ref (see
// js/record-activity-model.js). Its own sequence, so a slow answer for a record
// that has since been closed or replaced never paints.
view.activity = { id: null, sequence: 0, result: null };
view.evidence = { id: null, sequence: 0, result: null };
view.sessionGeneration = 0;
view.panelState = null;
view.trustOperation = null;
let searchTimer = null;
let dealroomClientPromise = null;
const initialBootMode = resolveDealroomBoot(window.location);

/**
 * The one dealroom client this page builds, for the MCP reads it makes (the
 * unread badge and a record's activity). The list and record reads above stay
 * plain REST against DATASET_ROUTE.
 */
function dealroomClient() {
  if (!dealroomClientPromise) {
    const bootMode = initialBootMode;
    dealroomClientPromise = bootMode.mode === "live" ? Promise.resolve(createLiveClient()) : createFixtureClient(bootMode.options);
  }
  return dealroomClientPromise;
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

function formatMoment(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "an unknown time";
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatDay(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toLocaleDateString([], { dateStyle: "medium", ...(/^\d{4}-\d{2}-\d{2}$/.test(value) ? {timeZone:'UTC'} : {}) });
}

const HEALTH_LABEL = {
  loading: "Checking…",
  refreshing: "Refreshing…",
  available: "Up to date",
  stale: "Updating…",
  unauthorized: "Signed out",
  unavailable: "Records unavailable",
};

function setHealth(state) {
  const orb = state === "stale" || state === "unauthorized" ? "unavailable" : state;
  if (dom.healthOrb) dom.healthOrb.className = `status-orb ${orb}`;
  if (dom.healthLabel) dom.healthLabel.textContent = HEALTH_LABEL[state] || HEALTH_LABEL.unavailable;
}

/** Where it came from and when, without naming a table. */
function sourceLabel(source) { return updatedLabel(source?.observed_at); }

// ------------------------------------------------------------- navigation

function currentHref() {
  return `${window.location.pathname}${window.location.search}`;
}

/**
 * Record where the reader is before leaving this history entry, so coming Back
 * to it puts them at the same row rather than at the top of the list.
 */
function rememberScroll() {
  window.history.replaceState({ ...(window.history.state || {}), scrollY: Math.round(window.scrollY) }, "", currentHref());
}

/**
 * Opening, closing or swapping a record leaves the list underneath untouched,
 * so the reader's exact position is CARRIED INTO the new history entry and
 * restored after any focus move. Changing the list itself — a filter, a sort, a
 * page, the other dataset — is a new list and starts at the top.
 */
function navigate(href, { replace = false } = {}) {
  if (href === currentHref()) return;
  const scrollY = Math.round(window.scrollY);
  const nextScroll = scrollIntent(view.query, href) === "keep" ? scrollY : 0;
  if (replace) window.history.replaceState({ ...(window.history.state || {}), scrollY: nextScroll }, "", href);
  else {
    rememberScroll();
    window.history.pushState({ scrollY: nextScroll }, "", href);
  }
  applyLocation({ reason: "navigate", restoreScroll: nextScroll });
}

/** Focus that never scrolls; the scroll position is restored deliberately, once. */
function focusWithoutScrolling(element) {
  element?.focus?.({ preventScroll: true });
}

// ------------------------------------------------------------- the controls

const FILTER_FIELDS = {
  clients: [
    { select: "filterA", label: "filterALabel", key: "status", text: "Status", empty: "Any status", facet: "statuses" },
    { select: "filterB", label: "filterBLabel", key: "type", text: "Client type", empty: "Any client type", facet: "types" },
    { select: "filterC", label: "filterCLabel", key: "pipeline", text: "Pipeline", empty: null, facet: null },
  ],
  vendors: [
    { select: "filterA", label: "filterALabel", key: "category", text: "Category", empty: "Any category", facet: "categories" },
    { select: "filterB", label: "filterBLabel", key: "stage", text: "Stage", empty: "Any stage", facet: "stages" },
    { select: "filterC", label: "filterCLabel", key: "disposition", text: "Disposition", empty: "Any disposition", facet: "dispositions" },
  ],
};

function optionsHtml(options, emptyLabel, selected) {
  const head = emptyLabel === null ? "" : `<option value="">${escapeHtml(emptyLabel)}</option>`;
  return head + options.map((option) =>
    `<option value="${escapeHtml(option.slug)}"${option.slug === selected ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("");
}

/**
 * `syncSearch` is the difference between the two reasons this runs. A LOCATION
 * change (first load, a link, Back, forward) is authoritative about what the
 * search box should say, even while it holds focus, so Back cannot leave stale
 * text next to restored chips — and the pending keystroke timer is dropped so
 * the text it was about to submit cannot fire afterwards. An ordinary repaint
 * (a finished read, a refresh) is not authoritative and never touches a draft
 * the reader is still typing.
 */
function renderControls({ syncSearch = false } = {}) {
  const { dataset, query, facets } = view;
  if (dom.search) {
    const next = searchBoxValue({
      current: dom.search.value, query: query.q,
      editing: document.activeElement === dom.search, fromLocation: syncSearch,
    });
    if (next !== null) {
      // A pending keystroke would otherwise fire after the reconciliation and
      // navigate back to the text the reader just left behind.
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = null;
      dom.search.value = next;
    }
  }
  document.querySelector('#territoryField').hidden = dataset !== 'vendors';
  const territory = document.querySelector('#territoryInput');
  if (document.activeElement !== territory) territory.value = query.territory || '';
  document.querySelector('[data-vendor-sort]').hidden = dataset !== 'vendors';
  document.querySelector('#territories').innerHTML = (facets.territories || []).map(option => `<option value="${escapeHtml(option.slug)}"></option>`).join('');
  dom.sort.querySelector('[value="deal_type"]').textContent = dataset === 'vendors' ? 'Service' : 'Deal type';
  if (dom.sort) dom.sort.value = SORTS.includes(query.sort) ? query.sort : "name";
  for (const field of FILTER_FIELDS[dataset]) {
    const select = dom[field.select];
    const label = dom[field.label];
    if (!select || !label) continue;
    label.textContent = field.text;
    if (field.key === "pipeline") {
      select.innerHTML = PIPELINE_FILTERS.map((value) =>
        `<option value="${value}"${value === query.pipeline ? " selected" : ""}>${escapeHtml(PIPELINE_LABEL[value])}</option>`).join("");
      continue;
    }
    select.innerHTML = optionsHtml(facets[field.facet] || [], field.empty, query[field.key]);
    // A stored code that is not in the current list of options cannot be shown
    // as one, so the current choice stays visible instead of vanishing.
    if (query[field.key] && !select.value) {
      select.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(query[field.key])}" selected>${escapeHtml(query[field.key])} (code)</option>`);
      select.value = query[field.key];
    }
  }
  scopeButtons.forEach((button) => {
    const selected = button.dataset.owner === query.owner;
    button.setAttribute("aria-pressed", selected ? "true" : "false");
    button.classList.toggle("on", selected);
  });
  if (dom.scopeNote) {
    dom.scopeNote.textContent = query.scope === "mine"
      ? "Showing the ones recorded as yours. Team is the usual view."
      : "Showing everyone's. Switch to My work for the ones recorded as yours.";
  }
  markCurrentPage(dataset);
}

/**
 * The current page is ANNOUNCED and SHOWN, on both navigations.
 *
 * aria-current alone was announced and invisible: `.primary-nav a.active` is the
 * only rule in workspace.css that paints a current tab, and nothing ever added the
 * class, so /clients and /vendors highlighted no tab for anyone reading with their
 * eyes. Both marks are now set together, from the same one dataset, so they cannot
 * disagree about which page this is.
 *
 * The phone bar takes aria-current only, exactly matching Home's bar. There is no
 * `.mobile-nav a.active` rule in the stylesheet, and adding a class that paints
 * nothing would be a second silent mark of the kind this function exists to end.
 */
function markCurrentPage(dataset) {
  const current = DATASET_ROUTE[dataset] || null;
  for (const [link, route] of [[dom.navClients, DATASET_ROUTE.clients], [dom.navVendors, DATASET_ROUTE.vendors]]) {
    if (!link) continue;
    const here = route === current;
    link.setAttribute("aria-current", here ? "page" : "false");
    link.classList.toggle("active", here);
  }
  for (const link of phoneNavLinks) {
    if (link.getAttribute("href") === current) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function renderChips() {
  if (!dom.chips) return;
  const chips = filterChips(view.query, view.facets);
  if (!chips.length) {
    dom.chips.innerHTML = '';
    return;
  }
  dom.chips.innerHTML = `${chips.map((chip) =>
    `<button type="button" class="chip" data-chip="${escapeHtml(chip.key)}" data-chip-reset="${escapeHtml(chip.reset)}"><span class="chip-label">${escapeHtml(chip.label)}</span><span class="chip-value">${escapeHtml(chip.value)}</span><span class="chip-remove" aria-hidden="true">×</span><span class="visually-hidden">Remove this filter</span></button>`).join("")}<button type="button" class="chip chip-reset" data-chip="all">Clear all</button>`;
}

function renderNotices(notices) {
  if (!dom.notices) return;
  dom.notices.innerHTML = notices.map((notice) =>
    `<div class="notice notice-${escapeHtml(notice.kind)}"><p class="notice-title">${escapeHtml(notice.title)}</p><p class="notice-copy">${escapeHtml(notice.copy)}</p>${notice.retry ? '<button type="button" class="action secondary-action" data-retry="list" aria-label="Refresh" title="Refresh"><span aria-hidden="true">↻</span></button>' : ""}</div>`).join("");
}

// --------------------------------------------------------------- the list

const metric = value => Number.isInteger(value) ? String(value) : '—';
const winRate = stats => Number.isFinite(stats?.win_rate) ? `${Math.round(stats.win_rate * 100)}%` : '—';
const shortNote = value => typeof value === 'string' ? value.split(/\n/)[0].slice(0, 140) : '';
function tierHtml(stats) {
  const computed = stats?.computed_tier || 'Unrated';
  const tier = stats?.override?.tier || computed;
  return `<span class="trust-line"><span class="trust-tier" data-tier="${escapeHtml(tier)}">${escapeHtml(tier)}</span>${stats?.override ? `<span>Computed: ${escapeHtml(computed)}</span>` : ''}</span>`;
}
function relationshipHtml(record) {
  const stats = record.relationship || {};
  const intro = stats.introductions || [];
  const list = kind => {
    const items = intro.filter(item => kind === 'made' ? ['intro','intro_received','introduced'].includes(item.kind) : ['can_introduce','intro_requested'].includes(item.kind));
    return items.length ? `<ol class="network-list">${items.map(item => `<li>${escapeHtml(item.from_name)} → ${escapeHtml(item.to_name)}<p class="note-summary">${escapeHtml(shortNote(item.note))}</p>${item.occurred_at ? `<time>${escapeHtml(formatDay(item.occurred_at))}</time>` : ''}${kind === 'suggested' ? '<span class="observed">Suggested · not yet made</span>' : ''}${item.note ? `<details class="record-details" data-details-key="intro-${escapeHtml(item.id)}"><summary>Details</summary><p class="entry-detail">${escapeHtml(item.note)}</p></details>` : ''}</li>`).join('')}</ol>` : '<p class="observed">None recorded</p>';
  };
  return `<section class="record-section relationship-section" aria-label="Partnership">${tierHtml(stats)}${stats.override ? `<p class="note-summary">${escapeHtml(stats.override.recorded_by)} · ${escapeHtml(formatMoment(stats.override.recorded_at))} · ${escapeHtml(stats.override.reason)}</p>` : ''}<div class="relationship-metrics"><div class="relationship-metric"><strong>${metric(stats.deals_referred)}</strong><span>Deals referred</span></div><div class="relationship-metric"><strong>${metric(stats.deals_worked)}</strong><span>Deals worked</span></div><div class="relationship-metric"><strong>${winRate(stats)}</strong><span>Win rate${stats.win_rate != null ? ` · ${stats.won} won / ${stats.won + stats.lost} resolved` : ''}</span></div><div class="relationship-metric"><strong>${stats.last_contacted_at ? escapeHtml(formatMoment(stats.last_contacted_at)) : '—'}</strong><span>Last contacted</span></div></div><p class="note-summary">${escapeHtml(shortNote(stats.last_contact_note))}</p>${initialBootMode.mode === 'live' ? `<details class="trust-editor" data-details-key="trust"><summary>Trust rating</summary><form class="trust-form" id="trustForm"><label>Tier<select name="tier"><option value="">Use computed tier</option>${['Proven','Established','Trial'].map(tier => `<option${tier === stats.override?.tier ? ' selected' : ''}>${tier}</option>`).join('')}</select></label><label>Reason<input name="reason" maxlength="500" value="${escapeHtml(stats.override?.reason || '')}"></label><button class="action primary-action" type="submit"${view.pendingTrust ? ' disabled' : ''}>Save rating</button><p class="trust-status" role="status" id="trustStatus">${view.trustStatus?.id === record.id ? escapeHtml(view.trustStatus.text) : ''}</p></form></details>` : ''}</section><section class="record-section"><h3>Services & products</h3><p class="note-summary">${escapeHtml(shortNote(record.offers) || 'Not recorded')}</p>${record.offers ? `<details class="record-details" data-details-key="offers"><summary>Details</summary><p class="entry-detail">${escapeHtml(record.offers)}</p></details>` : ''}${record.loan_programs?.length ? `<h3>Loan programs</h3><ul>${record.loan_programs.map(program => `<li>${escapeHtml(program)}</li>`).join('')}</ul>` : ''}</section><section class="record-section"><h3>Networking</h3><div class="network-grid"><div><h4>Introductions made</h4>${list('made')}</div><div><h4>Suggested introductions</h4>${list('suggested')}</div></div></section>${stats.recent_entries?.length ? `<section class="record-section"><h3>Conversations</h3><ol class="network-list">${stats.recent_entries.map(entry => `<li><p class="note-summary">${escapeHtml(shortNote(entry.summary))}</p><time>${escapeHtml(formatMoment(entry.when))}</time>${entry.detail ? `<details class="record-details" data-details-key="entry-${escapeHtml(entry.id)}"><summary>Details</summary><p class="entry-detail">${escapeHtml(entry.detail)}</p></details>` : ''}</li>`).join('')}</ol></section>` : ''}`;
}
function capturePanelState() {
  const id = dom.panelBody.dataset.recordId;
  if (!id) return;
  const previous = view.panelState?.id === id ? view.panelState : { id, open: [] };
  const form = dom.panelBody.querySelector('#trustForm');
  // Error/loading markup cannot overwrite the last draft or disclosure state.
  if (!form && !dom.panelBody.querySelector('details')) return;
  const active = dom.panelBody.contains(document.activeElement) ? document.activeElement : null;
  view.panelState = {
    ...previous,
    open: [...dom.panelBody.querySelectorAll('details[open][data-details-key]')].map(el => el.dataset.detailsKey),
    ...(form ? { tier: form.elements.tier.value, reason: form.elements.reason.value } : {}),
    focus: active?.name ? { name: active.name } : active?.matches('summary') ? { disclosure: active.parentElement.dataset.detailsKey } : null,
    scroll: dom.panel.scrollTop,
  };
}
function restorePanelState() {
  const state = view.panelState;
  if (!state || state.id !== view.recordId) return;
  dom.panelBody.querySelectorAll('details[data-details-key]').forEach(el => { el.open = state.open.includes(el.dataset.detailsKey); });
  for (const name of ['tier','reason']) {
    const input = dom.panelBody.querySelector(`[name="${name}"]`);
    if (state[name] !== undefined && input) input.value = state[name];
  }
  const focus = state.focus?.name
    ? dom.panelBody.querySelector(`[name="${state.focus.name}"]`)
    : [...dom.panelBody.querySelectorAll('details[data-details-key]')].find(el => el.dataset.detailsKey === state.focus?.disclosure)?.querySelector('summary');
  focusWithoutScrolling(focus);
  dom.panel.scrollTop = state.scroll;
}
async function saveTrust(event) {
  if (event.target.id !== 'trustForm') return;
  event.preventDefault();
  const form = event.target, record = view.record.payload?.record;
  if (!record || view.pendingTrust || initialBootMode.mode !== 'live') return;
  const tier = form.elements.tier.value, reason = form.elements.reason.value.trim();
  if (tier && !reason) { form.elements.reason.setCustomValidity('Enter a reason'); form.elements.reason.reportValidity(); return; }
  form.elements.reason.setCustomValidity('');
  const operation = { vendor: record.ref, base_version: record.record_version, fields: { trust_override: tier ? { tier, reason } : null }, idempotency_key: crypto.randomUUID() };
  const generation = view.sessionGeneration;
  view.trustOperation = operation;
  const active = () => view.trustOperation === operation
    && view.sessionGeneration === generation && !view.signedOut;
  view.pendingTrust = operation;
  view.trustStatus = { id: record.id, text: 'Saving…' };
  form.querySelector('button').disabled = true;
  document.querySelector('#trustStatus').textContent = 'Saving…';
  try {
    const client = await dealroomClient();
    if (!active()) return;
    if (typeof client.updateVendorTrust !== 'function') {
      view.pendingTrust = null;
      view.trustStatus = { id: record.id, text: 'Rating unavailable' };
      renderRecordPanel();
      return;
    }
    let deadline;
    try { const receipt = await Promise.race([client.updateVendorTrust(operation), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Unconfirmed')), 15000); })]); if (receipt?.ok !== true || !Array.isArray(receipt.updated) || !receipt.updated.includes('trust_override')) throw new Error('Unconfirmed'); }
    finally { clearTimeout(deadline); }
    if (!active()) return;
    view.pendingTrust = null;
    view.trustStatus = { id: record.id, text: 'Rating saved' };
    renderRecordPanel();
    if (view.recordId === record.id) await loadRecord(record.id);
    if (active()) await loadList('background');
  } catch (error) {
    if (!active()) return;
    if (error.status === 401) return expireNow();
    const refused = ['offline','AUTHORIZATION_REFUSED','trust_override_invalid','version_conflict','key_reuse','not_a_vendor','no_updatable_fields'].includes(error.payload?.error);
    if (refused || error.status === 403) { view.pendingTrust = null; renderRecordPanel(); }
    // Reconcile the read before allowing any new write. Never replay a write
    // whose response was lost; it may have committed.
    if (view.recordId !== record.id) return;
    await loadRecord(record.id);
    if (!active() || view.recordId !== record.id) return;
    const saved = view.record.payload?.record.relationship?.override;
    const changed = view.record.payload?.record.record_version > operation.base_version;
    const matches = changed && (tier ? saved?.tier === tier && saved?.reason === reason && saved?.recorded_by === view.record.payload?.viewer : saved === null);
    if (matches) view.pendingTrust = null;
    view.trustStatus = { id: record.id, text: matches ? 'Rating confirmed' : 'Rating not confirmed' };
    renderRecordPanel();
  }
}

function rowFacts(dataset, row) {
  const facts = [];
  if (dataset === "clients") {
    const status = recordedCode(row.recorded_status, row.recorded_status_label);
    facts.push({ label: "Status", value: status.text, known: status.known, unresolved: status.known && !status.resolved });
    facts.push({ label: "Vertical", value: row.vertical || "Not recorded", known: Boolean(row.vertical) });
    facts.push({ label: "Deal type", value: row.deal_type || "Not recorded", known: Boolean(row.deal_type) });
    const type = recordedCode(row.recorded_client_type, row.recorded_client_type_label);
    facts.push({ label: "Client type", value: type.text, known: type.known, unresolved: type.known && !type.resolved });
  } else {
    const category = recordedCode(row.recorded_category, row.recorded_category_label);
    facts.push({ label: "Category", value: category.text, known: category.known, unresolved: category.known && !category.resolved });
    const stats = row.relationship;
    facts.push({ label: 'Territory', value: row.territory || 'Not recorded', known: Boolean(row.territory) });
    facts.push({ label: 'Referred', value: metric(stats?.deals_referred), known: stats?.deals_referred != null });
    facts.push({ label: 'Worked', value: metric(stats?.deals_worked), known: stats?.deals_worked != null });
    facts.push({ label: 'Win rate', value: winRate(stats), known: stats?.win_rate != null });
    facts.push({ label: 'Last contacted', value: stats?.last_contacted_at ? formatMoment(stats.last_contacted_at) : 'Not recorded', known: Boolean(stats?.last_contacted_at) });

  }
  const place = [row.city, row.state].filter(Boolean).join(", ");
  facts.push({ label: "Location", value: place || "Not recorded", known: Boolean(place) });
  return facts;
}

function rowHtml(dataset, row, selectedId) {
  const tone = rowTone(dataset, row);
  const owner = ownerPresentation(row);
  const ref = recordedValue(row.ref);
  const selected = row.id === selectedId;
  const facts = rowFacts(dataset, row).map((fact) =>
    `<span class="row-fact${fact.known ? "" : " unknown"}${fact.unresolved ? " unresolved" : ""}"><span class="fact-label">${escapeHtml(fact.label)}</span><span class="fact-value">${escapeHtml(fact.value)}</span></span>`).join("");
  return `<li class="record-item"><a class="record-row${selected ? " selected" : ""}" id="row-${escapeHtml(row.id)}" data-record-id="${escapeHtml(row.id)}" href="${escapeHtml(viewHref(view.query, row.id))}"${selected ? ' aria-current="true"' : ""}><span class="row-head"><span class="row-name">${escapeHtml(row.name)}</span><span class="row-ref${ref.known ? "" : " unknown"}">${escapeHtml(ref.text)}</span><span class="tone tone-${escapeHtml(tone.tone)}">${escapeHtml(tone.label)}</span></span><span class="row-facts">${facts}</span>${dataset === "vendors" ? tierHtml(row.relationship) + `<span class="contact-note">${escapeHtml(shortNote(row.relationship?.last_contact_note))}</span>` : ""}<span class="row-foot"><span class="row-owner${owner.known ? "" : " unknown"}">Owner: ${escapeHtml(owner.text)}${owner.ownedByViewer ? '<span class="row-you">Yours</span>' : ""}</span><span class="row-updated">Updated ${escapeHtml(formatMoment(row.updated_at))}</span></span></a></li>`;
}

function paintList(html, { busy = false } = {}) {
  const activeId = dom.list?.contains(document.activeElement) ? document.activeElement?.id : null;
  if (dom.list) dom.list.innerHTML = html;
  if (dom.listRegion) dom.listRegion.setAttribute("aria-busy", busy ? "true" : "false");
  if (!activeId) return;
  // A repaint must not drop the reader's keyboard place. The same row is
  // preferred; when that row is genuinely gone, the results summary takes focus
  // so the next Tab continues from the list rather than from the page top.
  focusWithoutScrolling(dom.list?.querySelector(`#${CSS.escape(activeId)}`) || dom.summary);
}

function renderEmpty(phase) {
  const copy = emptyCopy(view.dataset, phase);
  paintList(`<li class="record-empty"><p class="empty-title">${escapeHtml(copy.title)}</p><p class="empty-copy">${escapeHtml(copy.copy)}</p>${hasActiveFilters(view.query) ? '<button type="button" class="action secondary-action" data-chip="all">Clear all filters</button>' : ""}</li>`);
}

function renderPager(payload) {
  const sentinel = document.querySelector('#scrollSentinel');
  sentinel.hidden = view.loadedPageCount >= payload.page_count;
}

async function loadMore() {
  if (view.loadingMore || view.failedPage || view.list.status !== 'ready' || view.loadedPageCount >= view.list.payload?.page_count) return;
  const operation = {};
  view.loadingMore = operation;
  const epoch = view.list.sequence;
  const query = { ...view.query, page: view.loadedPageCount + 1 };
  renderList();
  try {
    const response = await fetchRead(listRequestUrl(query), { cache: 'no-store' });
    if (response.status === 401) return expireNow();
    const payload = response.ok ? await response.json() : null;
    if (epoch !== view.list.sequence) return;
    if (!validListPayload(payload, view.dataset) || !echoesQuery(payload, query) || payload.total !== view.list.payload.total) throw new Error('Page unavailable');
    const ids = new Set(view.loadedRows.map(row => row.id));
    if (payload.rows.some(row => ids.has(row.id))) throw new Error('Page overlap');
    view.loadedRows.push(...payload.rows);
    view.loadedPageCount++;
  } catch {
    if (epoch === view.list.sequence) view.failedPage = query.page;
  } finally {
    if (view.loadingMore === operation) {
      view.loadingMore = null;
      renderList();
    }
  }
}

function renderList() {
  const { dataset, list, query } = view;
  const phase = listPhase({ status: list.status, payload: list.payload, query, dataset, signedOut: view.signedOut });
  view.freshnessKey = list.payload ? freshnessSignature(list.payload, dataset) : null;

  if (phase === "loading") {
    setHealth("loading");
    if (dom.summary) dom.summary.textContent = "Checking…";
    if (dom.observedAt) dom.observedAt.textContent = "Checking…";
    if (dom.source) dom.source.textContent = "Checking…";
    if (dom.pager) dom.pager.hidden = true;
    renderNotices([]);
    paintList('<li class="record-skeleton"><span class="skeleton-line"></span><span class="skeleton-line short"></span></li>'.repeat(3), { busy: true });
    return;
  }

  if (phase === "unauthorized" || phase === "unavailable") {
    const signedOut = phase === "unauthorized";
    setHealth(signedOut ? "unauthorized" : "unavailable");
    if (dom.summary) dom.summary.textContent = signedOut ? "Signed out" : "Nothing loaded";
    if (dom.observedAt) dom.observedAt.textContent = signedOut ? "Session ended" : "Nothing loaded";
    if (dom.source) dom.source.textContent = signedOut ? "Signed out" : "Nothing loaded";
    if (dom.pager) dom.pager.hidden = true;
    renderNotices([]);
    paintList(`<li class="record-empty"><p class="empty-title">${signedOut ? "Your session has ended" : "This did not load"}</p><p class="empty-copy">${escapeHtml(refusalCopy(list.code || (signedOut ? "AUTHENTICATION_REQUIRED" : "INTERNAL_ERROR")))}</p>${signedOut
      ? `<a class="action primary-action" href="/auth/login?return_to=${encodeURIComponent(currentHref())}">Sign in</a>`
      : '<button type="button" class="action secondary-action" data-retry="list" aria-label="Refresh" title="Refresh"><span aria-hidden="true">↻</span></button>'}</li>`);
    return;
  }

  const payload = list.payload;
  const refreshing = phase === "refreshing";
  const stale = phase === "stale";
  setHealth(refreshing ? "refreshing" : stale ? "stale" : "available");
  if (dom.viewer) {
    dom.viewer.textContent = payload.viewer === "joe" ? "Joe’s workspace" : payload.viewer === "dell" ? "Dell’s workspace" : "Partner workspace";
  }
  if (dom.observedAt) dom.observedAt.textContent = updatedLabel(payload.source.observed_at);
  if (dom.source) dom.source.textContent = sourceLabel(payload.source, dataset);
  if (dom.summary) dom.summary.textContent = `${payload.total} ${DATASET_LABEL[dataset].toLowerCase()}`;
  renderNotices(view.failedPage ? [{ kind: 'unavailable', title: 'Could not load more', copy: 'Retrying automatically.', retry: true }]
    : view.loadingMore ? [{ kind: 'loading', title: 'Loading more…', copy: '' }] : []);

  if (payload.rows.length === 0) {
    renderEmpty(payload.out_of_range ? "out-of-range" : hasActiveFilters(query) ? "empty-no-matches" : "empty-no-records");
  } else {
    paintList((view.loadedRows || payload.rows).map((row) => rowHtml(dataset, row, view.recordId)).join(""));
  }
  renderPager(payload);
}

// ------------------------------------------------------------- the record
//
// The record opens in a modal dialog at every width. Keep keyboard focus inside
// and restore the launching row on close.

const FOCUSABLE = 'summary, a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function panelIsModal() { return Boolean(view.recordId); }

function backgroundRegions() { return [...document.querySelectorAll("[data-panel-background], #appShell")]; }

function applyPanelModality() {
  if (!dom.panel) return;
  const modal = panelIsModal();
  document.querySelector('#recordBackdrop').hidden = !modal;
  document.body.classList.toggle('record-open', modal);
  dom.panel.setAttribute("role", modal ? "dialog" : "complementary");
  if (modal) dom.panel.setAttribute("aria-modal", "true");
  else dom.panel.removeAttribute("aria-modal");
  for (const region of backgroundRegions()) {
    // `inert` is the real containment; aria-hidden keeps assistive technology
    // out of the covered content where inert is not supported yet.
    region.inert = modal;
    if (modal) region.setAttribute("aria-hidden", "true");
    else region.removeAttribute("aria-hidden");
  }
}

/**
 * Tab and Shift+Tab wrap inside the dialog instead of walking under it. The
 * heading the panel opens on is inside the dialog but is not a tab stop, so
 * panelTabTarget decides for every position — including that one — rather than
 * only for the two ends.
 */
function containPanelFocus(event) {
  if (event.key !== "Tab" || !panelIsModal() || !dom.panel) return;
  const stops = [...dom.panel.querySelectorAll(FOCUSABLE)].filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const active = document.activeElement;
  const target = panelTabTarget({
    inside: dom.panel.contains(active),
    stopIndex: stops.indexOf(active),
    stopCount: stops.length,
    shiftKey: event.shiftKey,
  });
  if (!target) return;
  event.preventDefault();
  if (target === "title") return focusWithoutScrolling(dom.panelTitle);
  focusWithoutScrolling(target === "first" ? stops[0] : stops[stops.length - 1]);
}

function renderRecordPanel() {
  if (!dom.panel) return;
  const { record, dataset } = view;
  if (!view.signedOut) capturePanelState();
  if (!view.recordId) {
    dom.panel.hidden = true;
    dom.panel.classList.remove("open");
    applyPanelModality();
    return;
  }
  dom.panel.hidden = false;
  dom.panel.classList.add("open");
  applyPanelModality();
  if (dom.panelEyebrow) dom.panelEyebrow.textContent = DATASET_SINGULAR[dataset];
  // A known sign-out empties the panel before anything else can render from it.
  if (view.signedOut) {
    if (dom.panelTitle) dom.panelTitle.textContent = "Your session has ended";
    if (dom.panelBody) {
      dom.panelBody.innerHTML = `<p class="attention-copy">${escapeHtml(refusalCopy("AUTHENTICATION_REQUIRED"))}</p><a class="action primary-action" href="/auth/login?return_to=${encodeURIComponent(currentHref())}">Sign in</a>`;
    }
    return;
  }
  if (record.status === "loading") {
    if (dom.panelTitle) dom.panelTitle.textContent = "Opening…";
    if (dom.panelBody) dom.panelBody.innerHTML = '<p class="attention-copy">Opening this record.</p><div class="skeleton-line"></div><div class="skeleton-line short"></div>';
    return;
  }
  if (record.status !== "ready" || !record.payload) {
    if (dom.panelTitle) dom.panelTitle.textContent = record.code === "RECORD_NOT_FOUND" ? "Not here" : "This did not load";
    if (dom.panelBody) dom.panelBody.innerHTML = `<p class="attention-copy">${escapeHtml(refusalCopy(record.code))}</p><button type="button" class="action secondary-action" data-retry="record" aria-label="Refresh" title="Refresh"><span aria-hidden="true">↻</span></button>`;
    return;
  }
  const payload = record.payload;
  const current = sourceIsFresh(payload.source, dataset);
  const tone = rowTone(dataset, payload.record);
  const owner = ownerPresentation(payload.record);
  const kind = partyKindText(payload.record.party_kind);
  if (dom.panelTitle) dom.panelTitle.textContent = payload.record.name;
  const sections = recordSections(dataset, payload.record).filter(section => !["About this record", "Status on the record", "What they offer and need", "Introduction notes", "Record", "Recorded state"].includes(section.title)).filter(section => section.fields.some(field => field.known && !['Vendor reference','Client reference','What they offer','Last touch'].includes(field.label))).map((section) =>
    `<section class="record-section"><h3>${escapeHtml(section.title)}</h3><dl>${section.fields.filter(field => !['ETL status','What this status means','Version','What this level means','Vendor reference','Client reference','What they offer','Last touch'].includes(field.label) && field.known).map((field) =>
      `<div class="record-field${field.known ? "" : " unknown"}${field.resolved ? "" : " unresolved"}"><dt>${escapeHtml(field.label)}</dt><dd>${(section.title === 'Notes' ? `<p class="note-summary">${escapeHtml(shortNote(field.text))}</p><details class="record-details" data-details-key="notes"><summary>Details</summary><p class="entry-detail">${escapeHtml(field.text)}</p></details>` : escapeHtml(field.text))}${field.known && !field.resolved ? '<span class="unresolved-flag">Not recorded</span>' : ""}</dd></div>`).join("")}</dl></section>`).join("");
  if (dom.panelBody) {
    dom.panelBody.innerHTML = `<p class="record-tone"><span class="tone tone-${escapeHtml(tone.tone)}">${escapeHtml(tone.label)}</span><span>${escapeHtml(owner.text)}</span></p>${dataset === 'vendors' ? relationshipHtml(payload.record) : ''}<div class="detail-columns">${sections}</div>${activityHtml(payload.record.id)}<p class="observed">${escapeHtml(sourceLabel(payload.source))}</p>`;
    dom.panelBody.dataset.recordId = payload.record.id;
    restorePanelState();

    // A staggered entrance, set through CSSOM: the Worker's CSP (src/worker.js)
    // refuses a `style` attribute written into markup, so the activity-row
    // template above only emits `data-stagger-ms`, and this reads it back.
    dom.panelBody.querySelectorAll(".activity-row").forEach((node) => {
      node.style.setProperty("--stagger", `${node.dataset.staggerMs}ms`);
    });
    const evidence = document.createElement('div');
    evidence.innerHTML = renderEvidence(view.evidence.id === payload.record.id ? view.evidence.result || { threads: { state: 'loading' } } : {});
    dom.panelBody.append(evidence);
  }
}

/** The record's recent activity, or the plain reason none is shown. */
function activityHtml(recordId) {
  const result = view.activity.id === recordId ? view.activity.result : null;
  const state = result || { state: "loading" };
  const body = state.state === "ready"
    ? `<ol class="activity-list">${state.rows.map((row, index) => `<li class="activity-row" data-kind="${escapeHtml(row.kind)}" data-stagger-ms="${Math.min(index * 30, 540)}"><span class="activity-dot" aria-hidden="true"></span><span class="activity-what">${escapeHtml(row.what)}${row.owed ? ` <b>· owed: ${escapeHtml(row.owed)}</b>` : ""}</span><span class="activity-when">${escapeHtml(row.when ? formatMoment(row.when) : "an unknown time")}${row.actor ? ` · ${escapeHtml(row.actor)}` : ""}</span></li>`).join("")}</ol>`
    : `<p class="record-note activity-note" data-state="${escapeHtml(state.state)}">${escapeHtml(activityCopy(state))}</p>`;
  return `<section class="record-section" id="recordActivity" aria-live="polite"><h3>Recent activity</h3>${body}<p class="record-note"></p></section>`;
}

/**
 * One activity read per opened record. The answer paints only while the same
 * record is still open and no newer read has started.
 */
async function loadActivity(id, record) {
  const sequence = ++view.activity.sequence;
  view.activity.id = id;
  view.activity.result = null;
  const request = activityRequest(record);
  const settle = (result) => {
    if (view.activity.sequence !== sequence || view.recordId !== id) return;
    view.activity.result = result;
    renderRecordPanel();
  };
  if (!request) return settle({ state: "no_ref" });
  try {
    const client = await dealroomClient();
    settle(activityState(record, await client.findAndCatchUp(request)));
  } catch {
    settle({ state: "unavailable" });
  }
}

// -------------------------------------------------------------- the reads

/**
 * The one place a known sign-out is handled. It throws away every answer this
 * view is holding — list, record, remembered answers and both in-flight
 * generations — and repaints as signed out.
 */
function expireNow() {
  view.sessionGeneration++;
  view.panelState = null;
  delete dom.panelBody.dataset.recordId;
  view.trustOperation = null;
  view.loadingMore = null; view.failedPage = null;
  view.loadedRows = []; view.loadedPageCount = 0;
  view.pendingTrust = null; view.trustStatus = null;
  Object.assign(view, expireSession(view));
  renderControls();
  renderChips();
  renderList();
  renderRecordPanel();
}

async function loadList(reason = "initial") {
  const query = { ...view.query, page: 1 };
  const targetPages = reason === 'background' ? Math.max(1, view.loadedPageCount || 1, view.failedPage || 1) : 1;
  view.loadingMore = null;
  if (reason !== 'background') view.failedPage = null;
  const key = listRequestUrl(query);
  const sequence = ++view.list.sequence;
  // Remembered answers are only for restoring a place, and only while the
  // session is known good; cachedPayload refuses to open once signed out.
  const cached = reason === "initial" || reason === "history" ? cachedPayload(view, key) : null;
  view.list.key = key;
  view.list.code = view.signedOut ? "AUTHENTICATION_REQUIRED" : null;
  if (cached && validListPayload(cached, view.dataset)) {
    view.loadedRows = [...cached.rows]; view.loadedPageCount = 1;
    view.list.payload = cached;
    view.list.status = "refreshing";
  } else if (reason === "background" && view.list.payload) {
    view.list.status = "refreshing";
  } else {
    view.loadedRows = []; view.loadedPageCount = 0;
    view.list.payload = null;
    view.list.status = view.signedOut ? "unauthorized" : "loading";
  }
  renderList();
  try {
    const response = await fetchRead(key, { headers: { accept: "application/json" }, cache: "no-store" });
    // THE SIGN-OUT IS HEARD EVEN WHEN THE ANSWER IS STALE. A superseded read is
    // not allowed to paint its DATA, but it still learned something true about
    // this session, and dropping that would leave records on screen that the
    // session can no longer fetch. The expiry check therefore runs BEFORE the
    // sequence guard; everything below it stays behind the guard.
    if (response.status === 401) return expireNow();
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      if (isSessionExpiry(response.status, failure.error)) return expireNow();
      if (!acceptsResponse(view.list.sequence, sequence)) return;
      return settleList({ status: "error", code: failure.error || "INTERNAL_ERROR" }, sequence);
    }
    const payload = await response.json().catch(() => null);
    if (!acceptsResponse(view.list.sequence, sequence)) return;
    // Shape AND echo are checked: an answer to a different filter is not an
    // answer to this one, however fresh it is.
    if (!validListPayload(payload, view.dataset) || !echoesQuery(payload, query)) {
      return settleList({ status: "error", code: "FRESHNESS_UNKNOWN" }, sequence);
    }
    const refreshedRows = [...payload.rows];
    for (let page = 2; page <= Math.min(targetPages, payload.page_count); page++) {
      const nextQuery = { ...query, page };
      const nextResponse = await fetchRead(listRequestUrl(nextQuery), { cache: 'no-store' });
      if (nextResponse.status === 401) return expireNow();
      const next = nextResponse.ok ? await nextResponse.json() : null;
      if (!acceptsResponse(view.list.sequence, sequence)) return;
      if (!validListPayload(next, view.dataset) || !echoesQuery(next, nextQuery) || next.total !== payload.total || next.rows.some(row => refreshedRows.some(old => old.id === row.id))) return settleList({ status: 'error', code: 'FRESHNESS_UNKNOWN' }, sequence);
      refreshedRows.push(...next.rows);
    }
    if (!acceptsResponse(view.list.sequence, sequence)) return;
    view.failedPage = null;
    view.loadedRows = refreshedRows;
    view.loadedPageCount = Math.min(targetPages, payload.page_count);
    settleList({ status: "ready", payload }, sequence);
  } catch {
    if (!acceptsResponse(view.list.sequence, sequence)) return;
    settleList({ status: "error", code: "DEPENDENCY_UNAVAILABLE" }, sequence);
  }
}

function settleList({ status, payload = null, code = null }, sequence) {
  if (!acceptsResponse(view.list.sequence, sequence)) return;
  // A verified answer is the only thing that proves the session is back.
  if (status === "ready") Object.assign(view, restoreSession(view));
  view.list.status = status;
  view.list.code = code;
  // A refused or failed read never keeps an older answer alive as if current.
  view.list.payload = status === "ready" ? payload : null;
  if (status === "ready") {
    if (payload?.facets) view.facets = payload.facets;
    rememberPayload(view, view.list.key, payload);
  }
  renderControls();
  renderChips();
  renderList();
}

async function loadRecord(id, { focusOnOpen = false } = {}) {
  if (view.recordId !== id) return;
  const pending = view.pendingTrust;
  const evidenceSequence = ++view.evidence.sequence;
  view.evidence.id = id;
  view.evidence.result = null;
  const sequence = ++view.record.sequence;
  view.record.id = id;
  if (view.record.payload?.record?.id !== id) { view.record.status = "loading"; view.record.payload = null; }
  view.record.code = null;
  renderRecordPanel();
  if (focusOnOpen) focusWithoutScrolling(dom.panelTitle);
  const settle = (status, code, payload = null) => {
    if (!acceptsResponse(view.record.sequence, sequence) || view.recordId !== id) return;
    view.record.status = status;
    view.record.code = code;
    view.record.payload = payload;
    renderRecordPanel();
  };
  try {
    const response = await fetchRead(recordRequestUrl(view.dataset, id), { headers: { accept: "application/json" }, cache: "no-store" });
    // A record read is as authoritative about the session as a list read, and
    // it stays authoritative after the panel closes or another record is
    // opened. The expiry check runs before the selection and sequence guards
    // for exactly that reason; the DATA below it still cannot paint.
    if (response.status === 401) return expireNow();
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      if (isSessionExpiry(response.status, failure.error)) return expireNow();
      return settle("error", failure.error || "INTERNAL_ERROR");
    }
    if (!acceptsResponse(view.record.sequence, sequence) || view.recordId !== id) return;
    const payload = await response.json().catch(() => null);
    if (!validRecordPayload(payload, view.dataset, id)) return settle("error", "FRESHNESS_UNKNOWN");
    if (pending && view.pendingTrust === pending && view.trustOperation === pending && pending.vendor === payload.record.ref) {
      const expected = pending.fields.trust_override, saved = payload.record.relationship?.override;
      if (payload.record.record_version > pending.base_version && (expected ? saved?.tier === expected.tier && saved?.reason === expected.reason && saved?.recorded_by === payload.viewer : saved === null)) { view.pendingTrust = null; view.trustStatus = { id: payload.record.id, text: 'Rating confirmed' }; }
    }
    settle("ready", null, payload);
    // The party record read supplies no deal activity/native thread index. This
    // section reads installation readiness and states unavailable explicitly.
    // Repainting recent activity must not restart this read or lose its state.
    dealroomClient().then(client => loadEvidence(client)).then(result => {
      if (view.evidence.sequence !== evidenceSequence || view.recordId !== id || view.signedOut) return;
      view.evidence.result = result;
      renderRecordPanel();
    }).catch(() => {
      if (view.evidence.sequence !== evidenceSequence || view.recordId !== id || view.signedOut) return;
      view.evidence.result = {};
      renderRecordPanel();
    });
    if (acceptsResponse(view.record.sequence, sequence) && view.recordId === id) loadActivity(id, payload.record);
  } catch {
    settle("error", "DEPENDENCY_UNAVAILABLE");
  }
}

// ------------------------------------------------------------ orchestration

function applyLocation({ reason = "initial", restoreScroll = null } = {}) {
  const parsed = parseViewState(window.location.pathname, window.location.search);
  if (parsed) parsed.query.page = 1;
  if (!parsed) return;
  // THE ADDRESS AND THE VIEW SAY THE SAME THING. Anything unrecognised was
  // already dropped by the parser; rewriting the current entry to the canonical
  // form is what stops a bookmarked `?scope=everyone&owner=dell&page=0` from
  // living on in the address bar beside an empty chip bar. It rewrites within
  // the route it was already on and never invents a destination.
  const wantedHref = viewHref(parsed.query, parsed.recordId);
  if (wantedHref !== currentHref()) {
    window.history.replaceState({ ...(window.history.state || {}) }, "", wantedHref);
  }
  const datasetChanged = parsed.dataset !== view.dataset;
  const queryChanged = datasetChanged || !sameQuery(parsed.query, view.query);
  const recordChanged = parsed.recordId !== view.recordId;
  const hadRecord = Boolean(view.recordId);
  capturePanelState();
  if (recordChanged) { view.panelState = null; delete dom.panelBody.dataset.recordId; }
  view.dataset = parsed.dataset;
  view.query = parsed.query;
  view.recordId = parsed.recordId;
  document.title = `${DATASET_LABEL[parsed.dataset]} · DoctorCRE`;
  if (dom.title) dom.title.textContent = DATASET_LABEL[parsed.dataset];
  if (dom.intro) {
    dom.intro.textContent = "";
  }
  if (datasetChanged) {
    view.cache.clear();
    view.facets = {};
  }
  // A location change is authoritative about the search box; an ordinary
  // repaint is not (see renderControls).
  renderControls({ syncSearch: true });
  renderChips();

  // Opening or closing a record never re-reads the list, so the reader's place,
  // scroll and rows survive the panel.
  if (queryChanged) loadList(reason === "navigate" ? "navigate" : "history");
  else renderList();

  if (recordChanged) {
    if (parsed.recordId) {
      loadRecord(parsed.recordId, { focusOnOpen: !hadRecord });
    } else {
      view.record = { id: null, status: "idle", payload: null, code: null, sequence: view.record.sequence + 1 };
      renderRecordPanel();
      if (hadRecord) {
        // Focus returns to the row that opened the panel — the modal case needs
        // this most — and never drags the list somewhere else while doing it.
        const row = view.returnFocusId ? document.querySelector(`#${CSS.escape(view.returnFocusId)}`) : null;
        focusWithoutScrolling(row || dom.summary);
        view.returnFocusId = null;
      }
    }
  } else if (parsed.recordId) {
    renderRecordPanel();
  }
  // Last, so it corrects any scroll a focus move would otherwise have caused.
  if (typeof restoreScroll === "number") window.scrollTo({ top: restoreScroll, behavior: "auto" });
}

function updateQuery(changes, { replace = false } = {}) {
  const next = { ...view.query, ...changes };
  // Any narrowing returns to the first page; a page number carried over from
  // the previous filter would silently point at a different set of records.
  if (!("page" in changes)) next.page = 1;
  navigate(viewHref(next, view.recordId), { replace });
}

function closeRecord() {
  if (!view.recordId) return;
  // Close is deterministic: it rewrites the current entry as the list it came
  // from, so it always lands on the list and never reopens whichever record
  // happened to be behind this one. Back is the other way out, and it closes
  // the panel by returning to the entry that existed before it opened.
  navigate(viewHref(view.query), { replace: true });
}

// ------------------------------------------------------------------ events

function wireControls() {
  document.querySelector('#refreshList').addEventListener('click', () => loadList('background'));
  document.querySelector('#recordBackdrop').addEventListener('click', closeRecord);
  document.querySelector('#territoryInput').addEventListener('change', event => updateQuery({ territory: event.target.value.trim() }));
  dom.panelBody?.addEventListener('submit', saveTrust);
  dom.panelBody?.addEventListener('input', event => { if (event.target.name === 'reason') event.target.setCustomValidity(''); });
  const sentinel = document.querySelector('#scrollSentinel');
  if (typeof IntersectionObserver === 'function') new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) loadMore(); }, { rootMargin: '400px' }).observe(sentinel);
  window.addEventListener('scroll', () => { if (sentinel.getBoundingClientRect().top < window.innerHeight + 400) loadMore(); }, { passive: true });
  dom.form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (searchTimer) clearTimeout(searchTimer);
    updateQuery({ q: (dom.search?.value || "").trim().slice(0, MAX_QUERY_LENGTH) });
  });
  dom.search?.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const value = (dom.search?.value || "").trim().slice(0, MAX_QUERY_LENGTH);
      if (value === view.query.q) return;
      // The first character of a search earns its own history entry, so Back
      // clears the search; the keystrokes after it replace that entry.
      updateQuery({ q: value }, { replace: Boolean(view.query.q) && Boolean(value) });
    }, SEARCH_DEBOUNCE_MS);
  });
  dom.sort?.addEventListener("change", () => updateQuery({ sort: SORTS.includes(dom.sort.value) ? dom.sort.value : "name" }));
  for (const key of ["filterA", "filterB", "filterC"]) {
    dom[key]?.addEventListener("change", () => {
      const field = FILTER_FIELDS[view.dataset].find((candidate) => candidate.select === key);
      if (field) updateQuery({ [field.key]: dom[key].value });
    });
  }
  dom.reset?.addEventListener("click", () => navigate(viewHref(defaultQuery(view.dataset), view.recordId)));

  scopeButtons.forEach((button) => {
    button.addEventListener("click", () => updateQuery({ owner: button.dataset.owner, scope: "team" }));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = scopeButtons.indexOf(button);
      const next = event.key === "Home" ? 0 : event.key === "End" ? scopeButtons.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : scopeButtons.length - 1)) % scopeButtons.length;
      const target = scopeButtons[next];
      focusWithoutScrolling(target);
      if (target && target.dataset.owner !== view.query.owner) updateQuery({ owner: target.dataset.owner, scope: "team" });
    });
  });

  dom.chips?.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-chip]");
    if (!chip) return;
    if (chip.dataset.chip === "all") return navigate(viewHref(defaultQuery(view.dataset), view.recordId));
    updateQuery({ [chip.dataset.chip]: chip.dataset.chipReset ?? "" });
  });

  dom.list?.addEventListener("click", (event) => {
    if (event.target.closest("[data-chip='all']")) {
      event.preventDefault();
      return navigate(viewHref(defaultQuery(view.dataset), view.recordId));
    }
    if (event.target.closest("[data-retry='list']")) {
      event.preventDefault();
      return loadList("retry");
    }
    const row = event.target.closest("a[data-record-id]");
    // Modifier clicks and middle clicks stay ordinary link activations, so a
    // record can still be opened in a new tab from its own real address.
    if (!row || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    view.returnFocusId = row.id;
    navigate(row.getAttribute("href"));
  });

  dom.notices?.addEventListener("click", (event) => {
    if (event.target.closest("[data-retry='list']")) loadList("background");
  });

  dom.pager?.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigate(link.getAttribute("href"));
  });

  dom.panelClose?.addEventListener("click", () => closeRecord());
  dom.panelBody?.addEventListener("click", (event) => {
    if (event.target.closest("[data-retry='record']") && view.recordId) loadRecord(view.recordId);
  });

  document.addEventListener("keydown", (event) => {
    // Tab stays inside the record dialog.
    containPanelFocus(event);
    if (event.key !== "Escape" || !view.recordId) return;
    // Escape leaves the panel, never the page, and never the reader's place.
    event.preventDefault();
    closeRecord();
  });

  window.addEventListener("popstate", (event) => {
    applyLocation({ reason: "history", restoreScroll: Number.isFinite(event.state?.scrollY) ? event.state.scrollY : null });
  });
}

/**
 * A local clock that has passed the freshness window must stop presenting rows
 * as current. The tick repaints only on a real change of that state; it never
 * refetches on its own, so nothing reshuffles under a reader mid-sentence.
 */
function watchExpiry() {
  setInterval(() => {
    if (!view.list.payload || view.list.status === "loading") return;
    const signature = freshnessSignature(view.list.payload, view.dataset);
    if (signature === view.freshnessKey) return;
    view.freshnessKey = signature;
    renderList();
  }, EXPIRY_TICK_MS);
}

function start() {
  if (!dom.list) return;
  if (!datasetForPath(window.location.pathname)) {
    // The asset is only served at the two view routes; anything else is a stale
    // bookmark and is sent to the canonical one.
    window.location.replace(DATASET_ROUTE.clients);
    return;
  }
  if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
  wireControls();
  watchExpiry();
  mountAutoRefresh({ document, window: globalThis.window, refresh: async () => { await loadList("background"); if (view.recordId) await loadRecord(view.recordId); } });
  window.history.replaceState({ ...(window.history.state || {}), scrollY: 0 }, "", currentHref());
  applyLocation({ reason: "initial" });
  mountBadge();
}

/**
 * V5-UX-B12b: the unread badge next to Notifications in the More disclosure.
 * One read, no polling loop, and a failure or a zero hides it — see
 * mountNotificationBadge in shell.js. This page has no dealroom client of its
 * own (its reads above are plain REST against DATASET_ROUTE), so a small one
 * is built for this one call alone, the same way notifications.js does.
 */
async function mountBadge() {
  try {
    await mountNotificationBadge(await dealroomClient());
  } catch {
    // Fails quiet, same as mountNotificationBadge's own catch.
  }
}

start();
