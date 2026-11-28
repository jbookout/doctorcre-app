import { BUSINESS_TIME_ZONE } from './business-date.js';
import { partnerName, phoneLabel, withoutRecordCodes } from './visual-system.js';
import { mountLocalTicker } from './visibility-poll.mjs';
import { createPageBudget } from './read-budget.mjs';
import { compareInstants } from './change-receipts.mjs';
import { linkRecordNames } from './ui-record-links.generated.js';
import { RELATIONSHIP_SHAPES } from './ui-relationship-shapes.generated.js';
import { pageDocContext, selectDocRecord, setDocFilters } from './doc-context.js';
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
  DATASET_LABEL, DATASET_ROUTE, DATASET_SINGULAR, MAX_QUERY_LENGTH,
  SOURCE_LABEL, acceptsResponse, cachedPayload, clientNoteText, createBusinessState, datasetForPath, defaultQuery,
  displayedFreshness, echoesQuery, emptyCopy, expireSession, filterChips, freshnessSignature, hasActiveFilters,
  isSessionExpiry, listPhase, listRequestUrl, ownerPresentation, pageSummary, panelTabTarget,
  parseViewState, partyKindText, recordRequestUrl, recordSections, recordedCode, recordedValue, refusalCopy,
  ACCOUNTS_REQUEST_URL, CLIENT_STATUS_CHIPS, accountCountsUrl, accountsFrom, clientStatusWord, RELATIONSHIP_LEVELS, RELATIONSHIP_WORDS, clientPlace, defaultSort, placeCounts, holdsWholeList, relationshipCounts, rememberPayload, restoreSession, sameQuery, scrollIntent, searchBoxValue, showsTiles, sourceIsFresh,
  tilesFrom, tilesRequestUrl, validListPayload, validRecordPayload, vendorRelationship, viewHref,
} from "./workspace-business-model.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountNotificationBadge } from "./shell.js";
import { pageScroller } from "./touch-layout.js";
import { activityCopy, activityRequest, activityState } from "./record-activity-model.js";

const EXPIRY_TICK_MS = 5_000;
const SEARCH_DEBOUNCE_MS = 350;

const dom = {
  footer: document.querySelector("#pageFooter"),
  resultsTitle: document.querySelector("#resultsTitle"),
  intro: document.querySelector("#pageIntro"),
  healthOrb: document.querySelector("#healthOrb"),
  healthLabel: document.querySelector("#healthLabel"),
  observedAt: document.querySelector("#observedAt"),
  form: document.querySelector("#filterForm"),
  search: document.querySelector("#searchInput"),
  scopeSwitch: document.querySelector("#scopeSwitch"),
  scopeNote: document.querySelector("#scopeNote"),
  reset: document.querySelector("#resetFilters"),
  tableFilters: document.querySelector("#tableFilters"),
  chips: document.querySelector("#chipBar"),
  notices: document.querySelector("#noticeRegion"),
  summary: document.querySelector("#resultSummary"),
  listRegion: document.querySelector("#listRegion"),
  tiles: document.querySelector("#directoryTiles"),
  placeBack: document.querySelector("#placeBack"),
  accountsBack: document.querySelector("#accountsBack"),
  list: document.querySelector("#recordList"),
  pager: document.querySelector("#pager"),
  source: document.querySelector("#listSource"),
  panel: document.querySelector("#recordPanel"),
  panelTitle: document.querySelector("#recordTitle"),
  panelMeta: document.querySelector("#recordMeta"),
  panelRelationship: document.querySelector("#recordRelationship"),
  panelBack: document.querySelector("#recordBack"),
  panelActions: document.querySelector("#recordActions"),
  panelMore: document.querySelector("#recordMore"),
  panelStatus: document.querySelector("#recordStatus"),
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

const phoneWidth = window.matchMedia("(max-width: 767px)");
phoneWidth.addEventListener("change", event => {
  if (!event.matches) document.querySelector("#secondaryFilters").open = true;
  applyPanelModality();
});

const directoryViews = [...document.querySelectorAll("[data-directory-view]")];
function showDirectoryView(name) {
  document.body.dataset.directoryView = name;
  for (const button of directoryViews) button.setAttribute("aria-pressed", String(button.dataset.directoryView === name));
}

const scopeButtons = dom.scopeSwitch ? [...dom.scopeSwitch.querySelectorAll("[data-owner]")] : [];

// One place holds what this view believes. Every renderer reads it, and the
// session-state transitions live in the model so they can be tested without a
// browser.
const view = Object.assign(createBusinessState(), { freshnessKey: null, returnFocusId: null });
// V5-UX-B04: the open record's recent activity, verified against its ref (see
// js/record-activity-model.js). Its own sequence, so a slow answer for a record
// that has since been closed or replaced never paints.
view.activity = { id: null, sequence: 0, result: null };
view.sessionGeneration = 0;
view.tiles = { sequence: 0, key: null, status: "idle", payload: null };
// The national accounts with their locations counted for one owner chip.
view.accounts = { sequence: 0, key: null, status: "idle", list: null };
view.panelState = null;
// The open vendor's stored relationship, read beside the card for its ruling reason and the values a save names.
view.role = { id: null, value: null };
// A refused relationship save's message, which the card redraws after the save would otherwise clear.
view.saveNotice = { id: null, text: "" };
let vendorMeetings = null;
let vendorMeetingsHost = null;
let vendorMeetingsGeneration = 0;

function clearVendorMeetings() {
  vendorMeetingsGeneration++;
  vendorMeetings?.dispose();
  vendorMeetings = null;
  vendorMeetingsHost?.remove();
  vendorMeetingsHost = null;
}

// A card's diagram section (a client's Deals, a vendor's Relationships) keeps its own state, such as an opened view, across card repaints.
let cardSection = null;

const CARD_SECTIONS = {
  clients: {
    className: "client-deals-section",
    read: id => `/api/engine/clients/${encodeURIComponent(id)}/deals`,
    answer: body => Array.isArray(body?.deals) ? body.deals : null,
    mount: () => import("./ui-client-deals.generated.js").then(module => module.mountClientDeals),
    failed: "Couldn't load deals.",
    doors: () => dealPartySavesOn() ? vendorDoors : null,
  },
  vendors: {
    className: "vendor-relationships-section",
    read: id => `/api/engine/vendors/${encodeURIComponent(id)}/relationships`,
    answer: body => body?.counts ? body : null,
    mount: () => import("./ui-vendor-relationships.generated.js").then(module => module.mountVendorRelationships),
    failed: "Couldn't load relationships.",
  },
};

function clearCardSection() {
  cardSection?.handle?.dispose();
  cardSection?.stage.remove();
  cardSection = null;
}

async function readCardSection(kind, id, signal) {
  const response = await fetchRead(kind.read(id), { headers: { accept: "application/json" }, cache: "no-store", signal });
  if (response.status === 401) expireNow();
  if (!response.ok) throw new Error(`Card read answered ${response.status}`);
  const answer = kind.answer(await response.json());
  if (!answer) throw new Error("Card read answered an unexpected shape");
  return answer;
}

// The deal party doors behind a vendor box on a client's deal; party saves follow the Clients and Vendors switch.
const vendorDoors = {
  add: (deal, party, role) => saveDealParty(deal, "", party, role),
  remove: (deal, party, role) => saveDealParty(deal, "/remove", party, role),
  recordSource: saveIntroduction,
  removeIntroduction,
  findVendors: readVendorMatches,
  roles: readVendorRoles,
  vendorHref: id => viewHref(defaultQuery("vendors"), id),
  openVendor: id => navigate(viewHref(defaultQuery("vendors"), id)),
};

async function saveDealParty(deal, suffix, party_id, role) {
  const client = await dealroomClient();
  const path = `/api/engine/deals/${encodeURIComponent(deal)}/parties${suffix}`;
  return client.savePartnerRecordOnce(path, "party_id", { party_id, role });
}

async function removeIntroduction({ id, version }) {
  const client = await dealroomClient();
  return client.savePartnerRecordOnce(`/api/engine/introductions/${encodeURIComponent(id)}/remove`, "introduction_id", { version });
}

async function saveIntroduction({ deal, client, vendor, by, on, replaces, guarded }) {
  const session = await dealroomClient();
  if (by === "unrecorded") {
    const outcome = replaces ? await removeIntroduction(replaces) : { ok: true };
    return outcome.ok ? { ok: true, introduction: null } : outcome;
  }
  const args = {
    made_by: by === "client" ? "client" : "team",
    ...(by === "client" ? {} : { introduced_by: by }),
    introduced_party_id: client,
    vendor_id: vendor,
    deal_id: deal,
    introduced_on: on,
    ...(guarded && { unrecorded_only: true }),
    ...(replaces && { replaces: replaces.id, replace_version: replaces.version }),
  };
  if (!guarded && replaces) return { ok: false, problem: { error: "introduction_already_recorded" } };
  const result = await session.savePartnerRecordOnce("/api/engine/introductions", "introduction_id", args);
  if (!result.ok) return result;
  const { made_by, introduced_by, introduction_id, version, introduced_on, introduced_party_id } = result.data;
  const savedBy = made_by === "client" ? "client" : introduced_by;
  if (savedBy !== "client" && savedBy !== "joe" && savedBy !== "dell") return { ok: false, pending: true };
  return { ok: true, introduction: { id: introduction_id, by: savedBy, version, on: introduced_on, party: introduced_party_id } };
}

async function readVendorMatches(query, signal) {
  const response = await fetchRead(`/api/engine/vendors?${new URLSearchParams({ q: query })}`, { headers: { accept: "application/json" }, cache: "no-store", signal });
  if (response.status === 401) expireNow();
  if (!response.ok) throw new Error(`Vendor list read answered ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.rows)) throw new Error("Vendor list read answered no rows");
  return body.rows.map(({ id, name }) => ({ id, name }));
}

async function readVendorRoles(signal) {
  const response = await fetchRead("/api/engine/vendors/summary", { headers: { accept: "application/json" }, cache: "no-store", signal });
  if (response.status === 401) expireNow();
  if (!response.ok) throw new Error(`Vendor summary read answered ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.categories)) throw new Error("Vendor summary read answered no categories");
  return body.categories.map(({ slug, label }) => ({ role: slug, label }));
}

