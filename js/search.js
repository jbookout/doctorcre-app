// V5-UX-B05 — Authorized global search: DOM wiring only.
//
// Every decision this file paints is made in ./search-model.js. Nothing here
// sorts, ranks, counts, filters by authority, or writes a sentence of its own:
//
//   1. Each number rendered is a field of the ONE payload in hand. There is no
//      second read anywhere in the render path, and no total computed over
//      anything the verb did not return.
//   2. A ref is filtered to a non-empty string before it becomes a chip or a
//      link, because `organizations[].refs` aggregates a nullable column and a
//      null element was observed in two real payloads.
//   3. A response only paints if no newer read has been started since it left.
//      An older answer that overtakes a newer one renders NOTHING.
//   4. `?q=` and `?kinds=` are the address. Back restores both from the URL and
//      re-renders without a read of its own.
import {
  AUTHORIZATION_SENTENCE, EXPOSURE_STATEMENT, FIND_CATCH_UP_LIMIT_DEFAULT, NOT_SEARCHED_SENTENCE,
  SAVED_VIEW_SENTENCE, SCOPE_CHIP_SENTENCE, SEARCH_STATE_COPY,
  acceptsSearchResponse, applyScope, buildFindAndCatchUpArguments, buildFindArguments,
  classifySearchFailure, groupSearchResults, parseSearchAddress, queryIsSendable,
  readSavedViews, refusalDetail, renameView, resetViews, retiredSummary, saveView, scopeChips,
  searchAddress, searchPhase, truncationNotes, validCatchUpPayload, validSearchPayload,
  visibleCount, writeSavedViews,
} from "./search-model.js";

const IDLE_REREAD_MS = 300;

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

/** One place holds what the Search tab believes; nothing else keeps a copy. */
const view = {
  status: "idle", query: "", kinds: [], payload: null, catchUp: null,
  refusal: null, submitted: false, sequence: 0, views: [],
};

let client = null;
let storage = null;
let idleTimer = null;

/* -------------------------------------------------------------------- painting */

function factLine(facts) {
  // A null never reaches this: the model dropped it upstream, so the word
  // "null" cannot be printed even if the producer sends one.
  return facts.map((fact) => `<span>${escapeHtml(fact.label)}: ${escapeHtml(fact.value)}</span>`).join("");
}

function refChipHtml(refs, label) {
  if (refs.length === 0) return "";
  return `<span class="chip-label">${escapeHtml(label)}</span>${refs.map((ref) => `<code class="ref-chip">${escapeHtml(ref)}</code>`).join("")}`;
}

function rowHtml(row) {
  const open = row.link
    ? `<a class="btn" href="${escapeHtml(row.link)}">Open</a>`
    : `<p class="small quiet">${escapeHtml(row.note)}</p>`;
  const counts = row.counts
    ? row.counts.map((entry) => `<span>${escapeHtml(String(entry.value))} ${escapeHtml(entry.label)}</span>`).join("")
    : factLine(row.facts || []);
  const retiredRefs = row.retiredRefs ? refChipHtml(row.retiredRefs, "Retired") : "";
  const roleRefs = row.roleRefs ? refChipHtml(row.roleRefs, "As a role") : "";
  return `<li class="work-item search-row" data-kind="${escapeHtml(row.kind)}"${row.retired ? ' data-retired="true"' : ""}>
    <div>
      <h3>${escapeHtml(row.name ?? "unnamed record")}</h3>
      ${row.retired ? '<p class="small quiet">retired alias</p>' : ""}
      <div class="work-meta">${counts}</div>
      <div class="chip-list">${refChipHtml(row.refs, "Ref")}${roleRefs}${retiredRefs}</div>
      ${row.retiredRefsTruncated ? '<p class="small quiet">The record layer truncated this list of retired references.</p>' : ""}
      ${row.allRetired ? '<p class="small quiet">Every record behind this name is retired.</p>' : ""}
    </div>
    <div class="stack-end">${open}</div>
  </li>`;
}

