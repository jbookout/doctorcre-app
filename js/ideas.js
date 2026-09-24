// V5-UX-B04 — Ideas and Events: DOM wiring only.
//
// Every decision lives in ./ideas-model.js. This file reads the idea board,
// paints tiles, opens one idea from a FRESH read-loop, and keeps the tab, the
// search and the open idea in the address so Back returns to the same place.
// It writes nothing. The Events tab paints its absent state and sends nothing.

import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { deploymentIdentity, resolveDealroomBoot } from "./boot-mode.js";
import { mountDocDock, mountNotificationBadge, mountPrefs, wireTabs } from "./shell.js";
import { formatCalendarDate } from "./visual-system.js";
import { approach, localToday, staggerDelay } from "./calendar-model.js";
import { partnerName } from "./task-records-model.js";
import {
  EVENTS_ABSENT, IDEA_BOARD_ARGS, filterIdeas, ideaDetailRows, ideaReadState, ideasHref, ideasPhase,
  normalizeIdea, parseIdeasState, validIdeaBoard,
} from "./ideas-model.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));
const SEARCH_DEBOUNCE_MS = 250;
const TILT_DEGREES = 5;

const view = {
  state: parseIdeasState(globalThis.location?.search || ""),
  status: "loading",
  rows: [],
  sequence: 0,
  detailSequence: 0,
};

let client = null;
let tabs = null;
let searchTimer = null;

function motionReduced() {
  const media = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return media || document.documentElement.getAttribute("data-motion") === "reduced";
}

function announce(text) {
  const live = $("ideaLive");
  if (live && live.textContent !== text) live.textContent = text;
}

function setStatus(state, label) {
  $("ideaOrb")?.setAttribute("data-state", state);
  $("ideaStatus")?.setAttribute("data-state", state);
  const text = $("ideaStatusLabel");
  if (text) text.textContent = label;
}

function remember({ push = false } = {}) {
  const href = ideasHref(view.state);
  if (`${location.pathname}${location.search}` === href) return;
  if (push) history.pushState({ ideas: true }, "", href);
  else history.replaceState({ ideas: true }, "", href);
}

/* ------------------------------------------------------------------ painting */

function tileHtml(row, index) {
  const due = row.due_on ? approach({ day: row.due_on, settled: false }, localToday()) : null;
  const meta = [
    row.owner ? `<span>${escapeHtml(partnerName(row.owner))}</span>` : '<span>owner not recorded</span>',
    row.since_text ? `<span>${escapeHtml(row.since_text)}</span>` : "",
    due ? `<span><span class="cal-pulse" data-pulse="${due.pulse}" aria-hidden="true"></span> due ${escapeHtml(formatCalendarDate(row.due_on))} · ${escapeHtml(due.label)}</span>` : "",
  ].join("");
  return `<li><button class="idea-tile" type="button" data-idea="${escapeHtml(row.number)}" style="--stagger: ${motionReduced() ? 0 : staggerDelay(index)}ms">`
    + `<span class="idea-number">#${escapeHtml(row.number)}</span>`
    + `<h3 class="idea-label">${escapeHtml(row.label)}</h3>`
    + `<span class="idea-meta">${meta}</span>`
    + "</button></li>";
}

const STATE_COPY = {
  loading: "Reading the parked ideas…",
  unauthorized: "Your session has ended. Sign in again to read the ideas; nothing is shown from an ended session.",
  unavailable: "The idea board could not be read. Nothing here has been inferred.",
  empty: "No idea is parked right now.",
  no_match: "No parked idea matches this search.",
};