function cardSectionHost(dataset, record) {
  const kind = CARD_SECTIONS[dataset];
  const id = record.party_id ?? record.id;
  const key = `${dataset}:${id}`;
  const subject = { id, name: record.name, ...(dataset === "vendors" && { relationship: vendorRelationship(record).key }) };
  if (cardSection?.key === key) {
    cardSection.subject = subject;
    cardSection.handle?.update(subject);
    return cardSection.host;
  }
  clearCardSection();
  const section = { key, subject, host: document.createElement("section"), stage: document.createElement("div"), handle: null };
  cardSection = section;
  section.host.className = `record-section ${kind.className}`;
  section.stage.className = "client-deal-stage";
  dom.listRegion.closest(".result-column").append(section.stage);
  kind.mount().then(mount => {
    if (cardSection !== section) return;
    section.handle = mount(section.host, { subject: section.subject, stage: section.stage, doors: kind.doors?.(), load: signal => readCardSection(kind, id, signal) });
  }, () => { section.host.textContent = kind.failed; });
  return section.host;
}

async function syncVendorMeetings() {
  if (view.dataset !== 'vendors' || view.signedOut) { clearVendorMeetings(); return; }
  if (vendorMeetingsHost) return;
  const generation = ++vendorMeetingsGeneration;
  const host = document.createElement('div');
  vendorMeetingsHost = host;
  host.className = 'vendor-meetings-host';
  host.setAttribute('data-panel-background', '');
  dom.listRegion.closest(".business-body").after(host);
  try {
    const { mountVendorMeetings } = await import('./ui-vendor-meetings.generated.js');
    const { createMcpRequests } = await import('./mcp-requests.mjs');
    if (generation !== vendorMeetingsGeneration) return;
    const requestMeetings = createMcpRequests();
    vendorMeetings = mountVendorMeetings(host, {
      nameLabel: withoutRecordCodes,
      phoneLabel,
      timeLabel: formatMoment,
      load: async (query, signal) => {
        const result = await requestMeetings('read-vendor-meetings', { ...query, view: 'research' }, { signal, timeoutMs: 15000 });
        if (result.kind !== 'payload' || result.isError) throw new Error('Vendor meetings unavailable');
        return result.payload;
      },
      href: id => viewHref(view.query, id),
      open: (href, returnFocusId) => {
        view.returnFocusId = returnFocusId;
        const url = new URL(href, window.location.href);
        navigate(`${url.pathname}${url.search}`);
      },
    });
  } catch {
    if (generation === vendorMeetingsGeneration) host.textContent = 'People worth meeting is unavailable.';
  }
}

let searchTimer = null;
let dealroomClientPromise = null;
const initialBootMode = resolveDealroomBoot(window.location);
// Party saves land in the new database, so the controls follow the Clients and Vendors switch.
const partySavesOn = () => initialBootMode.mode === "live" && document.documentElement.hasAttribute("data-clients-vendors-from-engine");
// A deal's vendors are deal saves too, so they also need the deal-saves switch.
const dealPartySavesOn = () => partySavesOn() && document.documentElement.hasAttribute("data-deals-saves-from-engine");
let partyEditor = null;

/**
 * The one dealroom client this page builds, for the MCP reads it makes (the
 * unread badge and a record's activity). The list and record reads above stay
 * plain REST against DATASET_ROUTE. Both clients load on first use, so the list
 * never waits on them: the fixture client alone is the largest script here.
 */
function dealroomClient() {
  if (!dealroomClientPromise) {
    const bootMode = initialBootMode;
    dealroomClientPromise = bootMode.mode === "live"
      ? import("./live-client.js").then(({ createLiveClient }) => createLiveClient())
      : import("./fixture-client.js").then(({ createFixtureClient }) => createFixtureClient(bootMode.options));
  }
  return dealroomClientPromise;
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function formatMoment(value) {
  if (DATE_ONLY.test(value)) return formatDay(value);
  const date = new Date(value || NaN);
  if (Number.isNaN(date.valueOf())) return "an unknown time";
  return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE, hour12: true });
}