function renderChips(groups) {
  const bar = $("searchChips");
  if (!bar) return;
  const chips = scopeChips(groups, view.kinds);
  bar.innerHTML = chips.map((chip) => `<button class="chip" type="button" data-chip="${escapeHtml(chip.id)}" aria-pressed="${chip.selected}">${escapeHtml(chip.label)} · ${escapeHtml(String(chip.count))}</button>`).join("");
}

function renderSavedViews() {
  const list = $("savedViewList");
  if (!list) return;
  list.innerHTML = view.views.map((saved) => `<span class="saved-view"><a class="chip" href="${escapeHtml(searchAddress(saved))}" data-view="${escapeHtml(saved.name)}">${escapeHtml(saved.name)}</a><button class="chip" type="button" data-rename="${escapeHtml(saved.name)}">Rename</button></span>`).join("");
}

function renderRefusal() {
  const block = $("searchRefusal");
  if (!block) return;
  const detail = view.refusal;
  if (!detail) { block.hidden = true; block.innerHTML = ""; return; }
  block.hidden = false;
  // The CODE is named. The body of the answer is never read and never printed.
  const parts = [`<h3>${escapeHtml(SEARCH_STATE_COPY.refused.title)}</h3>`, `<p class="small">Refusal code: <code>${escapeHtml(detail.code)}</code></p>`];
  if (detail.operation) parts.push(`<p class="small">Operation: <code>${escapeHtml(detail.operation)}</code></p>`);
  if (detail.fields.length > 0) parts.push(`<p class="small">Fields: ${detail.fields.map((field) => `<code>${escapeHtml(field)}</code>`).join(", ")}</p>`);
  if (detail.missing.length > 0) parts.push(`<p class="small">Missing: ${detail.missing.map((field) => `<code>${escapeHtml(field)}</code>`).join(", ")}</p>`);
  if (detail.hint) parts.push(`<p class="small">${escapeHtml(detail.hint)}</p>`);
  block.innerHTML = parts.join("");
}

function renderDisambiguation() {
  const block = $("searchCandidates");
  if (!block) return;
  const payload = view.catchUp;
  if (!payload || payload.state !== "needs_disambiguation") { block.hidden = true; block.innerHTML = ""; return; }
  block.hidden = false;
  block.innerHTML = [
    `<h3>${escapeHtml(SEARCH_STATE_COPY.disambiguation.title)}</h3>`,
    `<p class="small">${escapeHtml(String(payload.candidate_count))} candidates found.</p>`,
    // The producer's hint, verbatim. This page opens none of them on its own.
    `<p class="small">${escapeHtml(payload.hint)}</p>`,
    `<ul class="work-list">${payload.candidates.map((row) => `<li class="work-item"><div><h3>${escapeHtml(row.name)}</h3><div class="work-meta"><span>${escapeHtml(row.kind)}</span></div></div></li>`).join("")}</ul>`,
  ].join("");
}

function renderRetired() {
  const block = $("searchRetired");
  if (!block) return;
  const summary = view.payload ? retiredSummary(view.payload) : null;
  if (!summary) { block.hidden = true; block.innerHTML = ""; return; }
  block.hidden = false;
  block.innerHTML = [
    "<h3>Retired aliases</h3>",
    // The producer's own sentence, printed rather than paraphrased.
    `<p class="small">${escapeHtml(summary.note)}</p>`,
    summary.retiredParties > 0 ? `<p class="small">${escapeHtml(String(summary.retiredParties))} matched names are retired aliases and open nothing.</p>` : "",
    summary.organizations.map((row) => `<p class="small">${escapeHtml(row.name)}: ${escapeHtml(String(row.retiredAliases))} retired aliases${row.truncated ? ", list truncated by the record layer" : ""}${row.allRetired ? ", every record behind the name retired" : ""}.</p>`).join(""),
  ].join("");
}

