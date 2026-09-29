// V5-UX-B04 — Ideas and Events: DOM wiring only.
//
// Every decision lives in ./ideas-model.js. This file reads the idea board,
// paints tiles, opens one idea from a FRESH read-loop, and keeps the tab, the
// search and the open idea in the address so Back returns to the same place.
// Events use CARR's sourced event verbs and keep unsaved form data on refusal.

import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { deploymentIdentity, resolveDealroomBoot } from "./boot-mode.js";
import { mountDocDock, mountNotificationBadge, mountPrefs, wireTabs } from "./shell.js";
import { formatCalendarDate } from "./visual-system.js";
import { approach, localToday, staggerDelay } from "./calendar-model.js";
import { partnerName } from "./task-records-model.js";
import {
  IDEA_BOARD_ARGS, filterIdeas, ideaDetailRows, ideaReadState, ideasHref, ideasPhase,
  normalizeIdea, parseIdeasState, validIdeaBoard, eventReadState, eventPhase,
  eventWriteRequest, eventWriteOutcome, eventLocalDateTime,
  eventChangedFields,
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
  events: { status: "loading", rows: [], sequence: 0, draft: null, current: null, original: null, latest: null },
};

let client = null;
let tabs = null;
let searchTimer = null;

function motionReduced() {
  const media = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return media || document.documentElement.getAttribute("data-motion") === "reduced";
}

/**
 * A staggered entrance, set through CSSOM: the Worker's CSP (src/worker.js)
 * refuses a `style` attribute written into markup, so the templates above
 * only emit `data-stagger-index`, and this post-render pass reads it back
 * and sets `--stagger` on each node directly.
 */
function applyStagger(root, selector) {
  root?.querySelectorAll(selector).forEach((node) => {
    const index = Number(node.dataset.staggerIndex);
    node.style.setProperty("--stagger", `${motionReduced() ? 0 : staggerDelay(index)}ms`);
  });
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
  return `<li><button class="idea-tile" type="button" data-idea="${escapeHtml(row.number)}" data-stagger-index="${index}">`
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
  if (list) {
    list.innerHTML = phase === "ready" ? shown.map(tileHtml).join("") : "";
    applyStagger(list, ".idea-tile");
  }
  const asOf = $("ideaAsOf");
  if (asOf && view.status === "ready") asOf.textContent = `${view.rows.length} open idea${view.rows.length === 1 ? "" : "s"} read`;
  const source = $("ideaSource");
  if (source) source.textContent = `Source: loop-board · kind idea · status open · ${deploymentIdentity(client?.mode).detail}`;
  if (phase === "ready" || phase === "no_match") {
    announce(`${shown.length} of ${view.rows.length} idea${view.rows.length === 1 ? "" : "s"} shown.`);
  }
}

/* ------------------------------------------------------------------- events */

const EVENT_COPY = {
  loading: "Reading industry events…",
  unauthorized: "Your session has ended. Sign in again to read events.",
  unavailable: "Industry events could not be read. Check again when the connection returns.",
  empty: "No industry events are recorded yet.",
};
const KIND_LABEL = { conference: "Conference", association_meeting: "Association meeting", trade_show: "Trade show", networking: "Networking" };
const STATUS_LABEL = { planned: "Planned", attended: "Attended", skipped: "Skipped", cancelled: "Cancelled" };
const ATTENDANCE_LABEL = { considering: "Considering", plan_to_attend: "Plan to attend", not_attending: "Not attending" };
const eventWhen = (stamp) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(stamp));
const eventDay = (stamp) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(stamp));

