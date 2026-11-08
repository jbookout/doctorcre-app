import { createCurrentRead } from "./current-read.mjs";
import { mountAutoRefresh, updatedLabel } from "./auto-refresh.mjs";
import { formatDueStamp, formatClock } from "./visual-system.js";
// V5-UX-B06 — Commercial charts and linked drilldown: DOM wiring only.
//
// Every decision this file paints is made in ./charts-model.js. Nothing here
// sorts, ranks, counts, or invents a field:
//
//   1. One board read supplies the page; refresh takes a new snapshot.
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
  accountRows, barShare, bucketRows, chartsAddress, chartsPhase,
  classifyBoardFailure, dealsDestination, dimensionById, filterDeals, nextDateCoverage, ownerRows,
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
  ownerOpen: false, openAccounts: new Set(),
};

let client = null;
let storage = null;
const boardReads = createCurrentRead();

/* -------------------------------------------------------------------- painting */

/**
 * A chart: one <table> of real rows, one decorative bar per row. The row is
 * the control — a button inside the first cell, so it is reachable by Tab, by
 * Enter and by a 44 px tap, in that one place.
 */
function chartHtml({ id, title, rows, note = "", group = null }) {
  const total = rowTotal(rows);
  const body = rows.map((row) => {
    const share = barShare(row, rows);
    const selected = group && view.group === group && view.pick === row.key;
    const pick = group
      ? `<button class="chart-pick" type="button" data-group="${escapeHtml(group)}" data-pick="${escapeHtml(row.key)}" data-focus-key="${escapeHtml(pickFocusKey(group, row.key))}" aria-pressed="${selected}">${escapeHtml(row.label)}</button>`
      : `<span>${escapeHtml(row.label)}</span>`;
    return `<tr${row.missing ? ' data-missing="true"' : ""}${selected ? ' data-selected="true"' : ""}>
      <th scope="row">${pick}</th>
      <td class="chart-count">${escapeHtml(String(row.count))}</td>
      <td class="chart-bar-cell"><span class="chart-bar" aria-hidden="true" data-share="${share}"></span></td>
    </tr>`;
  }).join("");
  return `<section class="card glass chart-card" id="${escapeHtml(id)}" aria-labelledby="${escapeHtml(id)}Title">
    <div class="card-heading"><div><h2 id="${escapeHtml(id)}Title">${escapeHtml(title)}</h2></div></div>
    <table class="chart-table">
      <caption class="sr-only">${escapeHtml(title)} — ${escapeHtml(String(total))} records</caption>
      <thead><tr><th scope="col">${escapeHtml(dimensionById(group)?.label || "Row")}</th><th scope="col">Records</th><th scope="col" class="chart-bar-head"><span class="sr-only">Share</span></th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="caption">${escapeHtml(String(total))} records in this chart.${note ? ` ${escapeHtml(note)}` : ""}</p>
  </section>`;
}

function accountsHtml(accounts) {
  if (accounts.length === 0) {
    return `<section class="card glass chart-card" id="chartAccounts" aria-labelledby="chartAccountsTitle">
      <div class="card-heading"><div><h2 id="chartAccountsTitle">Accounts</h2></div></div>
      <div class="state-block" data-state="empty"><h3>No national accounts on this board</h3></div>
    </section>`;
  }
  const rows = accounts.map((account) => `<tr>
    <th scope="row">${escapeHtml(account.name)}</th>
    ${account.counts.map((count) => `<td class="chart-count"${count.known ? "" : ' data-unknown="true"'}>${escapeHtml(count.text)}</td>`).join("")}
    <td>${escapeHtml(formatDueStamp(account.review, formatClock(account.review)) || account.review)}</td>
    <td>${account.ref ? `<details class="chart-details" data-account="${escapeHtml(account.ref)}"${view.openAccounts.has(account.ref) ? " open" : ""}><summary data-focus-key="${escapeHtml(`account:${account.ref}`)}">Details<span class="sr-only"> for ${escapeHtml(account.name)}</span></summary><dl><dt>Account reference</dt><dd>${escapeHtml(account.ref)}</dd></dl></details>` : "—"}</td>
  </tr>`).join("");
  return `<section class="card glass chart-card" id="chartAccounts" aria-labelledby="chartAccountsTitle">
    <div class="card-heading"><div><h2 id="chartAccountsTitle">Accounts</h2></div></div>
    <div class="chart-scroll"><table class="chart-table">
      <thead><tr><th scope="col">Account</th><th scope="col">Open</th><th scope="col">Flagged</th><th scope="col">Overdue</th><th scope="col">Stale</th><th scope="col">Parked</th><th scope="col">Last review</th><th scope="col">Details</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>

  </section>`;
}

