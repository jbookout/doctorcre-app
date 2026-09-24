// V5-UX-B04 — Calendar: DOM wiring only.
//
// Every decision about a date, a read or a state lives in ./calendar-model.js.
// This file reads, paints and moves. Three rules shape it:
//
//   1. THE URL IS THE VIEW'S MEMORY. Month or week, the period on screen and the
//      selected day all live in the address, so Back returns to the place a
//      partner was reading and a link opens the same view on the other device.
//   2. NOTHING WAITS ON MOTION. The grid is painted whole and then animated; the
//      agenda and the day panel are plain lists that never animate in from
//      nothing, and the reduced-motion preference (the OS setting or the
//      in-app toggle) skips every programmatic animation below.
//   3. READ ONLY. No write verb is reachable from this page. A critical date is
//      added on the deal itself.

import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { deploymentIdentity, resolveDealroomBoot } from "./boot-mode.js";
import { mountDocDock, mountNotificationBadge, mountPrefs } from "./shell.js";
import { formatCalendarDate } from "./visual-system.js";
import {
  addDays, approach, calendarHref, calendarPhase, entriesByDay, localToday, monthGrid, motionDirection,
  parseCalendarState, readCalendar, staggerDelay, stepAnchor, upcomingEntries, weekStrip,
} from "./calendar-model.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_CHIP_LIMIT = 2;
const TODAY_TICK_MS = 60_000;

/** One place holds what this page believes. */
const view = {
  today: localToday(),
  state: null,
  painted: null,
  focusEntry: null,
  result: { status: "loading" },
  byDay: new Map(),
  sequence: 0,
};

let client = null;

/** The OS setting or the in-app toggle; either one stops programmatic motion. */
function motionReduced() {
  const media = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return media || document.documentElement.getAttribute("data-motion") === "reduced";
}

function announce(text) {
  const live = $("calLive");
  if (live && live.textContent !== text) live.textContent = text;
}

function setStatus(state, label) {
  $("calOrb")?.setAttribute("data-state", state);
  $("calStatus")?.setAttribute("data-state", state);
  const text = $("calStatusLabel");
  if (text) text.textContent = label;
}

/* ------------------------------------------------------------------ painting */

function chipHtml(entry, { withDeal }) {
  const near = approach(entry, view.today);
  const text = `${entry.label} · ${entry.deal_name} · ${near.label}${entry.settled ? " · settled" : ""}`;
  return `<li><button class="cal-chip" type="button" data-entry="${escapeHtml(entry.key)}" data-day="${escapeHtml(entry.day)}" data-band="${near.band}" aria-label="${escapeHtml(text)}">`
    + `<span class="cal-pulse" data-pulse="${near.pulse}" aria-hidden="true"></span>`
    + `<span class="cal-chip-label">${escapeHtml(entry.label)}</span>`
    + (withDeal ? `<span class="cal-chip-deal">${escapeHtml(entry.deal_name)}</span>` : "")
    + "</button></li>";
}

function dayHtml(cell, index) {
  const state = view.state;
  const rows = view.byDay.get(cell.day) || [];
  const week = state.view === "week";
  const shown = week ? rows : rows.slice(0, MONTH_CHIP_LIMIT);
  const more = rows.length - shown.length;
  const selected = state.day === cell.day;
  const isToday = cell.day === view.today;
  const readable = formatCalendarDate(cell.day);
  const count = rows.length ? ` · ${rows.length} critical date${rows.length === 1 ? "" : "s"}` : "";
  const dayNumber = Number(cell.day.slice(8));
  return `<div class="cal-day" role="gridcell" data-day="${cell.day}" data-today="${isToday}" data-out-month="${!cell.inMonth}" aria-selected="${selected}" style="--stagger: ${motionReduced() ? 0 : staggerDelay(index)}ms">`
    + `<button class="cal-day-open" type="button" data-select-day="${cell.day}" tabindex="${selected || (!state.day && isToday) ? 0 : -1}" aria-label="${escapeHtml(`${readable}${isToday ? " · today" : ""}${count}`)}">`
    + `<span class="cal-day-num">${week ? `${WEEKDAYS[index % 7]} ${dayNumber}` : dayNumber}</span>`
    + (rows.length ? `<span class="cal-day-count" aria-hidden="true">${rows.length}</span>` : "")
    + "</button>"
    + (shown.length ? `<ul class="cal-chips">${shown.map((entry) => chipHtml(entry, { withDeal: week })).join("")}</ul>` : "")
    + (more > 0 ? `<span class="cal-more">+${more} more</span>` : "")
    + "</div>";
}

