// V5-UX-B06 — Commercial charts and linked drilldown: DOM wiring only.
//
// Every decision this file paints is made in ./charts-model.js. Nothing here
// sorts, ranks, counts, or invents a field:
//
//   1. ONE `getBoard()` per paint, through the client adapter — never the verb
//      directly — so the live and fixture modes speak one phase vocabulary and
//      there is no second as-of to disagree with.
//   2. The drilldown filters the rows already in hand. Choosing a slice issues
//      no read at all, so a filtered total is a subset of the total it came
//      out of, always.
//   3. Every bar is `aria-hidden` paint drawn beside a real <table> whose rows
//      are the focusable, tappable targets. The table IS the surface.
//   4. A response only paints if no newer read has been started since it left.
//   5. Reduced motion is honoured by drawing the bars at their final width with
//      no transition at all, not by shortening one.
import {
  CHARTS_STATE_COPY, NEVER_REVIEWED, NO_FORECAST_SENTENCE, NO_VALUE_KEY,
  ONE_READ_SENTENCE, OWNER_DISCLOSURE_SENTENCE, SNAPSHOT_SENTENCE,
  accountRows, acceptsBoardResponse, barShare, bucketRows, chartsAddress, chartsPhase,
  classifyBoardFailure, dimensionById, filterDeals, nextDateCoverage, ownerRows,
  parseChartsAddress, phaseRows, readChartsView, rowTotal, selectionLabel, touchCoverage,
  validBoardPayload, waitingSummary, writeChartsView,
} from "./charts-model.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

/** One place holds what the Charts tab believes; nothing else keeps a copy. */
const view = {
  status: "loading", payload: null, readAt: null, group: null, pick: null,
  sequence: 0, ownerOpen: false,
};

let client = null;
let storage = null;

/** The clock of the moment the response resolved. The verb returns no time of
 * its own, so this page says "Read at" and never "as of". */