function ownerHtml(deals) {
  const rows = ownerRows(deals);
  return `<section class="card glass chart-card" id="chartOwners" aria-labelledby="chartOwnersTitle">
    <div class="card-heading"><div><h2 id="chartOwnersTitle">Owner split</h2></div></div>
    <details id="ownerDisclosure"${view.ownerOpen ? " open" : ""}>
      <summary data-focus-key="owner-disclosure">Show the owner split</summary>
      <table class="chart-table">
        <thead><tr><th scope="col">Owner</th><th scope="col">Records</th></tr></thead>
        <tbody>${rows.map((row) => `<tr${row.missing ? ' data-missing="true"' : ""}><th scope="row"><button class="chart-pick" type="button" data-group="owner" data-pick="${escapeHtml(row.key)}" data-focus-key="${escapeHtml(pickFocusKey("owner", row.key))}" aria-pressed="${view.group === "owner" && view.pick === row.key}">${escapeHtml(row.label)}</button></th><td class="chart-count">${escapeHtml(String(row.count))}</td></tr>`).join("")}</tbody>
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
  const destination = dealsDestination(view.group, view.pick);
  return `<div class="chip-bar" id="chartsSelection">
    <span class="chip-label">${escapeHtml(label)}</span>
    <span class="chip-list"><span class="chip">${escapeHtml(String(deals.length))} of ${escapeHtml(String(all.length))} records</span>
    <button class="chip" type="button" id="chartsClear" data-focus-key="clear">Clear this slice</button>
    <a class="chip" href="${escapeHtml(destination.href)}" data-focus-key="deals">${escapeHtml(destination.label)}</a></span>
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
      copy.retry ? '<button class="btn" type="button" id="chartsRetry" aria-label="Refresh" title="Refresh"><span aria-hidden="true">↻</span></button>' : "",
    ].join("")
    : "";
  const live = $("chartsLive");
  if (live && live.textContent !== copy.title) live.textContent = copy.title;
}

/** The focus key of a slice's row control, shared by every chart and the owner split. */
const pickFocusKey = (group, pick) => `pick:${group}:${pick}`;

/**
 * Every paint replaces the canvas, so what a person was doing in it is carried
 * across: the account Details they opened and the control that held focus. A
 * control that is gone (the cleared slice's chip) hands focus to `fallback`.
 */
function canvasMemory(canvas) {
  const accounts = canvas?.querySelectorAll("details[data-account]") || [];
  if (accounts.length) view.openAccounts = new Set([...accounts].filter((node) => node.open).map((node) => node.dataset.account));
  const active = document.activeElement;
  return canvas?.contains(active) ? active.closest("[data-focus-key]")?.dataset.focusKey ?? null : null;
}

function restoreFocus(canvas, keys) {
  const targets = [...canvas.querySelectorAll("[data-focus-key]")];
  keys.filter(Boolean).map((key) => targets.find((node) => node.dataset.focusKey === key)).find(Boolean)?.focus({ preventScroll: true });
}