function eventCard(row, index) {
  return `<li><button class="event-card" type="button" data-event-id="${escapeHtml(row.id)}" data-status="${escapeHtml(row.status)}" data-stagger-index="${index}">`
    + `<span class="event-date">${escapeHtml(eventWhen(row.starts_at))}</span>`
    + `<strong class="event-name">${escapeHtml(row.title)}</strong>`
    + `<span class="event-meta">${escapeHtml(KIND_LABEL[row.kind] || row.kind)} · ${escapeHtml(row.organizer || "Organizer not recorded")}</span>`
    + `<span class="event-meta">${escapeHtml(partnerName(row.owner_partner))} · ${escapeHtml(STATUS_LABEL[row.status] || row.status)} · ${escapeHtml(ATTENDANCE_LABEL[row.attendance_intent] || row.attendance_intent)}</span>`
    + `<span class="event-source">Source: ${escapeHtml(row.source)}</span>`
    + `</button></li>`;
}

function drawTimeline(rows) {
  const svg = $("eventTimelineSvg");
  if (!svg) return;
  const width = Math.max(320, rows.length * 126, svg.parentElement?.clientWidth - 24 || 0);
  svg.setAttribute("viewBox", `0 0 ${width} 118`);
  svg.style.width = `${width}px`;
  const track = `<path class="event-timeline-track" d="M24 57 H${width - 24}"/>`;
  const nodes = rows.map((row, index) => {
    const x = rows.length === 1 ? width / 2 : 54 + index * ((width - 108) / (rows.length - 1));
    const title = String(row.title).slice(0, 18);
    return `<g class="event-timeline-node" data-event-id="${escapeHtml(row.id)}" tabindex="0" role="button" aria-label="Edit ${escapeHtml(row.title)} on ${escapeHtml(eventDay(row.starts_at))}">`
      + `<circle class="event-timeline-glow" cx="${x}" cy="57" r="16" opacity=".16"/>`
      + `<circle cx="${x}" cy="57" r="8"/>`
      + `<text x="${x}" y="31">${escapeHtml(title)}</text>`
      + `<text class="event-timeline-date" x="${x}" y="87">${escapeHtml(eventDay(row.starts_at))}</text></g>`;
  }).join("");
  svg.innerHTML = track + nodes;
}

function renderEvents() {
  const { status, rows } = view.events;
  const phase = eventPhase({ status, rows });
  const block = $("eventState");
  if (block) {
    block.hidden = phase === "ready";
    block.setAttribute("data-state", phase);
    block.innerHTML = phase === "ready" ? "" : `<h3>${escapeHtml(EVENT_COPY[phase])}</h3>`
      + (phase === "unauthorized" ? `<a class="btn btn-primary" href="/auth/login?return_to=${encodeURIComponent(`${location.pathname}${location.search}`)}">Sign in</a>` : "");
  }
  const list = $("eventList");
  if (list) {
    list.innerHTML = phase === "ready" ? rows.map(eventCard).join("") : "";
    applyStagger(list, ".event-card");
  }
  drawTimeline(phase === "ready" ? rows : []);
  const source = $("eventSource");
  if (source) source.textContent = status === "ready"
    ? `${rows.length} event${rows.length === 1 ? "" : "s"} · Source: industry events · ${deploymentIdentity(client?.mode).detail}`
    : `Source: industry events · ${deploymentIdentity(client?.mode).detail}`;
  if (view.state.tab === "events") announce(phase === "ready" ? `${rows.length} industry events read.` : EVENT_COPY[phase]);
}

async function loadEvents() {
  const sequence = ++view.events.sequence;
  view.events.status = "loading";
  renderEvents();
  try {
    const read = eventReadState(await client.listIndustryEvents());
    if (sequence !== view.events.sequence) return;
    view.events.status = read.status;
    view.events.rows = read.rows;
  } catch (error) {
    if (sequence !== view.events.sequence) return;
    view.events.status = error?.status === 401 || error?.status === 403 ? "unauthorized" : "error";
    view.events.rows = [];
  }
  renderEvents();
}

function formValues() {
  const form = $("eventForm");
  const data = new FormData(form);
  return Object.fromEntries([...data.entries()].concat([["is_virtual", data.has("is_virtual")]]));
}