function clockNow(now = new Date()) {
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/* -------------------------------------------------------------------- painting */

/**
 * A chart: one <table> of real rows, one decorative bar per row. The row is
 * the control — a button inside the first cell, so it is reachable by Tab, by
 * Enter and by a 44 px tap, in that one place.
 */
function chartHtml({ id, title, eyebrow, rows, note = "", group = null }) {
  const total = rowTotal(rows);
  const body = rows.map((row) => {
    const share = barShare(row, rows);
    const selected = group && view.group === group && view.pick === row.key;
    const pick = group
      ? `<button class="chart-pick" type="button" data-group="${escapeHtml(group)}" data-pick="${escapeHtml(row.key)}" aria-pressed="${selected}">${escapeHtml(row.label)}</button>`
      : `<span>${escapeHtml(row.label)}</span>`;
    return `<tr${row.missing ? ' data-missing="true"' : ""}${selected ? ' data-selected="true"' : ""}>
      <th scope="row">${pick}</th>
      <td class="chart-count">${escapeHtml(String(row.count))}</td>
      <td class="chart-bar-cell"><span class="chart-bar" aria-hidden="true" style="--share:${share}%"></span></td>
    </tr>`;
  }).join("");
  return `<section class="card glass chart-card" id="${escapeHtml(id)}" aria-labelledby="${escapeHtml(id)}Title">
    <div class="card-heading"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h2 id="${escapeHtml(id)}Title">${escapeHtml(title)}</h2></div></div>
    <table class="chart-table">
      <caption class="sr-only">${escapeHtml(title)} — ${escapeHtml(String(total))} records</caption>
      <thead><tr><th scope="col">${escapeHtml(dimensionById(group)?.label || "Row")}</th><th scope="col">Records</th><th scope="col"><span class="sr-only">Share</span></th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="caption">${escapeHtml(String(total))} records in this chart.${note ? ` ${escapeHtml(note)}` : ""}</p>
  </section>`;
}

function accountsHtml(accounts) {
  if (accounts.length === 0) {
    return `<section class="card glass chart-card" id="chartAccounts" aria-labelledby="chartAccountsTitle">
      <div class="card-heading"><div><p class="eyebrow">National accounts</p><h2 id="chartAccountsTitle">Accounts</h2></div></div>
      <div class="state-block" data-state="empty"><h3>No national accounts on this board</h3></div>
    </section>`;
  }
  const rows = accounts.map((account) => `<tr>
    <th scope="row">${escapeHtml(account.name)}${account.ref ? ` <span class="quiet">${escapeHtml(account.ref)}</span>` : ""}</th>
    ${account.counts.map((count) => `<td class="chart-count"${count.known ? "" : ' data-unknown="true"'}>${escapeHtml(count.text)}</td>`).join("")}
    <td>${escapeHtml(account.review)}</td>
  </tr>`).join("");
  return `<section class="card glass chart-card" id="chartAccounts" aria-labelledby="chartAccountsTitle">
    <div class="card-heading"><div><p class="eyebrow">National accounts</p><h2 id="chartAccountsTitle">Accounts</h2></div></div>
    <div class="chart-scroll"><table class="chart-table">
      <thead><tr><th scope="col">Account</th><th scope="col">Open</th><th scope="col">Flagged</th><th scope="col">Overdue</th><th scope="col">Stale</th><th scope="col">Parked</th><th scope="col">Last review</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="caption">These five counts arrive from the record layer as text and are read as numbers here. A count this page cannot read as a number says "unknown" rather than nothing, and a record layer that has never recorded a review here says "${escapeHtml(NEVER_REVIEWED)}" rather than a clock of zero days.</p>
  </section>`;
}

function ownerHtml(deals) {
  const rows = ownerRows(deals);
  return `<section class="card glass chart-card" id="chartOwners" aria-labelledby="chartOwnersTitle">
    <div class="card-heading"><div><p class="eyebrow">By name, never by count</p><h2 id="chartOwnersTitle">Owner split</h2></div></div>
    <details id="ownerDisclosure"${view.ownerOpen ? " open" : ""}>
      <summary>Show the owner split</summary>
      <table class="chart-table">
        <thead><tr><th scope="col">Owner</th><th scope="col">Records</th></tr></thead>
        <tbody>${rows.map((row) => `<tr${row.missing ? ' data-missing="true"' : ""}><th scope="row"><button class="chart-pick" type="button" data-group="owner" data-pick="${escapeHtml(row.key)}" aria-pressed="${view.group === "owner" && view.pick === row.key}">${escapeHtml(row.label)}</button></th><td class="chart-count">${escapeHtml(String(row.count))}</td></tr>`).join("")}</tbody>
      </table>
    </details>
    <p class="caption">${escapeHtml(OWNER_DISCLOSURE_SENTENCE)}</p>
  </section>`;
}

function selectionHtml(deals, all) {
  const label = selectionLabel(view.group, view.pick);
  if (!label) {
    return `<p class="caption" id="chartsSelection">No slice chosen. All ${escapeHtml(String(all.length))} records on the board are counted below.</p>`;
  }
  return `<div class="chip-bar" id="chartsSelection">
    <span class="chip-label">${escapeHtml(label)}</span>
    <span class="chip-list"><span class="chip">${escapeHtml(String(deals.length))} of ${escapeHtml(String(all.length))} records</span>
    <button class="chip" type="button" id="chartsClear">Clear this slice</button>
    <a class="chip" href="/pipeline">Open in Pipeline</a></span>
  </div>`;
}

function renderState(phase) {
  const block = $("chartsState");
  if (!block) return;
  const copy = CHARTS_STATE_COPY[phase] || CHARTS_STATE_COPY.loading;
  const shows = phase !== "ready";
  block.hidden = !shows;
  block.setAttribute("data-state", phase);
  block.innerHTML = shows
    ? [
      `<h3>${escapeHtml(copy.title)}</h3>`,
      `<p class="small">${escapeHtml(copy.copy)}</p>`,
      copy.retry ? '<button class="btn" type="button" id="chartsRetry">Retry</button>' : "",
    ].join("")
    : "";
  const live = $("chartsLive");
  if (live && live.textContent !== copy.title) live.textContent = copy.title;
}

function render() {
  const phase = chartsPhase({ status: view.status, payload: view.payload });
  const all = view.payload && validBoardPayload(view.payload) ? view.payload.deals : [];
  const deals = filterDeals(all, view.group, view.pick);
  const canvas = $("chartsCanvas");

  const readAt = $("chartsReadAt");
  if (readAt) readAt.textContent = view.readAt ? `Read at ${view.readAt}` : "Reading the board…";

  if (canvas) {
    canvas.setAttribute("aria-busy", String(phase === "loading"));
    if (phase === "loading") {
      canvas.innerHTML = '<section class="card glass chart-card" data-skeleton="true" aria-hidden="true"><p class="caption">Reading the board…</p></section>';
    } else if (phase === "empty" || phase === "refused" || phase === "unavailable" || phase === "unknown") {
      // No chart is drawn at all. A chart of zeros here would be a claim.
      canvas.innerHTML = "";
    } else {
      const coverage = nextDateCoverage(deals);
      const touch = touchCoverage(deals);
      const waiting = waitingSummary(deals);
      canvas.innerHTML = [
        selectionHtml(deals, all),
        chartHtml({ id: "chartPhase", eyebrow: "Pipeline", title: "By phase", rows: phaseRows(deals), group: "phase" }),
        chartHtml({ id: "chartType", eyebrow: "Mix", title: "By deal type", rows: bucketRows(deals, "type"), group: "type" }),
        chartHtml({ id: "chartSegment", eyebrow: "Mix", title: "By segment", rows: bucketRows(deals, "segment"), group: "segment", note: "A record with no segment is counted in its own row, never dropped." }),
        chartHtml({ id: "chartMarket", eyebrow: "Mix", title: "By market", rows: bucketRows(deals, "market"), group: "market" }),
        chartHtml({
          id: "chartWaiting", eyebrow: "Waiting", title: "By operating state", rows: waiting.states, group: "operating_state",
          note: `${waiting.attentionLine}.${waiting.parked.length > 0 ? ` Parked: ${waiting.parked.map((row) => `${row.name} — ${row.reason}`).join("; ")}.` : ""}`,
        }),
        `<section class="card glass chart-card" id="chartCoverage" aria-labelledby="chartCoverageTitle">
          <div class="card-heading"><div><p class="eyebrow">What is missing</p><h2 id="chartCoverageTitle">Coverage</h2></div></div>
          <p class="count-line">${escapeHtml(coverage.sentence)}</p>
          <p class="caption">${escapeHtml(touch.sentence)}. A record with no last review recorded is "${escapeHtml(NEVER_REVIEWED)}"; this board carried no review time on any record, so no review clock is drawn.</p>
        </section>`,
        accountsHtml(accountRows(view.payload?.accounts)),
        ownerHtml(deals),
      ].join("");
    }
  }

  renderState(phase);
  $("chartsRetry")?.addEventListener("click", () => read({ push: false }));
  $("chartsClear")?.addEventListener("click", () => choose(null, null));
  $("ownerDisclosure")?.addEventListener("toggle", (event) => {
    view.ownerOpen = event.target.open === true;
    writeChartsView(storage, { ownerOpen: view.ownerOpen });
  });
}

/* --------------------------------------------------------------------- reading */

/**
 * ONE `getBoard()`, carrying a sequence token. A late answer is dropped without
 * touching `view`, so the newer answer stands.
 */
export async function read({ push = false } = {}) {
  const sequence = ++view.sequence;
  view.status = "loading";
  render();
  if (push) pushAddress();
  let payload = null;
  try {
    payload = await client.getBoard({ workspace: "all" });
  } catch (error) {
    if (!acceptsBoardResponse(view.sequence, sequence)) return;
    view.status = classifyBoardFailure(error);
    view.payload = null;
    view.readAt = null;
    render();
    return;
  }
  if (!acceptsBoardResponse(view.sequence, sequence)) return;
  if (!validBoardPayload(payload)) {
    view.status = "unknown";
    view.payload = null;
    view.readAt = null;
    render();
    return;
  }
  view.status = "ready";
  view.payload = payload;
  view.readAt = clockNow();
  render();
}

/* ------------------------------------------------------------------ the address */

function pushAddress() {
  const address = chartsAddress({ group: view.group, pick: view.pick });
  if (globalThis.history?.pushState) globalThis.history.pushState({ charts: 1, group: view.group, pick: view.pick }, "", address);
}

/**
 * Choosing a slice. No read: the rows are already in hand, so the filtered
 * totals cannot disagree with the ones they were taken from.
 */
function choose(group, pick) {
  const same = view.group === group && view.pick === pick;
  view.group = same ? null : group;
  view.pick = same ? null : pick;
  pushAddress();
  render();
}

/** Back. The selection is restored from the URL and repainted without a read. */
function restoreFromAddress() {
  const address = parseChartsAddress(globalThis.location?.search || "");
  view.group = address.group;
  view.pick = address.pick;
  render();
  return address;
}

/* ------------------------------------------------------------------ the wiring */

function wire() {
  $("chartsCanvas")?.addEventListener("click", (event) => {
    const pick = event.target.closest("[data-pick]");
    if (!pick) return;
    choose(pick.dataset.group, pick.dataset.pick);
  });
  globalThis.addEventListener?.("popstate", () => restoreFromAddress());
}

/**
 * Mount the Charts tab. `storageImpl` is injectable so a test can watch every
 * key this surface writes and assert that neither the workspace preference key
 * nor the saved-views key is ever one of them.
 */
export function mountCharts({ client: boardClient, storage: storageImpl } = {}) {
  client = boardClient;
  storage = storageImpl === undefined ? (globalThis.localStorage || null) : storageImpl;
  view.ownerOpen = readChartsView(storage).ownerOpen;
  for (const [id, text] of [
    ["chartsOneRead", ONE_READ_SENTENCE],
    ["chartsSnapshot", SNAPSHOT_SENTENCE],
    ["chartsForecast", NO_FORECAST_SENTENCE],
  ]) {
    const node = $(id);
    if (node) node.textContent = text;
  }
  wire();
  const address = restoreFromAddress();
  read({ push: false });
  return { view, address };
}

export { view, NO_VALUE_KEY };