function renderState(phase) {
  const block = $("searchState");
  if (!block) return;
  const copy = SEARCH_STATE_COPY[phase] || SEARCH_STATE_COPY.empty;
  const shows = phase !== "ready";
  block.hidden = !shows;
  block.setAttribute("data-state", phase);
  if (!shows) { block.innerHTML = ""; }
  else {
    const notes = truncationNotes(view.payload, view.catchUp);
    block.innerHTML = [
      `<h3>${escapeHtml(copy.title)}</h3>`,
      `<p class="small">${escapeHtml(copy.copy)}</p>`,
      phase === "partial" ? notes.map((note) => `<p class="small">${escapeHtml(note)}</p>`).join("") : "",
      // Retry is offered by ONE state. A no-match has nothing to retry: the
      // record layer answered, and it answered with nothing.
      copy.retry ? '<button class="btn" type="button" id="searchRetry">Retry</button>' : "",
    ].join("");
  }
  const live = $("searchLive");
  if (live && live.textContent !== copy.title) live.textContent = copy.title;
}

function render() {
  const groups = view.payload ? groupSearchResults(view.payload) : [];
  const shown = applyScope(groups, view.kinds);
  const phase = searchPhase({ status: view.status, payload: view.payload, catchUp: view.catchUp, submitted: view.submitted });

  const input = $("searchQuery");
  if (input && input.value !== view.query) input.value = view.query;

  const results = $("searchResults");
  if (results) {
    results.setAttribute("aria-busy", String(phase === "loading"));
    results.innerHTML = shown.map((group) => `<section class="card glass" data-group="${escapeHtml(group.id)}" aria-label="${escapeHtml(group.label)}">
      <div class="card-heading"><div><p class="eyebrow">Results</p><h2>${escapeHtml(group.label)} · ${escapeHtml(String(group.count))}</h2></div></div>
      <ul class="work-list">${group.rows.map((row) => rowHtml(row)).join("")}</ul>
    </section>`).join("");
  }

  const total = $("searchCount");
  // The only total this page prints is the sum of the rows it is showing.
  if (total) total.textContent = view.payload ? `${visibleCount(shown)} shown` : "";

  renderChips(groups);
  renderSavedViews();
  renderRefusal();
  renderDisambiguation();
  renderRetired();
  renderState(phase);
  $("searchRetry")?.addEventListener("click", () => read({ push: false }));
}

/* --------------------------------------------------------------------- reading */

/**
 * One read of `find` and one of `find-and-catch-up`, both carrying the same
 * sequence token. A late answer is dropped without touching `view`, so the
 * current query's result stands.
 */
async function read({ push = true } = {}) {
  if (!queryIsSendable(view.query)) {
    view.status = "idle"; view.payload = null; view.catchUp = null; view.refusal = null; view.submitted = false;
    render();
    return;
  }
  const sequence = ++view.sequence;
  view.status = "loading";
  view.submitted = true;
  render();
  if (push) pushAddress();
  let payload = null;
  let catchUp = null;
  try {
    payload = await client.find(buildFindArguments(view.query));
  } catch (error) {
    if (!acceptsSearchResponse(view.sequence, sequence)) return;
    view.status = classifySearchFailure(error);
    view.refusal = refusalDetail(error);
    view.payload = null;
    view.catchUp = null;
    render();
    return;
  }
  if (!acceptsSearchResponse(view.sequence, sequence)) return;
  if (!validSearchPayload(payload)) {
    view.status = "unknown"; view.payload = null; view.catchUp = null; view.refusal = null;
    render();
    return;
  }
  try {
    const answer = await client.findAndCatchUp(buildFindAndCatchUpArguments(view.query, FIND_CATCH_UP_LIMIT_DEFAULT));
    catchUp = validCatchUpPayload(answer) ? answer : null;
  } catch {
    // The catch-up leg is context. Its failure never turns a good `find` answer
    // into an outage, and it never invents a candidate list.
    catchUp = null;
  }
  if (!acceptsSearchResponse(view.sequence, sequence)) return;
  view.status = "ready";
  view.payload = payload;
  view.catchUp = catchUp;
  view.refusal = null;
  render();
}

/* ------------------------------------------------------------------ the address */