function formatDay(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toLocaleDateString("en-US", { dateStyle: "medium", timeZone: DATE_ONLY.test(value) ? "UTC" : BUSINESS_TIME_ZONE });
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


// ------------------------------------------------------------- navigation

function currentHref() {
  return `${window.location.pathname}${window.location.search}`;
}

/**
 * Record where the reader is before leaving this history entry, so coming Back
 * to it puts them at the same row rather than at the top of the list.
 */
function rememberScroll() {
  window.history.replaceState({ ...(window.history.state || {}), scrollY: Math.round(pageScroller().scrollTop) }, "", currentHref());
}

/**
 * Opening, closing or swapping a record leaves the list underneath untouched,
 * so the reader's exact position is CARRIED INTO the new history entry and
 * restored after any focus move. Changing the list itself — a filter, a sort, a
 * page, the other dataset — is a new list and starts at the top.
 */
function navigate(href, { replace = false } = {}) {
  if (href === currentHref()) return;
  const scrollY = Math.round(pageScroller().scrollTop);
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
  partyEditor?.setDataset(dataset);
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
  // Inside a category the title names it, so the place reads without a filter chip. Until its name arrives, it is never the slug.
  view.place = dataset === "clients" ? clientPlace(query, view.accounts.list)
    : query.no_category ? "No category" : query.category && (facets.categories || []).find((option) => option.slug === query.category)?.label;
  // The account tiles hold no list of their own, so Find searches every client.
  if (dom.search) {
    dom.search.placeholder = view.place && !query.accounts ? `Find in ${view.place}` : dataset === "clients" ? "Find a client" : "Find a vendor";
    dom.search.parentElement.style.setProperty("--hint-length", String(dom.search.placeholder.length));
  }
  dom.placeBack.hidden = !(view.place || query.category);
  dom.placeBack.textContent = DATASET_LABEL[dataset];
  dom.placeBack.href = viewHref({ ...defaultQuery(dataset), owner: query.owner });
  dom.accountsBack.hidden = !query.national_account;
  dom.accountsBack.href = viewHref({ ...defaultQuery(dataset), owner: query.owner, accounts: "true" });
  const trail = [DATASET_LABEL[dataset], ...(query.national_account ? ["National Accounts"] : []), ...(view.place ? [view.place] : [])];
  if (dom.resultsTitle) dom.resultsTitle.textContent = trail.join(" / ");
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
  // Clients apply each filter as it changes, so their one reset is a Clear that shows only when it would do something.
  if (dom.reset) {
    const clients = view.dataset === "clients";
    dom.reset.textContent = clients ? "Clear" : "Reset";
    dom.reset.hidden = clients && !hasActiveFilters(view.query);
  }
  if (!dom.chips) return;
  const chips = filterChips(view.query, view.facets);
  if (!chips.length) {
    dom.chips.innerHTML = '';
    return;
  }
  dom.chips.innerHTML = `${chips.map((chip) =>
    `<button type="button" class="chip" data-chip="${escapeHtml(chip.key)}"${chip.tile ? " data-tile-chip" : ""} data-chip-reset="${escapeHtml(chip.reset)}"><span class="chip-label">${escapeHtml(chip.label)}</span><span class="chip-value">${escapeHtml(chip.value)}</span><span class="chip-remove" aria-hidden="true">×</span><span class="visually-hidden">Remove this filter</span></button>`).join("")}<button type="button" class="chip chip-reset" data-chip="all">Clear all</button>`;
}

function renderNotices(notices) {
  if (!dom.notices) return;
  dom.notices.innerHTML = notices.map((notice) =>
    `<div class="notice notice-${escapeHtml(notice.kind)}"><p class="notice-title">${escapeHtml(notice.title)}</p><p class="notice-copy">${escapeHtml(notice.copy)}</p>${notice.retry ? '<button type="button" class="action secondary-action" data-retry="list" aria-label="Refresh" title="Refresh"><span aria-hidden="true">↻</span></button>' : ""}</div>`).join("");
}

// --------------------------------------------------------------- the list

const winRate = stats => Number.isFinite(stats?.win_rate) ? `${Math.round(stats.win_rate * 100)}%` : '—';
const vendorNote = value => withoutRecordCodes((value || '')
  .replace(/[ \t]*— recovered from [A-Z][a-z]{1,29}(?:[ '-][A-Z][a-z]{1,29}){0,1}'s CARR calendar history(?=\s*$|\n)/g, '')
  .replace(/[ \t]*— recovered from the calendar backfill(?=\s*$|\n)/gi, '')
  .replace(/(?:^|\n)\s*(?:[A-Za-z]{3,9} \d{1,2}, \d{4} from the historical CARR calendar read|Calendar event [A-Za-z]{3,9} \d{1,2}, \d{4})\s*(?=\n|$)/gi, '')
  .replace(/(?:^|\n)[ \t]*Backfilled [A-Za-z]{3,9} \d{1,2}, \d{4} from the CARR calendar in [A-Za-z]{3,9} \d{4}(?:,[ \t]*|(?=\s*$|\n))/gi, '')
  .replace(/\s*\(recovered from the (?:[A-Za-z]{3,9} \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2}) mailbox sweep\)/gi, '')
  .replace(/^Recovered from CARR calendar history$/i, '')
  );
const shortNote = value => typeof value === 'string' ? value.split(/\n/)[0].slice(0, 140) : '';
// A quiet vendor's last contact says how long it has been, in amber.
function vendorContactDate({ relationship, quiet, quiet_days }) {
  const contactedAt = relationship?.last_contacted_at;
  const date = contactedAt ? `<time datetime="${escapeHtml(contactedAt)}">${escapeHtml(formatDay(contactedAt))}</time>` : quiet ? "No contact yet" : "";
  // With no contact recorded, quiet_days counts from the copy-in, which no partner would read as time since contact.
  const days = contactedAt && quiet && Number.isInteger(quiet_days) ? ` · ${quiet_days} ${quiet_days === 1 ? "day" : "days"}` : "";
  return date ? `<span class="contact-note${quiet ? " quiet" : ""}"><span class="fact-label">Last contacted </span>${date}${days}</span>` : '';
}

const vendorField = (label, value) => value ? `<div class="record-field"><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>` : '';
function vendorContactsHtml(record) {
  const contacts = (record.people || []).map(({ company, contact, office }) => `
    <li>
      <h4>${escapeHtml(withoutRecordCodes(contact.name))}</h4>
      ${company ? `<p class="note-summary">${escapeHtml(withoutRecordCodes(company.name))}</p>` : ''}
      <dl>
        ${vendorField('Email', contact.email)}
        ${vendorField('Phone', contact.phone && phoneLabel(contact.phone))}
        ${vendorField('Mobile', contact.cell && phoneLabel(contact.cell))}
        ${vendorField('Office', office && `${office.street_address}, ${office.city}, ${office.state}`)}
      </dl>
      ${office ? `<p class="observed">${escapeHtml(office.source)} · ${escapeHtml(formatMoment(office.observed_at))}${office.expires_on ? ` · Expires ${escapeHtml(office.expires_on)}` : ''}</p>` : ''}
    </li>`).join('');
  if (!contacts) return "";
  return `<section class="record-section" aria-label="Vendor contacts">
    <h3>Contacts & offices</h3>
    <ul class="vendor-contacts">${contacts}</ul>
  </section>`;
}

function conversationsHtml(record) {
  const entries = record.relationship?.recent_entries || [];
  return entries.length ? `<section class="record-section"><h3>Conversations</h3><ol class="network-list">${[...entries].sort((a,b) => compareInstants(a.when,b.when)).map(entry => `<li>${vendorNote(entry.summary) ? `<p class="note-summary">${escapeHtml(shortNote(vendorNote(entry.summary)))}</p>` : ''}${entry.when ? `<time>${escapeHtml(formatMoment(entry.when))}</time>` : ''}${vendorNote(entry.detail) ? `<details class="record-details" data-details-key="entry-${escapeHtml(entry.id)}"><summary>Details</summary><p class="entry-detail">${escapeHtml(vendorNote(entry.detail))}</p></details>` : ''}</li>`).join('')}</ol></section>` : '';
}

function partnershipHtml(record) {
  const stats = record.relationship || {};
  const intro = stats.introductions || [];
  const list = kind => {
    const items = intro.filter(item => kind === 'made' ? ['intro','intro_received','introduced'].includes(item.kind) : ['can_introduce','intro_requested'].includes(item.kind)).sort((a,b) => compareInstants(a.occurred_at,b.occurred_at));
    return items.length ? `<ol class="network-list">${items.map(item => `<li>${escapeHtml(item.from_name)} → ${escapeHtml(item.to_name)}<p class="note-summary">${escapeHtml(shortNote(vendorNote(item.note)))}</p>${item.occurred_at ? `<time>${escapeHtml(formatDay(item.occurred_at))}</time>` : ''}${kind === 'suggested' ? '<span class="observed">Suggested · not yet made</span>' : ''}${item.note ? `<details class="record-details" data-details-key="intro-${escapeHtml(item.id)}"><summary>Details</summary><p class="entry-detail">${escapeHtml(vendorNote(item.note))}</p></details>` : ''}</li>`).join('')}</ol>` : '';
  };
  const metrics = [
    ['Deals referred', stats.deals_referred],
    ['Deals worked', stats.deals_worked],
    [stats.win_rate == null ? 'Win rate' : `Win rate · ${stats.won} won / ${stats.won + stats.lost} resolved`, stats.win_rate == null ? null : winRate(stats)],
    ['Last contacted', stats.last_contacted_at && formatMoment(stats.last_contacted_at)],
  ].filter(([, value]) => value != null && value !== 0);
  const contactNote = shortNote(vendorNote(stats.last_contact_note));
  return `${metrics.length || contactNote ? `<section class="record-section relationship-section" aria-labelledby="partnershipTitle">
    <h3 id="partnershipTitle">Partnership</h3>
    ${metrics.length ? `<div class="relationship-metrics">${metrics.map(([label, value]) => `<div class="relationship-metric"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join('')}</div>` : ''}
    ${contactNote ? `<p class="note-summary">${escapeHtml(contactNote)}</p>` : ''}</section>` : ''}${record.offers || record.loan_programs?.length ? `<section class="record-section"><h3>Services & products</h3>${record.offers ? `<p class="note-summary">${escapeHtml(shortNote(vendorNote(record.offers)))}</p>` : ""}${record.offers ? `<details class="record-details" data-details-key="offers"><summary>Details</summary><p class="entry-detail">${escapeHtml(vendorNote(record.offers))}</p></details>` : ''}${record.loan_programs?.length ? `<h3>Loan programs</h3><ul>${record.loan_programs.map(program => `<li>${escapeHtml(program)}</li>`).join('')}</ul>` : ''}</section>` : ''}${intro.length ? `<section class="record-section"><h3>Networking</h3><div class="network-grid"><div><h4>Introductions made</h4>${list('made')}</div><div><h4>Suggested introductions</h4>${list('suggested')}</div></div></section>` : ''}`;
}
function capturePanelState() {
  const id = dom.panelBody.dataset.recordId;
  if (!id) return;
  const previous = view.panelState?.id === id ? view.panelState : { id, open: [] };
  // Error/loading markup cannot overwrite the last disclosure state.
  if (!dom.panelBody.querySelector('details')) return;
  const active = dom.panelBody.contains(document.activeElement) ? document.activeElement : null;
  view.panelState = {
    ...previous,
    open: [...dom.panelBody.querySelectorAll('details[open][data-details-key]')].map(el => el.dataset.detailsKey),
    focus: active?.matches('summary') ? { disclosure: active.parentElement.dataset.detailsKey } : null,
    scroll: dom.panel.scrollTop,
  };
}
function restorePanelState() {
  const state = view.panelState;
  if (!state || state.id !== view.recordId) return;
  dom.panelBody.querySelectorAll('details[data-details-key]').forEach(el => { el.open = state.open.includes(el.dataset.detailsKey); });
  const focus = [...dom.panelBody.querySelectorAll('details[data-details-key]')].find(el => el.dataset.detailsKey === state.focus?.disclosure)?.querySelector('summary');
  focusWithoutScrolling(focus);
  dom.panel.scrollTop = state.scroll;
}
function rowFacts(dataset, row) {
  const facts = [];
  if (dataset === "clients") {
    // The tiles and chips name each state, so the column uses the same words.
    const status = clientStatusWord(row.recorded_status);
    facts.push({ label: "Status", value: status ?? "Not recorded", known: Boolean(status) });
    // Inside a practice type every row would repeat the tile's own name.
    if (!view.query.practice_type && !view.query.not_set) facts.push({ label: "Practice type", value: row.vertical || "Not recorded", known: Boolean(row.vertical) });
    // The deal's own link fills this column (see dealLinks), since a link cannot sit inside the row's.
    facts.push({ label: "Open deal", value: "", known: false });
    const type = recordedCode(row.recorded_client_type, row.recorded_client_type_label);
    facts.push({ label: "Client type", value: type.text, known: type.known, unresolved: type.known && !type.resolved });
  } else {
    facts.push({ label: "Relationship", value: vendorRelationship(row).word, known: "id" in row });
    // Inside a category the column would repeat the category's own name on every row.
    if (!view.query.category && !view.query.no_category) {
      const category = recordedCode(row.recorded_category, row.recorded_category_label);
      facts.push({ label: "Category", value: category.text, known: category.resolved });
    }
    facts.push({ label: 'Territory', value: row.territory || 'Not recorded', known: Boolean(row.territory) });
  }
  const place = [row.city, row.state].filter(Boolean).join(", ");
  facts.push({ label: dataset === "clients" ? "Territory" : "Location", value: place || "Not recorded", known: Boolean(place) });
  return facts;
}

const dealHref = id => `/deals?deal=${encodeURIComponent(id)}`;
const dealLinks = row => row.active_deals?.length
  ? `<div class="client-deals">${row.active_deals.map(deal =>
      `<a href="${dealHref(deal.id)}">${escapeHtml(deal.name)}</a>`).join("")}</div>`
  : "";
const relationshipShape = key => `<svg class="rel-shape" viewBox="0 0 12 12" aria-hidden="true">${RELATIONSHIP_SHAPES[key]}</svg>`;
const wantToMeetHtml = relationship => relationship.wantToMeet ? '<span class="want-tag">Want to meet</span>' : "";

// Slash-joined places such as "Mobile/Baldwin/Dothan" wrap after a slash, never mid-word.
const breakAfterSlashes = value => escapeHtml(value).replaceAll("/", "/<wbr>");

function rowHtml(dataset, row, selectedId) {
  const owner = ownerPresentation(row);
  const selected = row.id === selectedId;
  const vendor = dataset === "vendors";
  const relationship = vendor ? vendorRelationship(row) : null;
  const name = relationship
    ? `<span class="row-name" data-relationship="${relationship.key}">${relationshipShape(relationship.key)}${escapeHtml(withoutRecordCodes(row.name))}</span>${wantToMeetHtml(relationship)}`
    : `<span class="row-name">${escapeHtml(row.name)}</span>`;
  const facts = rowFacts(dataset, row).filter((fact) => fact.known).map((fact) =>
    `<span class="row-fact${fact.unresolved ? " unresolved" : ""}${fact.history ? " history" : ""}" data-fact="${escapeHtml(fact.label)}"><span class="fact-label">${escapeHtml(fact.label)}</span><span class="fact-value">${breakAfterSlashes(fact.value)}</span></span>`).join("");
  return `<li class="record-item"><a class="record-row${selected ? " selected" : ""}" id="row-${escapeHtml(row.id)}" data-record-id="${escapeHtml(row.id)}" href="${escapeHtml(viewHref(view.query, row.id))}"${selected ? ' aria-current="true"' : ""}><span class="row-head">${name}</span><span class="row-facts">${facts}</span>${vendor ? vendorContactDate(row) : ''}<span class="row-foot">${owner.known ? `<span class="row-owner"><span class="fact-label">Owner: </span>${escapeHtml(owner.text)}</span>` : ""}<span class="row-updated"><span class="fact-label">Updated </span>${escapeHtml(formatMoment(row.updated_at))}</span></span></a>${dataset === "clients" ? dealLinks(row) : ""}</li>`;
}

// The columns a heading click can sort, by the engine sort each one asks for.
const COLUMN_SORTS = {
  clients: { Name: "name", Status: "status", "Practice type": "vertical", Territory: "territory", Owner: "owner", Updated: "recent" },
  vendors: { Name: "name", Relationship: "relationship", Territory: "territory" },
};

function columnHeading(dataset, label) {
  const sort = COLUMN_SORTS[dataset][label];
  if (!sort) return escapeHtml(label);
  const on = view.query.sort === sort;
  return `<button type="button" class="column-sort${on ? " on" : ""}" data-column-sort="${sort}" aria-pressed="${on}">${escapeHtml(label)}</button>`;
}

// Names the row columns once on a computer, where rows drop their inline labels; deal history keeps its own labels.
function headHtml(dataset) {
  const facts = rowFacts(dataset, {}).filter((fact) => !fact.history).map((fact) =>
    `<span class="row-fact" data-fact="${escapeHtml(fact.label)}">${columnHeading(dataset, fact.label)}</span>`).join("");
  return `<li class="list-head"><span class="row-head">${columnHeading(dataset, "Name")}</span><span class="row-facts">${facts}</span>${dataset === "vendors" ? '<span class="contact-note">Last contacted</span>' : ""}<span class="row-foot"><span class="row-owner">${columnHeading(dataset, "Owner")}</span><span class="row-updated">${columnHeading(dataset, "Updated")}</span></span></li>`;
}

// Inside one category the counts are the colors' key and a filter; Quiet asks the engine for quiet vendors only.
function vendorFiltersHtml(payload) {
  const { relationship, quiet, category, no_category: noCategory } = view.query;
  const inCategory = Boolean(category || noCategory) && holdsWholeList(payload);
  const counts = inCategory ? relationshipCounts(payload.rows) : null;
  const quietCount = counts ? ` <span class="tile-n">${payload.rows.filter((row) => row.quiet).length}</span>` : "";
  const words = counts ? Object.entries(RELATIONSHIP_WORDS).filter(([key]) => counts[key] > 0 || key === relationship).map(([key, word]) =>
    `<button type="button" class="filter-count" data-relationship="${key}" data-relationship-filter="${key}" aria-pressed="${key === relationship}">${relationshipShape(key)}${word} <span class="tile-n">${counts[key]}</span></button>`).join("") : "";
  return `${words}<button type="button" class="filter-count quiet-filter" data-quiet-filter aria-pressed="${quiet === "true"}">Quiet${quietCount}</button>`;
}

// Inside a Clients tile each chip asks the engine for one status and counts what the tile counted.
function clientFiltersHtml(counts) {
  const { status } = view.query;
  return CLIENT_STATUS_CHIPS.filter((chip) => counts[chip.count] > 0 || chip.status === status).map((chip) =>
    `<button type="button" class="filter-count" data-status-filter="${chip.status}" aria-pressed="${chip.status === status}">${chip.word} <span class="tile-n">${counts[chip.count]}</span></button>`).join("");
}

function renderTableFilters(payload) {
  const clients = view.dataset === "clients";
  dom.list.toggleAttribute("data-in-category", clients ? Boolean(view.query.practice_type || view.query.not_set) : Boolean(view.query.category || view.query.no_category));
  const counts = clients && payload && view.place ? placeCounts(clientTileCounts(), view.query, view.accounts.list) : null;
  dom.tableFilters.hidden = !payload || (clients && !counts);
  if (!dom.tableFilters.hidden) dom.tableFilters.innerHTML = clients ? clientFiltersHtml(counts) : vendorFiltersHtml(payload);
}

/** The opening tiles' counts for this owner, read once when a tile's list was opened from a link. */
function clientTileCounts() {
  const key = `clients:${view.query.owner}`;
  if (view.tiles.key === key && view.tiles.payload) return view.tiles.payload;
  if (view.tiles.key !== key || view.tiles.status === "idle") void loadPlaceCounts(key);
  return null;
}

async function loadPlaceCounts(key) {
  const sequence = ++view.tiles.sequence;
  Object.assign(view.tiles, { key, status: "loading", payload: null });
  let payload = null;
  try {
    const response = await fetchRead(tilesRequestUrl({ ...defaultQuery("clients"), owner: view.query.owner }), { headers: { accept: "application/json" }, cache: "no-store" });
    if (response.ok) payload = tilesFrom("clients", await response.json());
  } catch {
    payload = null;
  }
  if (sequence !== view.tiles.sequence) return;
  Object.assign(view.tiles, { status: payload ? "ready" : "error", payload });
  if (payload && view.list.payload && !showsTiles(view.query)) renderTableFilters(view.list.payload);
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
  const clear = view.dataset === "vendors" ? "Clear filters" : "Clear all filters";
  paintList(`<li class="record-empty"><p class="empty-title">${escapeHtml(emptyCopy(view.dataset, phase))}</p>${hasActiveFilters(view.query) ? `<button type="button" class="action secondary-action" data-chip="all">${clear}</button>` : ""}</li>`);
}

function renderPager(payload) {
  const sentinel = document.querySelector('#scrollSentinel');
  sentinel.hidden = view.loadedPageCount >= payload.page_count;
}

async function loadMore() {
  if (showsTiles(view.query) || view.loadingMore || view.failedPage || view.list.status !== 'ready' || view.loadedPageCount >= view.list.payload?.page_count) return;
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

// The place stays its own span so a phone can show it as the title while the count is read aloud only.
function paintSummary(status) {
  dom.summary.innerHTML = view.place ? `<span class="summary-place">${escapeHtml(view.place)}</span><span class="summary-count"> · ${escapeHtml(status)}</span>` : escapeHtml(status);
}

function renderList() {
  const { dataset, list, query } = view;
  const tiles = showsTiles(query) && !view.signedOut;
  document.body.toggleAttribute("data-tiles", tiles);
  dom.tiles.hidden = !tiles;
  dom.listRegion.hidden = tiles;
  if (tiles) { renderTableFilters(null); return renderTiles(); }
  const phase = listPhase({ status: list.status, payload: list.payload, query, dataset, signedOut: view.signedOut });
  view.freshnessKey = list.payload ? freshnessSignature(list.payload, dataset) : null;

  if (phase === "loading") {
    setHealth("loading");
    // A category opened from a link has no name yet, and the title stays empty rather than say "Checking…" or the slug.
    if (dom.summary) paintSummary(view.place || !view.query.category ? "Checking…" : "");
    if (dom.observedAt) dom.observedAt.textContent = "Checking…";
    if (dom.source) dom.source.textContent = "Checking…";
    if (dom.pager) dom.pager.hidden = true;
    renderNotices([]);
    paintList('<li class="record-skeleton"><span class="skeleton-line"></span><span class="skeleton-line short"></span></li>'.repeat(8), { busy: true });
    return;
  }

  if (phase === "unauthorized" || phase === "unavailable") {
    const signedOut = phase === "unauthorized";
    setHealth(signedOut ? "unauthorized" : "unavailable");
    if (dom.summary) dom.summary.textContent = signedOut ? "Signed out" : "Nothing loaded";
    // The result summary already says "Nothing loaded"; the toolbar stamp stays blank instead of repeating it.
    if (dom.observedAt) dom.observedAt.textContent = signedOut ? "Session ended" : "";
    if (dom.source) dom.source.textContent = signedOut ? "Signed out" : "Nothing loaded";
    if (dom.pager) dom.pager.hidden = true;
    renderNotices([]);
    paintList(`<li class="record-empty" role="alert"><p class="empty-title">${signedOut ? "Your session has ended" : "This did not load"}</p><p class="empty-copy">${escapeHtml(refusalCopy(list.code || (signedOut ? "AUTHENTICATION_REQUIRED" : "INTERNAL_ERROR")))}</p>${signedOut
      ? `<a class="action primary-action" href="/auth/login?return_to=${encodeURIComponent(currentHref())}">Sign in</a>`
      : '<button type="button" class="action secondary-action" data-retry="list" aria-label="Refresh" title="Refresh"><span aria-hidden="true">↻</span></button>'}</li>`);
    return;
  }

  const payload = list.payload;
  const refreshing = phase === "refreshing";
  const stale = phase === "stale";
  setHealth(refreshing ? "refreshing" : stale ? "stale" : "available");
  if (dom.observedAt) dom.observedAt.textContent = updatedLabel(payload.source.observed_at, BUSINESS_TIME_ZONE);
  if (dom.source) dom.source.textContent = updatedLabel(payload.source?.observed_at, BUSINESS_TIME_ZONE);
  const counted = `${payload.total} ${(payload.total === 1 ? DATASET_SINGULAR[dataset] : DATASET_LABEL[dataset]).toLowerCase()}`;
  if (dom.summary) paintSummary(counted);
  // eslint-disable-next-line no-restricted-syntax -- Business notice metadata only; 0 automatic attempts, and any retry requires a fresh user action.
  renderNotices(view.failedPage ? [{ kind: 'unavailable', title: 'Could not load more', copy: 'Retrying automatically.', retry: true }]
    : view.loadingMore ? [{ kind: 'loading', title: 'Loading more…', copy: '' }] : []);

  renderTableFilters(payload);
  const rows = (view.loadedRows || payload.rows).filter((row) =>
    !query.relationship || !holdsWholeList(payload) || vendorRelationship(row).key === query.relationship);
  if (rows.length === 0) {
    renderEmpty(payload.out_of_range ? "out-of-range" : hasActiveFilters(query) ? "empty-no-matches" : "empty-no-records");
  } else {
    paintList(headHtml(dataset) + rows.map((row) => rowHtml(dataset, row, view.recordId)).join(""));
  }
  renderPager(payload);
}

// -------------------------------------------------------------- the tiles

/** One tile: a name, its number, a few smaller counts and an optional footnote. Shared by Clients and Vendors. */
function tileHtml({ label, count, query, mix, foot = "" }) {
  return `<li><a class="directory-tile" href="${escapeHtml(viewHref(query))}"><span class="tile-head"><span class="tile-name">${escapeHtml(label)}</span><span class="tile-count">${count}</span></span><ul class="tile-mix">${mix.join("")}</ul>${foot}</a></li>`;
}

const mixItem = (n, word, { lead = "", attrs = "" } = {}) => n > 0 ? `<li${attrs}>${lead}<span class="tile-n">${n}</span> ${word}</li>` : "";
const TILE_SKELETON = '<li><span class="directory-tile"><span class="skeleton-line"></span><span class="skeleton-line short"></span></span></li>';

function vendorTiles(payload, base) {
  const tile = (label, counts, changes) => tileHtml({
    label, count: counts.count, query: { ...base, ...changes },
    mix: Object.entries(RELATIONSHIP_WORDS).map(([key, word]) => mixItem(counts.relationship[key], word, { lead: relationshipShape(key), attrs: ` data-relationship="${key}"` })),
    foot: counts.quiet ? `<span class="tile-foot tile-quiet">${counts.quiet} quiet</span>` : "",
  });
  // A vendor with two categories counts under both, so the tiles add up to more than All vendors.
  return [
    tile("All vendors", payload.all, { all: "true" }),
    ...payload.categories.filter((counts) => counts.count > 0).map((counts) => tile(counts.label, counts, { category: counts.slug })),
    ...(payload.no_category.count > 0 ? [tile("No category", payload.no_category, { no_category: "true" })] : []),
  ];
}

function clientTiles({ all, national_accounts: accounts, practice_types: types, not_set: notSet }, base) {
  const tile = (label, counts, changes, extra = {}) => tileHtml({
    label, count: counts.total, query: { ...base, ...changes },
    mix: [mixItem(counts.open_deal, "Open deal"), mixItem(counts.past_client, "Past client"), mixItem(counts.no_deal_yet, "No deal yet")],
    ...extra,
  });
  // Other waits for the practice type list that says which types are healthcare.
  return [
    tile("All clients", all, { all: "true" }),
    ...(accounts.total > 0 ? [tile("National Accounts", accounts, { accounts: "true" },
      { count: accounts.accounts, foot: `<span class="tile-foot">${accounts.total} ${accounts.total === 1 ? "location" : "locations"}</span>` })] : []),
    ...types.map((type) => tile(type.practice_type, type, { practice_type: type.practice_type })),
    ...(notSet.total > 0 ? [tile("Not set", notSet, { not_set: "true" })] : []),
  ];
}

// An account's tile counts the locations that match the owner chip, so an account with none has no tile.
function accountTiles(tiles, accounts, base) {
  const tile = (label, counts, changes, foot = "") => tileHtml({
    label, count: counts.total, query: { ...base, ...changes }, foot,
    mix: [mixItem(counts.open_deal, "Open deal"), mixItem(counts.past_client, "Past client"), mixItem(counts.no_deal_yet, "No deal yet")],
  });
  return [
    tile("All locations", tiles.national_accounts, { national_account: "any" }),
    ...accounts.filter((account) => account.counts.total > 0).map((account) => tile(account.name, account.counts, { national_account: account.id },
      account.owner ? `<span class="tile-foot">Owner ${escapeHtml(partnerName(account.owner))}</span>` : "")),
  ];
}

// A repaint keeps the reader's place: the same tile when it survives, else the results summary.
function paintTiles(html) {
  const focused = dom.tiles.contains(document.activeElement) ? document.activeElement : null;
  const href = focused?.getAttribute("href");
  dom.tiles.innerHTML = html;
  if (!focused) return;
  focusWithoutScrolling((href && [...dom.tiles.querySelectorAll("a.directory-tile")].find((tile) => tile.getAttribute("href") === href)) || dom.summary);
}

function renderTiles() {
  const accounts = Boolean(view.query.accounts);
  const status = accounts && view.tiles.payload ? view.accounts.status : view.tiles.status;
  const payload = accounts ? view.accounts.list && view.tiles.payload : view.tiles.payload;
  const vendors = view.dataset === "vendors";
  document.querySelector("#scrollSentinel").hidden = true;
  if (dom.pager) dom.pager.hidden = true;
  renderNotices([]);
  dom.tiles.setAttribute("aria-busy", String(status === "loading"));
  if (!payload) {
    const failed = status === "error";
    setHealth(failed ? "unavailable" : "loading");
    dom.summary.textContent = failed ? "Nothing loaded" : "Checking…";
    paintTiles(failed
      ? `<div class="record-empty" role="alert"><p class="empty-title">This did not load</p><p class="empty-copy">${escapeHtml(refusalCopy("DEPENDENCY_UNAVAILABLE"))}</p><button type="button" class="action secondary-action" data-retry="tiles" aria-label="Refresh" title="Refresh"><span aria-hidden="true">↻</span></button></div>`
      : `<ul class="directory-tile-grid">${TILE_SKELETON.repeat(vendors ? 12 : 8)}</ul>`);
    return;
  }
  setHealth(status === "refreshing" ? "refreshing" : "available");
  const base = { ...defaultQuery(view.dataset), owner: view.query.owner };
  if (accounts) {
    const count = payload.national_accounts.accounts;
    dom.summary.textContent = `National Accounts · ${count} ${count === 1 ? "account" : "accounts"}`;
    return paintTiles(`<ul class="directory-tile-grid">${accountTiles(payload, view.accounts.list, base).join("")}</ul>`);
  }
  const total = vendors ? payload.all.count : payload.all.total;
  dom.summary.textContent = `${total} ${(total === 1 ? DATASET_SINGULAR : DATASET_LABEL)[view.dataset].toLowerCase()}`;
  paintTiles(`<ul class="directory-tile-grid">${(vendors ? vendorTiles : clientTiles)(payload, base).join("")}</ul>`);
}

/** The deals board names each national account and its owner; each account's own read counts its locations. */
async function loadAccounts() {
  const { owner } = view.query;
  const sequence = ++view.accounts.sequence;
  if (view.accounts.key !== owner) view.accounts.list = null;
  Object.assign(view.accounts, { key: owner, status: view.accounts.list ? "refreshing" : "loading" });
  let list = null;
  try {
    const read = async (url) => {
      const response = await fetchRead(url, { headers: { accept: "application/json" }, cache: "no-store" });
      if (!response.ok) throw new Error("Accounts unavailable");
      return response.json();
    };
    const accounts = accountsFrom(await read(ACCOUNTS_REQUEST_URL));
    if (accounts) list = await Promise.all(accounts.map(async (account) => {
      const counts = tilesFrom("clients", await read(accountCountsUrl(owner, account.id)))?.national_accounts;
      if (!counts) throw new Error("Account counts unavailable");
      return { ...account, counts };
    }));
  } catch {
    list = null;
  }
  if (sequence !== view.accounts.sequence) return;
  Object.assign(view.accounts, { status: list ? "ready" : "error", list });
  renderControls();
  renderList();
}

async function loadTiles() {
  if (view.signedOut) return;
  const { dataset, query } = view;
  const key = `${dataset}:${query.owner}`;
  const sequence = ++view.tiles.sequence;
  // A list read still in flight must not paint over the tiles.
  view.list.sequence++;
  if (view.tiles.key !== key) view.tiles.payload = null;
  view.tiles.key = key;
  view.tiles.status = view.tiles.payload ? "refreshing" : "loading";
  renderList();
  let payload = null;
  let facets = null;
  try {
    const response = await fetchRead(tilesRequestUrl(query), { headers: { accept: "application/json" }, cache: "no-store" });
    if (response.status === 401) return expireNow();
    const body = await response.json().catch(() => null);
    if (!response.ok && isSessionExpiry(response.status, body?.error)) return expireNow();
    if (response.ok) payload = tilesFrom(dataset, body);
    if (payload && dataset === "clients") facets = body.facets;
  } catch {
    payload = null;
  }
  if (sequence !== view.tiles.sequence) return;
  view.tiles.payload = payload;
  view.tiles.status = payload ? "ready" : "error";
  // The new and edit forms list these choices; the tiles view never reads the list that usually carries them.
  if (facets) view.facets = facets;
  else if (payload && dataset === "vendors") view.facets = { ...view.facets, categories: payload.categories.map(({ slug, label }) => ({ slug, label })) };
  renderList();
}

// ------------------------------------------------------------- the record
//
// A record opens as a card beside the table, and only on a phone does the card
// cover the page as a dialog. The dialog keeps keyboard focus inside; closing
// either restores the launching row.

const FOCUSABLE = 'summary, a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function panelIsModal() { return Boolean(view.recordId) && phoneWidth.matches; }

function backgroundRegions() { return [...document.querySelectorAll("[data-panel-background], #appShell")]; }

function applyPanelModality() {
  if (!dom.panel) return;
  const modal = panelIsModal();
  document.body.toggleAttribute("data-card-open", Boolean(view.recordId) && !modal);
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

function clientNote({ notes, record_links }) {
  const note = clientNoteText(notes);
  if (!note) return "";
  return `<section class="record-section client-note"><h3>Notes</h3><p class="entry-detail">${linkRecordNames(note, record_links)}</p><details class="record-details" data-details-key="notes"><summary><span>More</span><span>Less</span></summary></details></section>`;
}

const COPY_LINK_DONE = "Link copied";
const COPY_LINK_FAILED = "Could not copy link. Copy the address from your browser.";

let copyLinkTimer = null;

// The drawer's own status line: visible with the menu closed and with the page behind the drawer inert.
function setPanelStatus(text) {
  if (copyLinkTimer !== null) clearTimeout(copyLinkTimer);
  copyLinkTimer = null;
  if (dom.panelStatus) dom.panelStatus.textContent = text;
}

function recordActionsHtml() {
  const copy = '<button type="button" class="action secondary-action" data-copy-record-link>Copy link</button>';
  const party = partyEditor?.actionsHtml() ?? "";
  const inner = party.replace(/^<div class="party-record-actions">/, "").replace(/<\/div>$/, "");
  return `<div class="party-record-actions">${inner}${copy}</div>`;
}

async function copyRecordLink() {
  const dataset = view.dataset;
  const recordId = view.recordId;
  if (!dataset || !recordId) return;
  setPanelStatus("");
  const url = `${location.origin}/${dataset}?record=${encodeURIComponent(recordId)}`;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    if (view.dataset === dataset && view.recordId === recordId) setPanelStatus(COPY_LINK_FAILED);
    return;
  }
  if (view.dataset !== dataset || view.recordId !== recordId) return;
  setPanelStatus(COPY_LINK_DONE);
  // eslint-disable-next-line no-restricted-syntax -- Single 2 s status, cleared on the next copy, record change or close.
  copyLinkTimer = setTimeout(() => setPanelStatus(""), 2000);
}

/** The header's status, owner, relationship and record actions; empty while nothing has loaded. */
function paintPanelHead(meta = "", actions = "", relationship = "") {
  setPanelStatus(view.saveNotice.id === view.recordId ? view.saveNotice.text : "");
  if (dom.panelMeta) dom.panelMeta.innerHTML = meta;
  if (dom.panelActions) dom.panelActions.innerHTML = actions;
  dom.panelRelationship.innerHTML = relationship;
  dom.panelRelationship.hidden = !relationship;
  dom.panelTitle?.removeAttribute("title");
  dom.panelTitle?.removeAttribute("data-relationship");
}

/** The record actions on a phone and the relationship choices open as menus; one closes once a choice is made. */
function closePanelMenu() {
  dom.panel?.querySelector(":popover-open")?.hidePopover();
}

const LEVEL_CHOICES = [...RELATIONSHIP_LEVELS.map((key, level) => [key, level]).reverse(), ["not_rated", null]];
const RULING_VERB = { parked: "Park", avoid: "Avoid" };

/**
 * The relationship as a button whose menu changes it. Its choices wait for the
 * stored relationship, which names what a save changes; without party saves the
 * relationship is a word, as it is on the row.
 */
function relationshipControlHtml(relationship) {
  const shown = `${relationshipShape(relationship.key)}${relationship.word}`;
  const read = view.role.id === view.recordId;
  const role = read ? view.role.value : null;
  if (!partyEditor || (read && !role)) return `<span class="rel-word" data-relationship="${relationship.key}">${shown}</span>${wantToMeetHtml(relationship)}`;
  const item = (attrs, label, current = false) => `<button type="button" class="rel-choice" ${attrs}${current ? ' aria-current="true"' : ""}>${label}</button>`;
  const choices = [
    ...LEVEL_CHOICES.map(([key, level]) => item(`data-rel-level="${level}" data-relationship="${key}"`, `${relationshipShape(key)}${RELATIONSHIP_WORDS[key]}`, key === relationship.key)),
    "<hr>",
    ...Object.entries(RULING_VERB).map(([ruling, verb]) => item(`data-rel-ruling="${ruling}" data-relationship="${ruling}"`, `${relationshipShape(ruling)}${verb}…`, ruling === relationship.key)),
    relationship.key === "avoid" ? "" : "<hr>" + item(`data-rel-target aria-pressed="${role?.is_target === true}"`, "Want to meet"),
  ].join("");
  const reason = role?.disposition && role.disposition_reason ? `<span class="rel-reason">${escapeHtml(role.disposition_reason)}</span>` : "";
  const ask = '<form class="rel-reason-form" hidden><label for="relReason"></label><textarea id="relReason" rows="3" required maxlength="500"></textarea><div class="rel-reason-actions"><button type="button" class="action secondary-action" data-rel-cancel>Cancel</button><button type="submit" class="action primary-action"></button></div></form>';
  return `<button type="button" class="rel-button" data-relationship="${relationship.key}" popovertarget="relationshipMenu"${role ? "" : " disabled"}>${shown}<span class="rel-caret" aria-hidden="true">▾</span><span class="visually-hidden">, change relationship</span></button>${wantToMeetHtml(relationship)}${reason}<div class="rel-menu" id="relationshipMenu" popover><div class="rel-choices">${choices}</div>${ask}</div>`;
}

/** Park and Avoid ask why before they save: the menu shows that one question until it next opens. */
function showRulingQuestion(ruling) {
  const menu = dom.panel.querySelector("#relationshipMenu");
  const form = menu.querySelector("form");
  menu.querySelector(".rel-choices").hidden = Boolean(ruling);
  form.hidden = !ruling;
  if (!ruling) return form.reset();
  form.dataset.relReason = ruling;
  form.querySelector("label").textContent = `Why ${RULING_VERB[ruling].toLowerCase()} ${withoutRecordCodes(view.record.payload?.record?.name ?? "")}?`;
  form.querySelector("[type=submit]").textContent = RULING_VERB[ruling];
  focusWithoutScrolling(form.querySelector("textarea"));
}

async function chooseRelationship(choice) {
  const role = view.role.id === view.recordId ? view.role.value : null;
  closePanelMenu();
  focusWithoutScrolling(dom.panelRelationship.querySelector(".rel-button"));
  if (!role || !partyEditor) return;
  view.saveNotice = { id: null, text: "" };
  setPanelStatus("Saving…");
  const problem = await partyEditor.setRelationship(role, choice);
  view.saveNotice = { id: view.recordId, text: problem ?? "" };
  setPanelStatus(view.saveNotice.text);
}

async function loadRole(id) {
  if (!partyEditor || view.dataset !== "vendors") return;
  const value = await partyEditor.vendorRole();
  if (view.recordId !== id) return;
  view.role = { id, value };
  renderRecordPanel();
}

function renderRecordPanel() {
  if (!dom.panel) return;
  const { record, dataset } = view;
  if (!view.signedOut) capturePanelState();
  if (!view.recordId) {
    clearCardSection();
    closePanelMenu();
    dom.panelTitle?.classList.remove("full");
    dom.panel.hidden = true;
    dom.panel.classList.remove("open");
    applyPanelModality();
    return;
  }
  dom.panel.hidden = false;
  dom.panel.classList.add("open");
  applyPanelModality();
  dom.panelBack.textContent = view.place || DATASET_LABEL[dataset];
  dom.panelBack.href = viewHref(view.query);
  // A redraw keeps focus on the record action that had it, such as Edit after a save.
  const actions = () => [...(dom.panelActions?.querySelectorAll("button") ?? [])];
  const action = actions().indexOf(document.activeElement);
  const relationshipFocused = dom.panelRelationship.contains(document.activeElement);
  paintPanelHead();
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
  const owner = ownerPresentation(payload.record);
  const kind = partyKindText(payload.record.party_kind);
  const vendor = dataset === "vendors";
  const relationship = vendor ? vendorRelationship(payload.record) : null;
  const category = vendor ? recordedCode(payload.record.recorded_category, payload.record.recorded_category_label) : null;
  // A person vendor's firm is the company their contact line names.
  const firm = vendor && payload.record.party_kind === "person" ? payload.record.people?.find((person) => person.company)?.company.name : null;
  paintPanelHead(`${firm ? `<span>${escapeHtml(withoutRecordCodes(firm))}</span>` : ""}${category?.resolved ? `<span>${escapeHtml(category.text)}</span>` : ""}${owner.known ? `<span class="row-fact"><span class="fact-label">Owner</span><span class="fact-value">${escapeHtml(owner.text)}</span></span>` : ""}`, recordActionsHtml(), relationship ? relationshipControlHtml(relationship) : "");
  if (action >= 0) focusWithoutScrolling(actions()[action]);
  if (relationshipFocused) focusWithoutScrolling(dom.panelRelationship.querySelector(".rel-button"));
  if (dom.panelTitle) dom.panelTitle.textContent = dom.panelTitle.title = vendor ? withoutRecordCodes(payload.record.name) : payload.record.name;
  if (relationship) dom.panelTitle.insertAdjacentHTML("afterbegin", relationshipShape(relationship.key));
  if (relationship && dom.panelTitle) dom.panelTitle.dataset.relationship = relationship.key;
  const ref = recordedValue(payload.record.ref);
  const referenceDetails = !vendor && ref.known
    ? `<details class="record-details" data-details-key="reference"><summary>Details</summary><dl><div class="record-field"><dt>Internal reference</dt><dd>${escapeHtml(ref.text)}</dd></div></dl></details>`
    : "";
  const hiddenFields = ['ETL status', 'What this status means', 'Version', 'Vendor reference', 'Client reference', 'What they offer', 'Last touch'];
  // A person vendor's only listed contact is themself, shown under Contacts & offices with their own phone and email.
  if (vendor && payload.record.party_kind === 'person' && payload.record.people?.length) hiddenFields.push('Phone', 'Mobile', 'Email');
  const sections = recordSections(dataset, payload.record)
    .filter(section => !["About this record", "Status on the record", "What they offer and need", "Introduction notes", "Record", "Recorded state"].includes(section.title))
    .map(section => {
      const fields = section.fields.filter(field => !hiddenFields.includes(field.label) && field.known && (!vendor || field.resolved));
      if (!fields.length) return "";
      return `<section class="record-section"><h3>${escapeHtml(section.title)}</h3><dl>${fields.map(field => {
        const value = vendor && ['Phone', 'Mobile'].includes(field.label) ? phoneLabel(field.text) : field.text;
        const mark = field.resolved ? "" : '<span class="unresolved-flag">Not recorded</span>';
        const note = section.title === 'Notes' && vendor ? vendorNote(value) : value;
        return `<div class="record-field${field.resolved ? "" : " unresolved"}"><dt>${escapeHtml(field.label)}</dt><dd>${section.title === 'Notes' ? `<p class="note-summary">${escapeHtml(shortNote(note))}</p><details class="record-details" data-details-key="notes"><summary>Details</summary><p class="entry-detail">${escapeHtml(note)}</p></details>` : escapeHtml(value)}${mark}</dd></div>`;
      }).join("")}</dl></section>`;
    }).join("");
  if (dom.panelBody) {
    // docs/screens/vendors.md orders the card: Relationships follows Conversations.
    dom.panelBody.innerHTML = `${dataset === 'vendors' ? vendorContactsHtml(payload.record) + conversationsHtml(payload.record) + '<section id="cardSectionSlot"></section>' + partnershipHtml(payload.record) : '<section id="cardSectionSlot"></section>'}<div class="detail-columns">${sections}</div>${dataset === "clients" ? clientNote(payload.record) : ""}${referenceDetails}${activityHtml(payload.record.id)}<p class="observed">${escapeHtml(updatedLabel(payload.source?.observed_at, BUSINESS_TIME_ZONE))}</p>`;
    dom.panelBody.dataset.recordId = payload.record.id;
    dom.panelBody.querySelector("#cardSectionSlot")?.replaceWith(cardSectionHost(dataset, payload.record));
    restorePanelState();
    const note = dom.panelBody.querySelector(".client-note > p");
    if (note) note.nextElementSibling.hidden = !note.nextElementSibling.open && note.scrollHeight <= note.clientHeight;
  }
}

function clientActivityList(rows) {
  return `<ol class="activity-list client-activity">${rows.map((row, index) => {
    const text = escapeHtml(row.what);
    const link = row.dealId ? `<a href="${dealHref(row.dealId)}">${text}</a>` : "";
    const disclosure = row.email
      ? `<details data-details-key="email-${escapeHtml(row.when)}-${index}"><summary>${link ? "Read email" : text}</summary><p class="entry-detail">${escapeHtml(row.email)}</p></details>`
      : "";
    const where = [row.stepOwner, row.filedOn].filter(Boolean).map(part => `· ${escapeHtml(part)}`).join(" ");
    const entry = (link + disclosure || text) + (where ? ` <span class="activity-filed">${where}</span>` : "");
    return `<li class="activity-row"><span class="activity-dot" aria-hidden="true"></span><div class="activity-what">${entry}</div>${row.when ? `<time class="activity-when">${escapeHtml(formatMoment(row.when))}${row.actor ? ` · ${escapeHtml(row.actor)}` : ""}</time>` : ""}</li>`;
  }).join("")}</ol>`;
}

function clientActivity(rows) {
  const rest = rows.slice(3);
  return clientActivityList(rows.slice(0, 3)) + (rest.length
    ? `<details class="record-details" data-details-key="more-activity"><summary><span>Show all</span><span>Show less</span></summary>${clientActivityList(rest)}</details>`
    : "");
}

/** The record's recent activity, or the plain reason none is shown. */
function activityHtml(recordId) {
  const result = view.activity.id === recordId ? view.activity.result : null;
  const state = result || { state: "loading" };
  const body = state.state === "ready"
    ? view.dataset === "clients" ? clientActivity(state.rows) : `<ol class="activity-list">${state.rows.map((row) => `<li class="activity-row" data-kind="${escapeHtml(row.kind)}"><span class="activity-dot" aria-hidden="true"></span><span class="activity-what">${escapeHtml(row.what)}${row.owed ? ` <b>· owed: ${escapeHtml(row.owed)}</b>` : ""}</span><span class="activity-when">${escapeHtml(row.when ? formatMoment(row.when) : "an unknown time")}${row.actor ? ` · ${escapeHtml(row.actor)}` : ""}</span></li>`).join("")}</ol>`
    : `<p class="record-note activity-note" data-state="${escapeHtml(state.state)}">${escapeHtml(activityCopy(state))}${view.dataset === "clients" && state.state === "unavailable" ? ` <button type="button" data-retry="activity">Retry</button>` : ""}</p>`;
  return `<section class="record-section" id="recordActivity" tabindex="-1" aria-labelledby="recordActivityTitle" aria-live="polite"><h3 id="recordActivityTitle">Recent activity</h3>${body}</section>`;
}

/** Arriving activity replaces only its own section, so the note a partner is reading or clicking stays put. */
function paintActivity(id) {
  const section = dom.panelBody?.querySelector("#recordActivity");
  if (!section) return;
  capturePanelState();
  section.outerHTML = activityHtml(id);
  restorePanelState();
}

/**
 * One activity read per opened record. The answer paints only while the same
 * record is still open and no newer read has started.
 */
async function loadActivity(id, record) {
  const sequence = ++view.activity.sequence;
  view.activity.id = id;
  view.activity.result = null;
  const dataset = view.dataset;
  const request = activityRequest(record, dataset);
  const docTicket=request ? pageDocContext?.begin('businessActivity',[{dataset:view.dataset,id}]) : null;
  const settle = (result) => {
    if (view.activity.sequence !== sequence || view.recordId !== id) return;
    const activityHadFocus = document.activeElement === dom.panelBody?.querySelector("#recordActivity");
    view.activity.result = result;
    if(['ready','empty'].includes(result.state))pageDocContext?.finish(docTicket,{record,activities:result.rows.map(({what, when}) => ({what, when}))});
    else if (docTicket)pageDocContext?.fail(docTicket);
    paintActivity(id);
    if (activityHadFocus) focusWithoutScrolling(dom.panelBody?.querySelector("[data-retry='activity']") || dom.panelBody?.querySelector("#recordActivity"));
  };
  if (!request) return settle({ state: "no_ref" });
  try {
    const client = await dealroomClient();
    settle(activityState(record, await client.findAndCatchUp(request), dataset));
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
  clearVendorMeetings();
  clearCardSection();
  pageDocContext?.clear();
  view.sessionGeneration++;
  view.panelState = null;
  delete dom.panelBody.dataset.recordId;
  view.loadingMore = null; view.failedPage = null;
  view.loadedRows = []; view.loadedPageCount = 0;
  view.tiles = { sequence: view.tiles.sequence + 1, key: null, status: "idle", payload: null };
  view.activity = { id: null, sequence: view.activity.sequence + 1, result: null };
  view.role = { id: null, value: null };
  Object.assign(view, expireSession(view));
  renderControls();
  renderChips();
  renderList();
  renderRecordPanel();
}

async function loadList(reason = "initial") {
  if (view.signedOut) return;
  const { accounts, national_account: account } = view.query;
  if (accounts || (account && account !== "any")) void loadAccounts();
  if (showsTiles(view.query)) return loadTiles();
  const query = { ...view.query, page: 1 };
  const targetPages = reason === 'background' ? Math.max(1, view.loadedPageCount || 1, view.failedPage || 1) : 1;
  view.loadingMore = null;
  if (reason !== 'background') view.failedPage = null;
  const key = listRequestUrl(query);
  const sequence = ++view.list.sequence;
  setDocFilters({ ...query });
  view.list.docTicket = pageDocContext?.begin('businessList', [{ dataset:view.dataset }]);
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
    const takePage = createPageBudget();
    // eslint-disable-next-line no-restricted-syntax -- Retained business pages call takePage before each read; a max of 100 additional pages per refresh.
    for (let page = 2; page <= Math.min(targetPages, payload.page_count); page++) {
      takePage();
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
  if (status === 'ready') pageDocContext?.finish(view.list.docTicket, payload); else pageDocContext?.fail(view.list.docTicket);
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
  if (view.signedOut || view.recordId !== id) return;
  const sequence = ++view.record.sequence;
  selectDocRecord(view.dataset, id);
  const docTicket = pageDocContext?.begin('businessRecord', [{ dataset:view.dataset, id }]);
  view.record.id = id;
  if (view.record.payload?.record?.id !== id) { view.record.status = "loading"; view.record.payload = null; }
  view.record.code = null;
  renderRecordPanel();
  if (focusOnOpen) focusWithoutScrolling(dom.panelTitle);
  const settle = (status, code, payload = null) => {
    if (!acceptsResponse(view.record.sequence, sequence) || view.recordId !== id) return;
    view.record.status = status;
    if (status === 'ready') pageDocContext?.finish(docTicket, payload); else pageDocContext?.fail(docTicket);
    view.record.code = code;
    view.record.payload = payload;
    renderRecordPanel();
  };
  try {
    const response = await fetchRead(recordRequestUrl(view.dataset, id, { people: view.dataset === 'vendors' }), { headers: { accept: "application/json" }, cache: "no-store" });
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
    if (!validRecordPayload(payload, view.dataset, id, { people: view.dataset === 'vendors' })) return settle("error", "FRESHNESS_UNKNOWN");
    settle("ready", null, payload);
    if (acceptsResponse(view.record.sequence, sequence) && view.recordId === id) {
      loadActivity(id, payload.record);
      void loadRole(id);
    }
  } catch {
    settle("error", "DEPENDENCY_UNAVAILABLE");
  }
}

// ------------------------------------------------------------ orchestration

function applyLocation({ reason = "initial", restoreScroll = null } = {}) {
  if (view.signedOut) return;
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
  if (parsed.dataset !== view.dataset) pageDocContext?.navigate(parsed.dataset);
  if (!parsed.recordId) selectDocRecord(null, null);
  const datasetChanged = parsed.dataset !== view.dataset;
  const queryChanged = datasetChanged || !sameQuery(parsed.query, view.query);
  const recordChanged = parsed.recordId !== view.recordId;
  const hadRecord = Boolean(view.recordId);
  capturePanelState();
  if (recordChanged) { view.panelState = null; delete dom.panelBody.dataset.recordId; clearCardSection(); }
  document.body.dataset.directory = parsed.dataset;
  if (reason === "initial" || datasetChanged) {
    document.querySelector("#secondaryFilters").open = !phoneWidth.matches;
  }
  view.dataset = parsed.dataset;
  view.query = parsed.query;
  view.recordId = parsed.recordId;
  if (datasetChanged) { clearVendorMeetings(); showDirectoryView("list"); }
  document.title = `${DATASET_LABEL[parsed.dataset]} · DoctorCRE`;
  if (dom.footer) dom.footer.textContent = `DoctorCRE · ${DATASET_LABEL[parsed.dataset]}`;
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
  if (queryChanged) void loadList(reason === "navigate" ? "navigate" : "history").then(syncVendorMeetings);
  else { renderList(); void syncVendorMeetings(); }

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
  // Last, so it corrects any scroll a focus move would otherwise have caused. Instant, because
  // "auto" follows the page's smooth scrolling and a new list would paint near the old bottom.
  if (typeof restoreScroll === "number") pageScroller().scrollTo({ top: restoreScroll, behavior: "instant" });
}

function updateQuery(changes, { replace = false } = {}) {
  const next = { ...view.query, ...changes };
  // Any narrowing returns to the first page; a page number carried over from
  // the previous filter would silently point at a different set of records.
  if (!("page" in changes)) next.page = 1;
  navigate(viewHref(next, view.recordId), { replace });
}

// Clearing filters keeps the place: All, a Clients tile, or a vendor category or No category.
function clearedQuery() {
  const { all, category, no_category, practice_type, not_set, national_account } = view.query;
  const place = view.dataset === "vendors" ? { category, no_category } : { practice_type, not_set, national_account };
  return { ...defaultQuery(view.dataset), all, ...place };
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
  dom.tableFilters.addEventListener("click", (event) => {
    const status = event.target.closest("[data-status-filter]")?.dataset.statusFilter;
    if (status) return updateQuery({ status: view.query.status === status ? "" : status });
    const word = event.target.closest("[data-relationship-filter]")?.dataset.relationshipFilter;
    if (word) return updateQuery({ relationship: view.query.relationship === word ? "" : word });
    if (event.target.closest("[data-quiet-filter]")) updateQuery({ quiet: view.query.quiet ? "" : "true" });
  });
  document.querySelector('#recordBackdrop').addEventListener('click', closeRecord);
  const sentinel = document.querySelector('#scrollSentinel');
  if (typeof IntersectionObserver === 'function') new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) loadMore(); }, { rootMargin: '400px' }).observe(sentinel);
  document.addEventListener('scroll', () => { if (sentinel.getBoundingClientRect().top < window.innerHeight + 400) loadMore(); }, { capture: true, passive: true });
  dom.form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (searchTimer) clearTimeout(searchTimer);
    updateQuery({ q: (dom.search?.value || "").trim().slice(0, MAX_QUERY_LENGTH) });
  });
  dom.search?.addEventListener("input", () => {
    if (searchTimer) clearTimeout(searchTimer);
    // eslint-disable-next-line no-restricted-syntax -- Search debounce keeps at most 1 pending callback, replacing it on each input; query length is capped by MAX_QUERY_LENGTH.
    searchTimer = setTimeout(() => {
      const value = (dom.search?.value || "").trim().slice(0, MAX_QUERY_LENGTH);
      if (value === view.query.q) return;
      // The first character of a search earns its own history entry, so Back
      // clears the search; the keystrokes after it replace that entry.
      updateQuery({ q: value }, { replace: Boolean(view.query.q) && Boolean(value) });
    }, SEARCH_DEBOUNCE_MS);
  });
  dom.reset?.addEventListener("click", () => navigate(viewHref(clearedQuery(), view.recordId)));
  directoryViews.forEach(button => button.addEventListener("click", () => {
    showDirectoryView(button.dataset.directoryView);
    if (button.dataset.directoryView === "list") navigate(viewHref({ ...defaultQuery("vendors"), owner: view.query.owner }));
  }));

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
    if (chip.classList.contains("chip-reset")) return navigate(viewHref(clearedQuery(), view.recordId));
    updateQuery({ [chip.dataset.chip]: chip.dataset.chipReset ?? "" });
  });

  dom.list?.addEventListener("click", (event) => {
    const column = event.target.closest("[data-column-sort]")?.dataset.columnSort;
    if (column) return updateQuery({ sort: view.query.sort === column ? defaultSort(view.dataset) : column });
    if (event.target.closest("[data-chip='all']")) {
      event.preventDefault();
      return navigate(viewHref(clearedQuery(), view.recordId));
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

  dom.tiles.addEventListener("click", (event) => {
    if (event.target.closest("[data-retry='tiles']")) return void loadList();
    const tile = event.target.closest("a.directory-tile");
    if (!tile || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(tile.getAttribute("href"));
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
  dom.panelBack.addEventListener("click", (event) => { event.preventDefault(); closeRecord(); });
  dom.panelRelationship.addEventListener("beforetoggle", (event) => { if (event.newState === "open") showRulingQuestion(null); }, true);
  dom.panelRelationship.addEventListener("click", (event) => {
    const level = event.target.closest("[data-rel-level]")?.dataset.relLevel;
    if (level !== undefined) return void chooseRelationship({ level: level === "null" ? null : Number(level) });
    const ruling = event.target.closest("[data-rel-ruling]")?.dataset.relRuling;
    if (ruling) return showRulingQuestion(ruling);
    if (event.target.closest("[data-rel-target]")) return void chooseRelationship({ wantToMeet: !view.role.value?.is_target });
    if (event.target.closest("[data-rel-cancel]")) closePanelMenu();
  });
  dom.panelRelationship.addEventListener("submit", (event) => {
    event.preventDefault();
    const reason = event.target.querySelector("textarea").value.trim();
    if (reason) void chooseRelationship({ ruling: event.target.dataset.relReason, reason });
  });
  // Every way the menu opens or closes ends here, so the button always says which.
  dom.panelActions?.addEventListener("toggle", (event) => {
    dom.panelMore?.setAttribute("aria-expanded", String(event.newState === "open"));
  });
  dom.panel?.addEventListener("click", (event) => {
    // A long name is cut to one line; a tap shows all of it.
    if (event.target.closest("#recordTitle")) dom.panelTitle.classList.toggle("full");
    if (event.target.closest("#recordActions button")) closePanelMenu();
    const copy = event.target.closest("[data-copy-record-link]");
    if (copy) return void copyRecordLink();
    const edit = event.target.closest("[data-party-edit]");
    if (edit) return partyEditor?.edit();
    if (event.target.closest("[data-party-link]")) return partyEditor?.link(view.record.payload?.record?.name ?? "");
    if (event.target.closest("[data-retry='record']") && view.recordId) loadRecord(view.recordId);
    if (event.target.closest("[data-retry='activity']") && !view.signedOut && view.recordId === view.record.payload?.record?.id) {
      loadActivity(view.recordId, view.record.payload.record);
      renderRecordPanel();
      focusWithoutScrolling(dom.panelBody.querySelector("#recordActivity"));
    }
  });

  document.addEventListener("keydown", (event) => {
    // Tab stays inside the record dialog.
    containPanelFocus(event);
    if (event.key !== "Escape" || !view.recordId) return;
    // Escape leaves the panel, never the page, and never the reader's place.
    event.preventDefault();
    // An open menu is the innermost layer: Escape closes only it.
    const menu = dom.panel?.querySelector(":popover-open");
    if (menu) {
      closePanelMenu();
      (menu === dom.panelActions ? dom.panelMore : dom.panelRelationship.querySelector(".rel-button"))?.focus();
      return;
    }
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
  return mountLocalTicker({ intervalMs: EXPIRY_TICK_MS, tick: () => {
    if (!view.list.payload || view.list.status === "loading") return;
    const signature = freshnessSignature(view.list.payload, view.dataset);
    if (signature === view.freshnessKey) return;
    view.freshnessKey = signature;
    renderList();
  } });
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
  if (partySavesOn()) import("./ui-party-editor.generated.js").then(({ mountPartyEditor }) => {
    partyEditor = mountPartyEditor({
      document, client: dealroomClient, dataset: () => view.dataset, facets: () => view.facets, phoneLabel,
      // A drawer opened by an old UUID answers that UUID as its id; party_id is the id the party saves take.
      recordParty: () => { const record = view.record.payload?.record; return record?.party_id ?? record?.id ?? null; },
      saved: (id, dataset) => {
        if (dataset !== view.dataset) return navigate(viewHref(defaultQuery(dataset), id));
        if (view.recordId === id) loadRecord(id);
        else navigate(viewHref(view.query, id));
        loadList("background");
      },
    });
    partyEditor.setDataset(view.dataset);
    if (view.recordId) { renderRecordPanel(); void loadRole(view.recordId); }
  });
  wireControls();
  const searchDock = document.querySelector('.search-dock');
  const searchDockObserver = new ResizeObserver(() => {
    document.documentElement.style.setProperty('--search-dock-height', `${searchDock.getBoundingClientRect().height}px`);
  });
  searchDockObserver.observe(searchDock, { box: "border-box" });
  const expiryTimer = watchExpiry();
  const autoRefresh = mountAutoRefresh({ document, window: globalThis.window, refresh: async () => { await loadList("background"); if (view.recordId) await loadRecord(view.recordId); } });
  window.addEventListener('doctorcre-session-invalidated', () => {
    searchDockObserver.disconnect();
    autoRefresh.dispose();
    expiryTimer.dispose();
    clearTimeout(searchTimer);
    expireNow();
  }, { once: true });
  window.history.replaceState({ ...(window.history.state || {}), scrollY: 0 }, "", currentHref());
  applyLocation({ reason: "initial" });
  // The unread badge is chrome, not content: it loads the dealroom client, so
  // it waits until the browser is idle after the first rows have painted.
  // eslint-disable-next-line no-restricted-syntax -- Schedules the unread badge once after initial paint, using requestIdleCallback with a 4-second timeout or a 1500ms fallback.
  if (window.requestIdleCallback) window.requestIdleCallback(() => mountBadge(), { timeout: 4000 });
  // eslint-disable-next-line no-restricted-syntax -- 1 unread-badge mount after a 1500ms fallback.
  else setTimeout(() => mountBadge(), 1500);
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