function render() {
  const shown = filterIdeas(view.rows, view.state.q);
  const phase = ideasPhase({ status: view.status, rows: view.rows, shown });
  if (phase === "loading") setStatus("refreshing", "Reading the record…");
  else if (phase === "unauthorized") setStatus("unknown", "Session ended");
  else if (phase === "unavailable") setStatus("urgent", "Record read unavailable");
  else setStatus("healthy", "Read from the record layer");

  const block = $("ideaState");
  if (block) {
    const visible = phase !== "ready";
    block.hidden = !visible;
    block.setAttribute("data-state", phase === "unauthorized" ? "no_access" : phase === "unavailable" ? "offline" : phase);
    const signIn = phase === "unauthorized"
      ? ` <a class="btn btn-primary" href="/auth/login?return_to=${encodeURIComponent(`${location.pathname}${location.search}`)}">Sign in</a>` : "";
    block.innerHTML = visible ? `<h3>${escapeHtml(STATE_COPY[phase])}</h3>${signIn}` : "";
  }
  const list = $("ideaList");
  if (list) list.innerHTML = phase === "ready" ? shown.map(tileHtml).join("") : "";
  const asOf = $("ideaAsOf");
  if (asOf && view.status === "ready") asOf.textContent = `${view.rows.length} open idea${view.rows.length === 1 ? "" : "s"} read`;
  const source = $("ideaSource");
  if (source) source.textContent = `Source: loop-board · kind idea · status open · ${deploymentIdentity(client?.mode).detail}`;
  if (phase === "ready" || phase === "no_match") {
    announce(`${shown.length} of ${view.rows.length} idea${view.rows.length === 1 ? "" : "s"} shown.`);
  }
}

/* ------------------------------------------------------------------- detail */