function render({ focusFallback = null } = {}) {
  const phase = chartsPhase({ status: view.status, payload: view.payload, group: view.group, pick: view.pick });
  const all = view.payload && validBoardPayload(view.payload) ? view.payload.deals : [];
  const deals = filterDeals(all, view.group, view.pick);
  const canvas = $("chartsCanvas");
  const focused = canvasMemory(canvas);

  const readAt = $("chartsReadAt");
  if (readAt) readAt.textContent = view.status === "loading" ? "Updating…" : view.readAt ? updatedLabel(view.readAt) : "Unavailable";

  if (canvas) {
    canvas.setAttribute("aria-busy", String(phase === "loading"));
    if (phase === "loading") {
      canvas.innerHTML = '<section class="card glass chart-card" data-skeleton="true" aria-hidden="true"><p class="caption">Updating…</p></section>';
    } else if (phase === "empty" || phase === "refused" || phase === "unavailable" || phase === "unreadable") {
      // No chart is drawn at all. A chart of zeros here would be a claim.
      canvas.innerHTML = "";
    } else if (phase === "no_match") {
      // The board answered and holds records; this SLICE holds none. The way
      // back out is offered, and not one chart is painted from the empty set.
      canvas.innerHTML = selectionHtml(deals, all);
    } else {
      const coverage = nextDateCoverage(deals);
      const touch = touchCoverage(deals);
      const waiting = waitingSummary(deals);
      canvas.innerHTML = [
        selectionHtml(deals, all),
        chartHtml({ id: "chartPhase", title: "By phase", rows: phaseRows(deals), group: "phase" }),
        chartHtml({ id: "chartType", title: "By deal type", rows: bucketRows(deals, "type"), group: "type" }),
        chartHtml({ id: "chartSegment", title: "By segment", rows: bucketRows(deals, "segment"), group: "segment", note: "A record with no segment is counted in its own row, never dropped." }),
        chartHtml({ id: "chartMarket", title: "By market", rows: bucketRows(deals, "market"), group: "market" }),
        chartHtml({
          id: "chartWaiting", title: "By operating state", rows: waiting.states, group: "operating_state",
          note: `${waiting.attentionLine}.${waiting.parked.length > 0 ? ` Parked: ${waiting.parked.map((row) => `${row.name} — ${row.reason}`).join("; ")}.` : ""}`,
        }),
        `<section class="card glass chart-card" id="chartCoverage" aria-labelledby="chartCoverageTitle">
          <div class="card-heading"><div><h2 id="chartCoverageTitle">Coverage</h2></div></div>
          <p class="count-line">${escapeHtml(coverage.sentence)}</p>
          <p class="caption">${escapeHtml(touch.sentence)}. A record with no last review recorded is "${escapeHtml(NEVER_REVIEWED)}"; this board carried no review time on any record, so no review clock is drawn.</p>
        </section>`,
        accountsHtml(accountRows(view.payload?.accounts)),
        ownerHtml(deals),
      ].join("");
      // `--share` is set through CSSOM: the Worker's CSP (src/worker.js)
      // refuses a `style` attribute written into markup, so the bar cell
      // above only emits `data-share`, and this reads it back.
      canvas.querySelectorAll(".chart-bar[data-share]").forEach((node) => {
        node.style.setProperty("--share", `${node.dataset.share}%`);
      });
    }
    if (focused) restoreFocus(canvas, [focused, focusFallback]);
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

// The poller's reads and a person's Retry share one lifetime: only the
// current answer paints.
export async function read({ push = false, signal } = {}) {
  // A refresh with a board in hand keeps that board, its time and any open
  // Details on screen until the answer arrives; only a page with nothing to
  // show waits on the skeleton.
  if (view.status === "ready") $("chartsCanvas")?.setAttribute("aria-busy", "true");
  else {
    view.status = "loading";
    render();
  }
  if (push) pushAddress();
  return boardReads.run(({ signal }) => client.getBoard({ workspace: "all", signal }), {
    signal,
    success(payload) {
      if (!validBoardPayload(payload)) {
        // §4's own wording: a NON-OBJECT payload is the unanswered path. An object
        // that is merely the wrong shape is the one this page cannot read.
        view.status = payload === null || typeof payload !== "object" ? "unavailable" : "unreadable";
        view.payload = null; view.readAt = null;
      } else {
        // The producer returns no timestamp; record when this read resolved.
        view.status = "ready"; view.payload = payload; view.readAt = new Date().toISOString();
      }
      render();
    },
    failure(error) {
      view.status = classifyBoardFailure(error);
      view.payload = null; view.readAt = null;
      render();
    },
  });
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
  const cleared = view.group ? pickFocusKey(view.group, view.pick) : null;
  view.group = same ? null : group;
  view.pick = same ? null : pick;
  pushAddress();
  render({ focusFallback: cleared });
}

/**
 * Back. The selection AND the tab are restored from the URL, and the page
 * repaints from the payload in hand — no read. Restoring the selection without
 * the tab would land a partner on Home holding a filter they cannot see.
 */
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
  // The poller takes the first read too; with no window to poll in, the page
  // still reads once.
  const poller = mountAutoRefresh({ document, window: globalThis.window, refresh: async ({ signal }) => {
    await read({ push: false, signal });
    if (view.status === "unavailable") throw new Error("Charts board unavailable");
  } });
  if (globalThis.window) poller.refresh();
  else read({ push: false });
  return { view, address };
}

export { view, NO_VALUE_KEY };