function paintGrid() {
  const grid = $("calGrid");
  if (!grid) return;
  const state = view.state;
  const layout = state.view === "week" ? weekStrip(state.anchor) : monthGrid(state.anchor);
  const header = `<div class="cal-week" role="row">${WEEKDAYS.map((name) => `<div class="cal-weekday" role="columnheader">${name}</div>`).join("")}</div>`;
  const weeks = [];
  for (let start = 0; start < layout.days.length; start += 7) {
    const cells = layout.days.slice(start, start + 7).map((cell, offset) => dayHtml(cell, start + offset)).join("");
    weeks.push(`<div class="cal-week" role="row">${cells}</div>`);
  }
  const direction = motionDirection(view.painted, state);
  grid.dataset.view = state.view;
  grid.innerHTML = header + weeks.join("");
  // Restart the transition on every paint: removing the attribute and reading
  // layout lets the same direction play twice in a row.
  grid.removeAttribute("data-enter");
  if (!motionReduced() && direction !== "none") {
    void grid.offsetWidth;
    grid.setAttribute("data-enter", direction === "enter" ? "zoom-in" : direction);
  }
  view.painted = { ...state };

  const period = $("calPeriod");
  if (period) period.textContent = layout.title;
  const unit = state.view === "week" ? "week" : "month";
  $("calPrev")?.setAttribute("aria-label", `Previous ${unit}`);
  $("calNext")?.setAttribute("aria-label", `Next ${unit}`);
  document.querySelectorAll("#calViewSwitch [data-view]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === state.view)));
}

/** Selecting a day moves nothing: only the selection and the panel change. */
function paintSelection() {
  const grid = $("calGrid");
  grid?.querySelectorAll(".cal-day").forEach((cell) => {
    const selected = cell.dataset.day === view.state.day;
    cell.setAttribute("aria-selected", String(selected));
    const open = cell.querySelector(".cal-day-open");
    if (open) open.tabIndex = selected ? 0 : -1;
  });
  paintDayPanel();
}

function detailRow(label, value) {
  return value
    ? `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`
    : `<dt>${escapeHtml(label)}</dt><dd class="unknown">not recorded</dd>`;
}

function paintDayPanel() {
  const title = $("dayPanelTitle");
  const body = $("dayPanelBody");
  if (!title || !body) return;
  const day = view.state?.day;
  if (!day) {
    title.textContent = "Choose a day";
    body.innerHTML = '<p class="small">Select a day or a date to see what falls on it.</p>';
    return;
  }
  title.textContent = formatCalendarDate(day);
  const phase = calendarPhase(view.result);
  if (phase === "loading") {
    body.innerHTML = '<p class="small">Reading this day…</p>';
    return;
  }
  if (phase === "unauthorized" || phase === "unavailable") {
    body.innerHTML = '<p class="small">Nothing is shown for this day until the record can be read.</p>';
    return;
  }
  const rows = view.byDay.get(day) || [];
  if (rows.length === 0) {
    const partial = view.result.failed?.length ? " Some deals could not be read, so this may not be every date." : "";
    body.innerHTML = `<p class="small">No critical date is recorded on this day.${escapeHtml(partial)}</p>`;
    return;
  }
  body.innerHTML = `<ol class="cal-day-entries">${rows.map((entry, index) => {
    const near = approach(entry, view.today);
    return `<li class="cal-day-entry" data-band="${near.band}" data-focus="${entry.key === view.focusEntry}" style="--stagger: ${motionReduced() ? 0 : staggerDelay(index)}ms">`
      + `<h3><span class="cal-pulse" data-pulse="${near.pulse}" aria-hidden="true"></span>${escapeHtml(entry.label)}</h3>`
      + `<dl>${detailRow("Deal", entry.deal_name)}${detailRow("When", near.label)}${detailRow("Kind", entry.kind_label)}${detailRow("Source", entry.source)}${detailRow("Status", entry.status)}</dl>`
      + `<a class="small" href="/deals">Open the Deals board</a>`
      + "</li>";
  }).join("")}</ol>`;
}

function paintAgenda() {
  const list = $("calAgenda");
  if (!list) return;
  const phase = calendarPhase(view.result);
  if (phase === "loading" || phase === "unauthorized" || phase === "unavailable") {
    list.innerHTML = "";
  } else {
    const rows = upcomingEntries(view.result.entries, view.today);
    list.innerHTML = rows.length === 0
      ? '<li class="small">No open critical date is recorded.</li>'
      : rows.map((entry, index) => {
        const near = approach(entry, view.today);
        return `<li><button class="cal-agenda-item" type="button" data-entry="${escapeHtml(entry.key)}" data-day="${entry.day}" data-band="${near.band}" style="--stagger: ${motionReduced() ? 0 : staggerDelay(index)}ms">`
          + `<span class="cal-pulse" data-pulse="${near.pulse}" aria-hidden="true"></span>`
          + `<span class="cal-agenda-day">${escapeHtml(formatCalendarDate(entry.day))}</span>`
          + `<span><b>${escapeHtml(entry.label)}</b> · ${escapeHtml(entry.deal_name)}</span>`
          + `<span class="cal-agenda-when">${escapeHtml(near.label)}</span>`
          + "</button></li>";
      }).join("");
  }
  const undated = $("calUndated");
  const undatedList = $("calUndatedList");
  const missing = phase === "ready" || phase === "partial" || phase === "empty" ? view.result.undated : [];
  if (undated) undated.hidden = missing.length === 0;
  if (undatedList) {
    undatedList.innerHTML = missing.map((entry) => `<li><b>${escapeHtml(entry.label)}</b> · ${escapeHtml(entry.deal_name)} — the record carries no date this page can read</li>`).join("");
  }
}

const STATE_COPY = {
  loading: "Reading every deal's critical dates…",
  unauthorized: "Your session has ended. Sign in again to read the calendar; nothing is shown from an ended session.",
  unavailable: "The deal board could not be read, so no date is shown. Nothing here has been inferred.",
  empty: "No deal carries a critical date yet.",
};

function paintState(phase) {
  const block = $("calState");
  if (!block) return;
  const visible = phase in STATE_COPY;
  block.hidden = !visible;
  block.setAttribute("data-state", phase === "unauthorized" ? "no_access" : phase === "unavailable" ? "offline" : phase);
  if (!visible) { block.innerHTML = ""; return; }
  const signIn = phase === "unauthorized"
    ? ` <a class="btn btn-primary" href="/auth/login?return_to=${encodeURIComponent(`${location.pathname}${location.search}`)}">Sign in</a>` : "";
  block.innerHTML = `<h3>${escapeHtml(STATE_COPY[phase])}</h3>${signIn}`;
}

function paintNotices(phase) {
  const region = $("calNotices");
  if (!region) return;
  if (phase !== "partial") { region.innerHTML = ""; return; }
  const failed = view.result.failed;
  const names = failed.slice(0, 6).map((row) => escapeHtml(row.deal_name)).join(", ");
  const rest = failed.length > 6 ? ` and ${failed.length - 6} more` : "";
  region.innerHTML = `<div class="notice notice-partial" role="status"><p class="notice-title">${failed.length} of ${view.result.dealCount} deals could not be read</p>`
    + `<p class="notice-copy">Their dates are not on this calendar: ${names}${rest}. The rest are shown as read.</p>`
    + '<button class="btn" type="button" data-retry="calendar">Check again</button></div>';
}

function render() {
  const phase = calendarPhase(view.result);
  if (phase === "loading") setStatus("refreshing", "Reading the record…");
  else if (phase === "unauthorized") setStatus("unknown", "Session ended");
  else if (phase === "unavailable") setStatus("urgent", "Record read unavailable");
  else if (phase === "partial") setStatus("attention", "Partly read");
  else setStatus("healthy", "Read from the record layer");

  view.byDay = phase === "ready" || phase === "partial" ? entriesByDay(view.result.entries) : new Map();
  paintState(phase);
  paintNotices(phase);
  const gridNode = $("calGrid");
  if (phase === "unauthorized" || phase === "unavailable") {
    if (gridNode) gridNode.innerHTML = "";
    view.painted = null;
  } else {
    paintGrid();
  }
  paintSelection();
  paintAgenda();

  const asOf = $("calAsOf");
  if (asOf && view.result.status === "ready") {
    asOf.textContent = `${view.result.entries.length} dated · ${view.result.readCount} of ${view.result.dealCount} deals read`;
  }
  const source = $("calSource");
  if (source) source.textContent = `Source: deal-room-board, then get-deal-room per deal · ${deploymentIdentity(client?.mode).detail}`;
}

/* -------------------------------------------------------------- navigation */

function go(next, { push = true } = {}) {
  const before = view.state;
  view.state = next;
  const href = calendarHref(next);
  if (`${location.pathname}${location.search}` !== href) {
    if (push) history.pushState({ calendar: true }, "", href);
    else history.replaceState({ calendar: true }, "", href);
  }
  const moved = !before || before.view !== next.view || before.anchor !== next.anchor;
  if (moved) render();
  else paintSelection();
  const periodText = $("calPeriod")?.textContent || "";
  if (moved) announce(`${periodText}. ${next.view === "week" ? "Week" : "Month"} view.`);
}

/** Select a day, moving the period so it is on screen. Selection replaces history. */
function selectDay(day, { entry = null, focus = false } = {}) {
  view.focusEntry = entry;
  const state = view.state;
  const layout = state.view === "week" ? weekStrip(state.anchor) : monthGrid(state.anchor);
  const inView = layout.days.some((cell) => cell.day === day && (state.view === "week" || cell.inMonth));
  const next = { ...state, day, anchor: inView ? state.anchor : day };
  go(next, { push: !inView });
  if (focus) {
    const button = document.querySelector(`.cal-day-open[data-select-day="${day}"]`);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest", behavior: motionReduced() ? "auto" : "smooth" });
  }
  const rows = view.byDay.get(day) || [];
  announce(`${formatCalendarDate(day)}: ${rows.length === 0 ? "no critical date" : `${rows.length} critical date${rows.length === 1 ? "" : "s"}`}.`);
}

const ARROW_STEP = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

function wire() {
  $("calViewSwitch")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]");
    if (!button || button.dataset.view === view.state.view) return;
    go({ ...view.state, view: button.dataset.view, anchor: view.state.day || view.state.anchor });
  });
  $("calPrev")?.addEventListener("click", () => go(stepAnchor(view.state, -1)));
  $("calNext")?.addEventListener("click", () => go(stepAnchor(view.state, 1)));
  $("calToday")?.addEventListener("click", () => go({ ...view.state, anchor: view.today, day: view.today }));
  $("calRefresh")?.addEventListener("click", () => load());
  $("calNotices")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-retry='calendar']")) load();
  });

  $("calGrid")?.addEventListener("click", (event) => {
    const chip = event.target.closest(".cal-chip");
    if (chip) { selectDay(chip.dataset.day, { entry: chip.dataset.entry }); return; }
    const open = event.target.closest(".cal-day-open");
    if (open) selectDay(open.dataset.selectDay);
  });
  $("calGrid")?.addEventListener("keydown", (event) => {
    const open = event.target.closest(".cal-day-open");
    const step = ARROW_STEP[event.key];
    if (!open || !step) return;
    event.preventDefault();
    selectDay(addDays(open.dataset.selectDay, step), { focus: true });
  });
  $("calAgenda")?.addEventListener("click", (event) => {
    const item = event.target.closest(".cal-agenda-item");
    if (item) selectDay(item.dataset.day, { entry: item.dataset.entry, focus: true });
  });

  window.addEventListener("popstate", () => {
    view.state = parseCalendarState(location.search, view.today);
    render();
  });
  window.addEventListener("online", () => load());
  // A page left open past midnight moves "today" with the clock.
  setInterval(() => {
    const today = localToday();
    if (today === view.today) return;
    view.today = today;
    render();
  }, TODAY_TICK_MS);
}

/* ----------------------------------------------------------------- reading */

async function load() {
  const sequence = ++view.sequence;
  if (view.result.status !== "ready") { view.result = { status: "loading" }; render(); }
  else setStatus("refreshing", "Checking again…");
  const result = await readCalendar(client);
  if (sequence !== view.sequence) return;
  view.result = result;
  view.painted = null;
  render();
  const phase = calendarPhase(result);
  if (phase === "ready" || phase === "partial") {
    announce(`${result.entries.length} critical date${result.entries.length === 1 ? "" : "s"} read from ${result.readCount} of ${result.dealCount} deals.`);
  } else {
    announce(STATE_COPY[phase] || "");
  }
}

async function boot() {
  mountPrefs();
  mountDocDock("Calendar");
  view.state = parseCalendarState(location.search, view.today);
  history.replaceState({ calendar: true }, "", calendarHref(view.state));
  wire();
  render();
  const resolved = resolveDealroomBoot(globalThis.location || { hostname: "", search: "" });
  client = resolved.mode === "live" ? createLiveClient() : await createFixtureClient(resolved.options);
  mountNotificationBadge(client);
  await load();
}

boot();

export { view };