async function openIdea(number, { push = true } = {}) {
  view.state = { ...view.state, idea: number };
  remember({ push });
  const dialog = $("ideaDialog");
  const title = $("ideaDialogTitle");
  const body = $("ideaDialogBody");
  const row = view.rows.find((item) => item.number === number);
  if (title) title.textContent = row?.label || `Idea #${number}`;
  if (body) body.innerHTML = '<p class="small">Reading this idea…</p><div class="skeleton-line"></div><div class="skeleton-line short"></div>';
  if (dialog && typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();

  const sequence = ++view.detailSequence;
  let read;
  try {
    read = ideaReadState(await client.readLoop({ number, kind: "idea" }));
  } catch (error) {
    read = { state: error?.status === 401 || error?.status === 403 ? "unauthorized" : "unavailable" };
  }
  if (sequence !== view.detailSequence || view.state.idea !== number) return;
  if (!body) return;
  if (read.state !== "ready") {
    const copy = {
      not_found: `No open idea carries number #${number}. It may have been closed.`,
      ambiguous: `More than one record carries number #${number}; this page will not guess which one is meant.`,
      unauthorized: "Your session has ended. Sign in again to read this idea.",
      unavailable: "This idea could not be read. Nothing here has been inferred.",
    }[read.state];
    body.innerHTML = `<p class="attention-copy">${escapeHtml(copy)}</p>`;
    announce(copy);
    return;
  }
  const loop = read.loop;
  if (title) title.textContent = loop.title || row?.label || `Idea #${number}`;
  const rows = ideaDetailRows(loop)
    .map((field) => `<dt>${escapeHtml(field.label)}</dt><dd${field.known ? "" : ' class="unknown"'}>${escapeHtml(field.text)}</dd>`).join("");
  const text = typeof loop.body === "string" && loop.body.trim() ? loop.body : null;
  body.innerHTML = `<dl class="idea-rows">${rows}</dl>`
    + (text ? `<p class="idea-body">${escapeHtml(text)}</p>` : '<p class="small">No description is recorded on this idea.</p>');
  announce(`Idea #${number} opened.`);
}

function closeIdea() {
  const dialog = $("ideaDialog");
  if (dialog?.open) dialog.close();
}

/* ------------------------------------------------------------------ reading */

async function load() {
  const sequence = ++view.sequence;
  if (view.status !== "ready") { view.status = "loading"; render(); }
  try {
    const payload = await client.loopBoard(IDEA_BOARD_ARGS);
    if (sequence !== view.sequence) return;
    if (!validIdeaBoard(payload)) {
      view.status = "error";
    } else {
      view.rows = payload.loops.map(normalizeIdea).filter(Boolean);
      view.status = "ready";
    }
  } catch (error) {
    if (sequence !== view.sequence) return;
    view.status = error?.status === 401 || error?.status === 403 ? "unauthorized" : "error";
    view.rows = [];
  }
  render();
}

/* ------------------------------------------------------------------- wiring */

function selectTab(key, { push = false } = {}) {
  view.state = { ...view.state, tab: key };
  tabs?.select(key === "events" ? "tabEvents" : "tabIdeas");
  remember({ push });
  if (key === "events") announce(EVENTS_ABSENT);
}

function wire() {
  tabs = wireTabs("ideaTabs");
  $("ideaTabs")?.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab-key]");
    if (tab && tab.dataset.tabKey !== view.state.tab) selectTab(tab.dataset.tabKey, { push: true });
  });
  $("ideaTabs")?.addEventListener("keydown", () => {
    const key = document.activeElement?.dataset?.tabKey;
    if (key && key !== view.state.tab) { view.state = { ...view.state, tab: key }; remember(); }
  });

  const search = $("ideaSearch");
  if (search) {
    search.value = view.state.q;
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        view.state = { ...view.state, q: search.value.slice(0, 200) };
        remember();
        render();
      }, SEARCH_DEBOUNCE_MS);
    });
  }

  $("ideaList")?.addEventListener("click", (event) => {
    const tile = event.target.closest(".idea-tile");
    if (tile) openIdea(tile.dataset.idea);
  });
  // The tilt follows the pointer; motion off, it never moves.
  $("ideaList")?.addEventListener("pointermove", (event) => {
    const tile = event.target.closest(".idea-tile");
    if (!tile || motionReduced()) return;
    const box = tile.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;
    tile.style.setProperty("--tilt-y", `${(x * TILT_DEGREES).toFixed(2)}deg`);
    tile.style.setProperty("--tilt-x", `${(-y * TILT_DEGREES).toFixed(2)}deg`);
  });
  $("ideaList")?.addEventListener("pointerleave", () => {
    document.querySelectorAll(".idea-tile").forEach((tile) => { tile.style.removeProperty("--tilt-x"); tile.style.removeProperty("--tilt-y"); });
  }, true);

  $("ideaDialogClose")?.addEventListener("click", closeIdea);
  $("ideaDialog")?.addEventListener("close", () => {
    view.detailSequence += 1;
    if (view.state.idea) { view.state = { ...view.state, idea: null }; remember({ push: true }); }
  });
  $("ideaRefresh")?.addEventListener("click", () => load());
  window.addEventListener("online", () => load());
  window.addEventListener("popstate", () => {
    const next = parseIdeasState(location.search);
    const previousIdea = view.state.idea;
    // The state moves first, so the dialog's close handler sees no open idea
    // and does not push a history entry of its own.
    view.state = next;
    if (search) search.value = next.q;
    tabs?.select(next.tab === "events" ? "tabEvents" : "tabIdeas");
    render();
    if (!next.idea) closeIdea();
    else if (next.idea !== previousIdea) openIdea(next.idea, { push: false });
  });
}

async function boot() {
  mountPrefs();
  mountDocDock("Ideas");
  const absent = $("eventsAbsent");
  if (absent) absent.textContent = EVENTS_ABSENT;
  wire();
  // The markup opens on Ideas; only a remembered Events tab moves it, so a
  // plain visit never steals focus into the tab strip.
  if (view.state.tab === "events") selectTab("events");
  remember();
  render();
  const resolved = resolveDealroomBoot(globalThis.location || { hostname: "", search: "" });
  client = resolved.mode === "live" ? createLiveClient() : await createFixtureClient(resolved.options);
  mountNotificationBadge(client);
  await load();
  if (view.state.idea) openIdea(view.state.idea, { push: false });
}

boot();

export { view };