function fillEventForm(values) {
  const form = $("eventForm");
  if (!form) return;
  form.reset();
  for (const [name, value] of Object.entries(values)) {
    const input = form.elements.namedItem(name);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = value === true;
    else input.value = value ?? "";
  }
}

function showEventConflict(latest) {
  const panel = $("eventConflict");
  const changed = $("eventConflictFields");
  const button = $("eventUseLatest");
  if (!panel || !changed || !button) return;
  panel.hidden = false;
  view.events.latest = latest || null;
  button.hidden = !latest;
  if (!latest) { changed.innerHTML = '<dt>Read</dt><dd>The latest event could not be read.</dd>'; return; }
  const fields = eventChangedFields(view.events.original, latest);
  changed.innerHTML = fields.length ? fields.map(({ field, label, value }) => {
    const display = value === null ? "Not recorded" : field === "is_virtual" ? (value ? "Yes" : "No")
      : field === "starts_at" || field === "ends_at" ? eventWhen(value)
        : field === "owner_partner" ? partnerName(value) : String(value);
    return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(display)}</dd>`;
  }).join("") : '<dt>Version</dt><dd>The event version changed; no displayed field differs.</dd>';
}

function openEvent(id = null) {
  const row = id ? view.events.rows.find((event) => event.id === id) : null;
  if (id && !row) return;
  view.events.current = row ? { id: row.id, version: row.version } : null;
  const key = id || "new";
  const draft = view.events.draft?.key === key ? view.events.draft : null;
  if (draft?.base) view.events.current = draft.base;
  view.events.original = draft?.original || row;
  view.events.latest = null;
  const values = draft ? draft.values : row ? {
    ...row, starts_at: eventLocalDateTime(row.starts_at), ends_at: eventLocalDateTime(row.ends_at),
  } : { owner_partner: ["joe", "dell"].includes(client?.selfActor) ? client.selfActor : "" };
  fillEventForm(values);
  $("eventDialogTitle").textContent = row ? `Edit ${row.title}` : "Add event";
  $("eventFormMessage").textContent = "";
  $("eventConflict").hidden = true;
  $("eventSave").disabled = false;
  if (draft?.base && row && row.version !== draft.base.version) {
    showEventConflict(row);
    $("eventSave").disabled = true;
    $("eventFormMessage").textContent = "The event changed. Your draft is kept; review the changes below.";
  }
  const dialog = $("eventDialog");
  if (dialog && !dialog.open) dialog.showModal();
  $("eventTitle")?.focus();
}

function closeEvent({ discard = false } = {}) {
  if (discard) view.events.draft = null;
  const dialog = $("eventDialog");
  if (dialog?.open) dialog.close();
}

async function saveEvent(event) {
  event.preventDefault();
  const form = $("eventForm");
  if (!form?.reportValidity()) return;
  const values = formValues();
  const request = eventWriteRequest(values, view.events.current);
  const message = $("eventFormMessage");
  if (!request.ok) { message.textContent = request.error; return; }
  const key = view.events.current?.id || "new";
  view.events.draft = { key, values, base: view.events.current, original: view.events.original };
  const save = $("eventSave");
  save.disabled = true;
  message.textContent = "Saving…";
  try {
    const result = view.events.current
      ? await client.updateIndustryEvent(request.args) : await client.addIndustryEvent(request.args);
    if (result?.ok !== true || !result.event) throw new Error("Save outcome unavailable");
    view.events.draft = null;
    closeEvent();
    await loadEvents();
    const savedCard = [...document.querySelectorAll(".event-card")]
      .find((card) => card.dataset.eventId === result.event.id);
    (savedCard || $("eventAdd"))?.focus({ preventScroll: true });
    announce(`${result.event.title || "Event"} saved. Events refreshed from the record.`);
  } catch (error) {
    const outcome = eventWriteOutcome(error);
    message.textContent = {
      conflict: "This event changed since you opened it. Your draft is kept; review the changes below.",
      refused: "The event was not saved. Review the fields; your draft is kept.",
      unauthorized: "Your session has ended. Sign in again; your draft is kept on this page.",
      unknown: "The save outcome is unknown. Your draft is kept. Check the event list before trying again.",
    }[outcome];
    if (outcome === "conflict") {
      await loadEvents();
      showEventConflict(view.events.rows.find((row) => row.id === view.events.current?.id));
    }
    save.disabled = outcome === "conflict" || outcome === "unknown" || outcome === "unauthorized";
    announce(message.textContent);
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
  if (key === "events") renderEvents();
}

function wire() {
  tabs = wireTabs("ideaTabs");
  $("ideaTabs")?.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab-key]");
    if (tab && tab.dataset.tabKey !== view.state.tab) selectTab(tab.dataset.tabKey, { push: true });
  });
  $("ideaTabs")?.addEventListener("keydown", () => {
    const key = document.activeElement?.dataset?.tabKey;
    if (key && key !== view.state.tab) selectTab(key);
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
  $("eventRefresh")?.addEventListener("click", () => loadEvents());
  $("eventAdd")?.addEventListener("click", () => openEvent());
  $("eventList")?.addEventListener("click", (event) => {
    const card = event.target.closest("[data-event-id]");
    if (card) openEvent(card.dataset.eventId);
  });
  $("eventTimelineSvg")?.addEventListener("click", (event) => {
    const node = event.target.closest("[data-event-id]");
    if (node) openEvent(node.dataset.eventId);
  });
  $("eventTimelineSvg")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const node = event.target.closest("[data-event-id]");
    if (!node) return;
    event.preventDefault();
    openEvent(node.dataset.eventId);
  });
  for (const id of ["eventList", "eventTimelineSvg"]) {
    $(id)?.addEventListener("pointerover", (event) => {
      const row = event.target.closest("[data-event-id]");
      if (!row) return;
      document.querySelectorAll(".event-card, .event-timeline-node").forEach((node) =>
        node.setAttribute("data-active", String(node.dataset.eventId === row.dataset.eventId)));
    });
    $(id)?.addEventListener("pointerleave", () => {
      document.querySelectorAll(".event-card, .event-timeline-node").forEach((node) => node.removeAttribute("data-active"));
    });
  }
  $("eventForm")?.addEventListener("submit", saveEvent);
  $("eventForm")?.addEventListener("input", () => {
    view.events.draft = { key: view.events.current?.id || "new", values: formValues(),
      base: view.events.current, original: view.events.original };
  });
  $("eventUseLatest")?.addEventListener("click", () => {
    const latest = view.events.latest;
    if (!latest) return;
    view.events.current = { id: latest.id, version: latest.version };
    view.events.original = latest;
    view.events.draft = { key: latest.id, values: formValues(), base: view.events.current, original: latest };
    $("eventSave").disabled = false;
    $("eventFormMessage").textContent = "Your draft now uses the latest event version. Review it before saving.";
    $("eventSave").focus();
  });
  $("eventDialogClose")?.addEventListener("click", () => closeEvent());
  $("eventCancel")?.addEventListener("click", () => closeEvent({ discard: true }));
  window.addEventListener("resize", () => drawTimeline(view.events.status === "ready" ? view.events.rows : []));
  window.addEventListener("online", () => { load(); loadEvents(); });
  window.addEventListener("popstate", () => {
    const next = parseIdeasState(location.search);
    const previousIdea = view.state.idea;
    // The state moves first, so the dialog's close handler sees no open idea
    // and does not push a history entry of its own.
    view.state = next;
    if (search) search.value = next.q;
    tabs?.select(next.tab === "events" ? "tabEvents" : "tabIdeas");
    render();
    if (next.tab === "events") renderEvents();
    if (!next.idea) closeIdea();
    else if (next.idea !== previousIdea) openIdea(next.idea, { push: false });
  });
}

async function boot() {
  mountPrefs();
  mountDocDock("Ideas");
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
  await loadEvents();
  if (view.state.idea) openIdea(view.state.idea, { push: false });
}

boot();

export { view };