function pushAddress() {
  const address = searchAddress({ query: view.query, kinds: view.kinds });
  if (globalThis.history?.pushState) globalThis.history.pushState({ q: view.query, kinds: [...view.kinds] }, "", address);
}

function replaceAddress() {
  const address = searchAddress({ query: view.query, kinds: view.kinds });
  if (globalThis.history?.replaceState) globalThis.history.replaceState({ q: view.query, kinds: [...view.kinds] }, "", address);
}

/**
 * Back. The query and the chips are restored from the URL and the page
 * re-renders from the payload already in hand — no read of its own.
 */
function restoreFromAddress({ reread = false } = {}) {
  const address = parseSearchAddress(globalThis.location?.search || "");
  view.query = address.query;
  view.kinds = [...address.kinds];
  view.submitted = address.present && queryIsSendable(address.query);
  if (reread && view.submitted) read({ push: false });
  else render();
  return address;
}

/* ------------------------------------------------------------------ the wiring */

function wire() {
  $("searchForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    view.query = $("searchQuery")?.value ?? "";
    read({ push: true });
  });

  // Typing does not read on every keystroke: one idle re-read, carrying the
  // sequence token like every other read.
  $("searchQuery")?.addEventListener("input", () => {
    view.query = $("searchQuery")?.value ?? "";
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => read({ push: false }), IDLE_REREAD_MS);
  });

  $("searchChips")?.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-chip]");
    if (!chip) return;
    const id = chip.dataset.chip;
    // A chip hides rows from the answer already in hand. Nothing is re-read and
    // the outgoing argument object is untouched.
    view.kinds = view.kinds.includes(id) ? view.kinds.filter((entry) => entry !== id) : [...view.kinds, id];
    replaceAddress();
    render();
  });

  $("saveViewButton")?.addEventListener("click", () => {
    const name = $("saveViewName")?.value ?? "";
    // No verb is sent. There is none to send.
    view.views = writeSavedViews(storage, saveView(view.views, { name, query: view.query, kinds: view.kinds }));
    const field = $("saveViewName");
    if (field) field.value = "";
    render();
  });

  $("savedViewList")?.addEventListener("click", (event) => {
    const rename = event.target.closest("[data-rename]");
    if (rename) {
      event.preventDefault();
      const next = globalThis.prompt?.("New name for this saved view", rename.dataset.rename);
      if (typeof next === "string") view.views = writeSavedViews(storage, renameView(view.views, rename.dataset.rename, next));
      render();
      return;
    }
    const open = event.target.closest("[data-view]");
    if (!open) return;
    event.preventDefault();
    const saved = view.views.find((entry) => entry.name === open.dataset.view);
    if (!saved) return;
    view.query = saved.query;
    view.kinds = [...saved.kinds];
    read({ push: true });
  });

  $("resetViewsButton")?.addEventListener("click", () => {
    view.views = writeSavedViews(storage, resetViews());
    render();
  });

  globalThis.addEventListener?.("popstate", () => restoreFromAddress({ reread: false }));
}

/**
 * Mount the Search tab. `storageImpl` is injectable so a test can watch every
 * key this surface writes and assert that the workspace preference key is never
 * one of them.
 */
export function mountSearch({ client: searchClient, storage: storageImpl } = {}) {
  client = searchClient;
  storage = storageImpl === undefined ? (globalThis.localStorage || null) : storageImpl;
  view.views = readSavedViews(storage);
  for (const [id, text] of [
    ["searchAuthorization", AUTHORIZATION_SENTENCE],
    ["searchScopeNote", SCOPE_CHIP_SENTENCE],
    ["savedViewNote", SAVED_VIEW_SENTENCE],
    ["searchNotSearched", NOT_SEARCHED_SENTENCE],
    ["searchExposure", EXPOSURE_STATEMENT],
  ]) {
    const node = $(id);
    if (node) node.textContent = text;
  }
  wire();
  const address = restoreFromAddress({ reread: true });
  return { view, address };
}

export { view };
