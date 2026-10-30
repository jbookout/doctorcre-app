import {onDialogClosed} from './dialog-lifecycle.js';
import { pageDocContext, selectDocRecord, publishDocRead, setDocFilters, observeDocRead } from './doc-context.js';
import { mountAutoRefresh, updatedLabel } from "./auto-refresh.mjs";
// V5-UX-B04 — Ideas and Events: DOM wiring only.
//
// Every decision lives in ./ideas-model.js. This file reads the idea board,
// paints tiles, opens one idea from a FRESH read-loop, and keeps the tab, the
// search and the open idea in the address so Back returns to the same place.
// Events use CARR's sourced event verbs and keep unsaved form data on refusal.

import { createLiveClient } from "./live-client.js";
import { deploymentIdentity, resolveDealroomBoot } from "./boot-mode.js";
import { mountNotificationBadge, mountPrefs, wireTabs } from "./shell.js";
import { formatCalendarDate } from "./visual-system.js";
import { approach, localToday } from "./calendar-model.js";
import { partnerName } from "./task-records-model.js";
import {
  IDEA_BOARD_ARGS, filterIdeas, ideaDetailRows, ideaReadState, ideasHref, ideasPhase,
  normalizeIdea, parseIdeasState, validIdeaBoard, eventReadState, eventPhase,
  eventWriteRequest, eventWriteOutcome, eventLocalDateTime,
  eventChangedFields,
  EVENT_LIST_LIMIT,
} from "./ideas-model.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));
const SEARCH_DEBOUNCE_MS = 250;

const view = {
  state: parseIdeasState(globalThis.location?.search || ""),
  status: "loading",
  rows: [],
  sequence: 0,
  detailSequence: 0,
  events: { status: "loading", rows: [], sequence: 0, draft: null, current: null, original: null, latest: null, pending: new Map(), saving: false },
};

let client = null;
let tabs = null;
let searchTimer = null;
let ideaOpener = null;

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

function tileHtml(row) {
  const due = row.due_on ? approach({ day: row.due_on, settled: false }, localToday()) : null;
  const meta = [
    row.owner ? `<span>${escapeHtml(partnerName(row.owner))}</span>` : '<span>owner not recorded</span>',
    row.since_text ? `<span>${escapeHtml(row.since_text)}</span>` : "",
    due ? `<span><span class="cal-pulse" data-pulse="${due.pulse}" aria-hidden="true"></span> due ${escapeHtml(formatCalendarDate(row.due_on))} · ${escapeHtml(due.label)}</span>` : "",
  ].join("");
  return `<li><button class="idea-tile" type="button" data-idea="${escapeHtml(row.number)}">`
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

/** The second line of a state: what fills this space, or what to do next. */
const STATE_HINT = {
  empty: "An idea parked from a meeting or a chat with Dr. CRE lands here for both partners.",
  no_match: "Search reads the idea, its number and its owner. Clear the search to see every idea.",
  unavailable: "Refresh to read the board again.",
};

function render() {
  const shown = filterIdeas(view.rows, view.state.q);
  if (view.state.tab === 'ideas') {
    setDocFilters({query:view.state.q});
    if (view.status === 'ready' && view.payload) publishDocRead('loopBoard',{loops:view.payload.loops.filter(row=>shown.some(item=>String(row.number)===item.number))});
  }
  const phase = ideasPhase({ status: view.status, rows: view.rows, shown });
  if (phase === "loading") setStatus("refreshing", "Updating…");
  else if (phase === "unauthorized") setStatus("unknown", "Session ended");
  else if (phase === "unavailable") setStatus("urgent", "Unavailable");
  else setStatus("healthy", "Current");

  const block = $("ideaState");
  if (block) {
    const visible = phase !== "ready";
    block.hidden = !visible;
    block.setAttribute("data-state", phase === "unauthorized" ? "no_access" : phase === "unavailable" ? "offline" : phase);
    const signIn = phase === "unauthorized"
      ? ` <a class="btn btn-primary" href="/auth/login?return_to=${encodeURIComponent(`${location.pathname}${location.search}`)}">Sign in</a>` : "";
    const hint = STATE_HINT[phase] ? `<p class="state-hint">${escapeHtml(STATE_HINT[phase])}</p>` : "";
    block.innerHTML = visible ? `<h3>${escapeHtml(STATE_COPY[phase])}</h3>${hint}${signIn}` : "";
  }
  const list = $("ideaList");
  if (list) {
    const focused = document.activeElement;
    const number = list.contains(focused) ? focused.dataset.idea : null;
    list.innerHTML = phase === "ready" ? shown.map(tileHtml).join("") : "";
    const current = document.activeElement;
    if (number && (!current || current === document.body || !current.isConnected)) {
      const tile = [...list.querySelectorAll('.idea-tile')].find(node => node.dataset.idea === number);
      (tile || $("ideaSearch"))?.focus({ preventScroll: true });
    }
  }
  const asOf = $("ideaAsOf");
  if (asOf && view.status === "ready") asOf.textContent = updatedLabel(view.updatedAt);
  const source = $("ideaSource");
  if (source) source.textContent = "";
  if (phase === "ready" || phase === "no_match") {
    announce(`${shown.length} of ${view.rows.length} idea${view.rows.length === 1 ? "" : "s"} shown.`);
  }
}

/* ------------------------------------------------------------------- events */

const EVENT_COPY = {
  loading: "Reading industry events…",
  unauthorized: "Your session has ended. Sign in again to read events.",
  unavailable: "Events temporarily unavailable",
  empty: "No industry events are recorded yet.",
  partial: `Showing the first ${EVENT_LIST_LIMIT} events by date. More may be recorded in CARR.`,
};
const KIND_LABEL = { conference: "Conference", association_meeting: "Association meeting", trade_show: "Trade show", networking: "Networking" };
const STATUS_LABEL = { planned: "Planned", attended: "Attended", skipped: "Skipped", cancelled: "Cancelled" };
const ATTENDANCE_LABEL = { considering: "Considering", plan_to_attend: "Plan to attend", not_attending: "Not attending" };
const eventWhen = (stamp) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(stamp));
const eventDay = (stamp) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(stamp));

function eventCard(row) {
  return `<li><button class="event-card" type="button" data-event-id="${escapeHtml(row.id)}" data-status="${escapeHtml(row.status)}">`
    + `<span class="event-date">${escapeHtml(eventWhen(row.starts_at))}</span>`
    + `<strong class="event-name">${escapeHtml(row.title)}</strong>`
    + `<span class="event-meta">${escapeHtml(KIND_LABEL[row.kind] || row.kind)} · ${escapeHtml(row.organizer || "Organizer not recorded")}</span>`
    + `<span class="event-meta">${escapeHtml(partnerName(row.owner_partner))} · ${escapeHtml(STATUS_LABEL[row.status] || row.status)} · ${escapeHtml(ATTENDANCE_LABEL[row.attendance_intent] || row.attendance_intent)}</span>`
    + ``
    + `</button></li>`;
}

function drawTimeline(rows) {
  const svg = $("eventTimelineSvg");
  if (!svg) return;
  svg.parentElement?.setAttribute("data-empty", rows.length ? "false" : "true");
  const width = Math.max(320, rows.length * 126, svg.parentElement?.clientWidth - 24 || 0);
  svg.setAttribute("viewBox", `0 0 ${width} 118`);
  svg.setAttribute("width", String(width));
  const track = `<path class="event-timeline-track" d="M24 57 H${width - 24}"/>`;
  const nodes = rows.map((row, index) => {
    const x = rows.length === 1 ? width / 2 : 54 + index * ((width - 108) / (rows.length - 1));
    const title = String(row.title).slice(0, 18);
    return `<g class="event-timeline-node" data-event-id="${escapeHtml(row.id)}" tabindex="0" role="button" aria-label="Edit ${escapeHtml(row.title)} on ${escapeHtml(eventDay(row.starts_at))}">`
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
      + (phase === "empty" ? '<p class="state-hint">Add a conference or association meeting with its source, and it shows on the timeline.</p>' : "")
      + (phase === "unauthorized" ? `<a class="btn btn-primary" href="/auth/login?return_to=${encodeURIComponent(`${location.pathname}${location.search}`)}">Sign in</a>` : "");
  }
  const list = $("eventList");
  if (list) {
    list.innerHTML = phase === "ready" || phase === "partial" ? rows.map(eventCard).join("") : "";
  }
  drawTimeline(phase === "ready" || phase === "partial" ? rows : []);
  const source = $("eventSource");
  if (source) source.textContent = status === "ready" || status === "partial"
    ? updatedLabel(view.events.updatedAt)
    : "Updating…";
  if (view.state.tab === "events") announce(phase === "ready" ? `${rows.length} events`
    : phase === "partial" ? EVENT_COPY.partial : EVENT_COPY[phase]);
}

function invalidateAuthorization(error) {
  if (![401,403].includes(error?.status) && error?.code !== 'authentication_required') return false;
  pageDocContext?.clear(); ++view.sequence; ++view.events.sequence; ++view.detailSequence;
  view.status = 'unauthorized'; view.rows = []; view.payload = null;
  view.events.status = 'unauthorized'; view.events.rows = []; view.events.payload = null;
  closeIdea(); closeEvent(); render(); renderEvents(); return true;
}

async function loadEvents() {
  const sequence = ++view.events.sequence;
  const ticket=view.state.tab === 'events' ? pageDocContext?.begin('listIndustryEvents') : null;
  view.events.status = "loading";
  renderEvents();
  try {
    const payload=await client.listIndustryEvents({limit:EVENT_LIST_LIMIT});
    const read = eventReadState(payload);
    view.events.payload=payload;
    if (sequence !== view.events.sequence) return;
    view.events.status = read.status;
    view.events.rows = read.rows;
  } catch (error) {
    if (sequence !== view.events.sequence) return;
    if (invalidateAuthorization(error)) return;
    pageDocContext?.fail(ticket,error);
    view.events.status = error?.status === 401 || error?.status === 403 ? "unauthorized" : "error";
    view.events.rows = [];
  }
  if (view.events.status === "ready" || view.events.status === "partial") view.events.updatedAt = new Date().toISOString();
  if (["ready","partial"].includes(view.events.status)) pageDocContext?.finish(ticket,view.events.payload,{at:Date.parse(view.events.updatedAt)}); else pageDocContext?.fail(ticket);
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
  selectDocRecord(row ? 'event' : null, row?.id);
  view.events.current = row ? { id: row.id, version: row.version } : null;
  const key = id || "new";
  const pending = view.events.pending.get(key);
  const draft = pending?.draft || (view.events.draft?.key === key ? view.events.draft : null);
  if (draft?.base) view.events.current = draft.base;
  view.events.original = draft?.original || row;
  view.events.latest = null;
  const values = draft ? draft.values : row ? {
    ...row, starts_at: eventLocalDateTime(row.starts_at), ends_at: eventLocalDateTime(row.ends_at),
  } : { owner_partner: ["joe", "dell"].includes(client?.selfActor) ? client.selfActor : "" };
  fillEventForm(values);
  for (const input of $("eventForm").querySelectorAll("input,select,textarea")) input.disabled = Boolean(pending);
  $("eventDialogTitle").textContent = row ? `Edit ${row.title}` : "Add event";
  $("eventFormMessage").textContent = "";
  $("eventConflict").hidden = true;
  $("eventSave").disabled = false;
  $("eventSave").textContent = pending ? "Check outcome" : "Save event";
  if (pending) $("eventFormMessage").textContent = "Save outcome unknown. Check outcome replays your original request.";
  if (!pending && draft?.base && row && row.version !== draft.base.version) {
    showEventConflict(row);
    $("eventSave").disabled = true;
    $("eventFormMessage").textContent = "The event changed. Your draft is kept; review the changes below.";
  }
  const dialog = $("eventDialog");
  if (dialog && !dialog.open) dialog.showModal();
  $("eventTitle")?.focus();
}

function closeEvent({ discard = false } = {}) {
  selectDocRecord(null,null);
  if (discard && !view.events.pending.has(view.events.current?.id || "new")) view.events.draft = null;
  const dialog = $("eventDialog");
  if (dialog?.open) dialog.close();
}

async function saveEvent(event) {
  event.preventDefault();
  if (view.events.saving) return;
  const form = $("eventForm");
  const key = view.events.current?.id || "new";
  const retained = view.events.pending.get(key);
  if (!retained && !form?.reportValidity()) return;
  const values = retained?.draft.values || formValues();
  const request = retained ? { ok: true, args: retained.args } : eventWriteRequest(values, view.events.current);
  const message = $("eventFormMessage");
  if (!request.ok) { message.textContent = request.error; return; }
  view.events.draft = retained?.draft || { key, values, base: view.events.current, original: view.events.original };
  const save = $("eventSave");
  view.events.saving = true;
  save.disabled = true;
  message.textContent = "Saving…";
  let attempted = false;
  try {
    if (!retained && view.events.current) {
      const read = eventReadState(await client.listIndustryEvents({ limit: EVENT_LIST_LIMIT }));
      if (!["ready", "partial"].includes(read.status)) throw new Error("Current event unavailable");
      const latest = read.rows.find(row => row.id === key);
      if (!latest || latest.version !== request.args.base_version) {
        showEventConflict(latest);
        message.textContent = "This event changed. Your draft is kept; review the current record below before saving.";
        return;
      }
    }
    const operation = retained || { args: Object.freeze({ ...request.args, idempotency_key: crypto.randomUUID() }), draft: view.events.draft };
    view.events.pending.set(key, operation);
    for (const input of form.querySelectorAll("input,select,textarea")) input.disabled = true;
    attempted = true;
    const result = view.events.current
      ? await client.updateIndustryEvent(operation.args) : await client.addIndustryEvent(operation.args);
    if (result?.ok !== true || !result.event) throw new Error("Save outcome unavailable");
    view.events.pending.delete(key);
    view.events.draft = null;
    closeEvent();
    await loadEvents();
    const savedCard = [...document.querySelectorAll(".event-card")]
      .find((card) => card.dataset.eventId === result.event.id);
    const focused = document.activeElement;
    if (view.state.tab === 'events' && (!focused || focused === document.body || !focused.isConnected)) {
      (savedCard || $("eventAdd"))?.focus({ preventScroll: true });
    }
    announce(`${result.event.title || "Event"} saved. Events refreshed from the record.`);
  } catch (error) {
    if (!attempted && !retained) {
      message.textContent = "Event not sent. Its current record could not be verified. Your draft is kept; try saving again after the read recovers.";
      for (const input of form.querySelectorAll("input,select,textarea")) input.disabled = false;
      save.textContent = "Save event"; save.disabled = false;
      announce(message.textContent);
      return;
    }
    // A refusal of this replay's transport/session does not establish whether
    // the original write committed. The client can also identify an exact
    // retained request when its own outcome classifier remains uncertain.
    const unresolved = error.pendingRequest || (retained &&
      ([401, 403, 408, 429].includes(error.status) || error.status >= 500 || error.payload?.error === "offline"));
    const outcome = unresolved ? "unknown" : eventWriteOutcome(error);
    if (error.pendingRequest) {
      const operation = view.events.pending.get(key) || retained;
      view.events.pending.set(key, { args: Object.freeze({ ...error.pendingRequest }), draft: operation?.draft || view.events.draft });
    }
    if (outcome !== "unknown") view.events.pending.delete(key);
    message.textContent = {
      conflict: "This event changed since you opened it. Your draft is kept; review the changes below.",
      refused: "The event was not saved. Review the fields; your draft is kept.",
      unauthorized: "Your session has ended. Sign in again; your draft is kept on this page.",
      unknown: "The save outcome is unknown. Your draft and request are kept. Check outcome to confirm the same save.",
    }[outcome];
    if (outcome === "conflict") {
      await loadEvents();
      showEventConflict(view.events.rows.find((row) => row.id === view.events.current?.id));
    }
    const pending = view.events.pending.has(key);
    for (const input of form.querySelectorAll("input,select,textarea")) input.disabled = pending;
    save.textContent = pending ? "Check outcome" : "Save event";
    save.disabled = outcome === "conflict" || outcome === "unauthorized";
    announce(message.textContent);
  } finally { view.events.saving = false; }
}

/* ------------------------------------------------------------------- detail */

async function openIdea(number, { push = true } = {}) {
  ideaOpener = number;
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
    const payload=await observeDocRead('readLoop',[{number,kind:'idea'}],()=>client.readLoop({number,kind:'idea'}));
    read = ideaReadState(payload);
  } catch (error) {
    if (invalidateAuthorization(error)) return;
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
  selectDocRecord('loop', loop.loop_id || loop.number);
  if (title) title.textContent = loop.title || row?.label || `Idea #${number}`;
  const rows = ideaDetailRows(loop)
    .map((field) => `<dt>${escapeHtml(field.label)}</dt><dd${field.known ? "" : ' class="unknown"'}>${escapeHtml(field.text)}</dd>`).join("");
  const text = typeof loop.body === "string" && loop.body.trim() ? loop.body : null;
  body.innerHTML = `<dl class="idea-rows">${rows}</dl>`
    + (text ? `<p class="idea-body">${escapeHtml(text)}</p>` : '<p class="small">No description is recorded on this idea.</p>');
  announce(`Idea #${number} opened.`);
}

function closeIdea() {
  selectDocRecord(null, null);
  const dialog = $("ideaDialog");
  if (dialog?.open) dialog.close();
}

/* ------------------------------------------------------------------ reading */

async function load() {
  const sequence = ++view.sequence;
  const ticket=view.state.tab === 'ideas' ? pageDocContext?.begin('loopBoard',[IDEA_BOARD_ARGS]) : null;
  if (view.status !== "ready") { view.status = "loading"; render(); }
  try {
    const payload = await client.loopBoard(IDEA_BOARD_ARGS);
    if (sequence !== view.sequence) return;
    if (!validIdeaBoard(payload)) {
      view.status = "error";
    } else {
      view.payload = payload;
      view.rows = payload.loops.map(normalizeIdea).filter(Boolean);
      view.status = "ready";
    }
  } catch (error) {
    if (sequence !== view.sequence) return;
    if (invalidateAuthorization(error)) return;
    pageDocContext?.fail(ticket,error);
    view.status = error?.status === 401 || error?.status === 403 ? "unauthorized" : "error";
    view.rows = [];
  }
  if (view.status === 'ready') { view.updatedAt = new Date().toISOString(); pageDocContext?.finish(ticket,view.payload,{at:Date.parse(view.updatedAt)}); }
  else pageDocContext?.fail(ticket);
  render();
}

/* ------------------------------------------------------------------- wiring */

function selectTab(key, { push = false } = {}) {
  pageDocContext?.navigate(key === 'events' ? 'events' : 'ideas', {query:view.state.q});
  view.state = { ...view.state, tab: key };
  tabs?.select(key === "events" ? "tabEvents" : "tabIdeas");
  remember({ push });
  closeIdea();
  if (key === 'events') {
    renderEvents();
    if (['ready','partial'].includes(view.events.status)) pageDocContext?.finish(pageDocContext.begin('listIndustryEvents'),view.events.payload,{at:Date.parse(view.events.updatedAt)});
    else if (client) loadEvents();
  } else {
    if (view.status === 'ready') pageDocContext?.finish(pageDocContext.begin('loopBoard',[IDEA_BOARD_ARGS]),view.payload,{at:Date.parse(view.updatedAt)});
    else if (client) load();
    render();
  }
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
        closeIdea();
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

  $("ideaDialogClose")?.addEventListener("click", closeIdea);
  onDialogClosed($("ideaDialog"), () => {
    selectDocRecord(null,null); pageDocContext?.release('readLoop');
    view.detailSequence += 1;
    if (view.state.idea) { view.state = { ...view.state, idea: null }; remember({ push: true }); }
    const focused = document.activeElement;
    if ($("ideaDialog").contains(focused)) focused.blur();
    const current = document.activeElement;
    if (view.state.tab === 'ideas' && (!current || current === document.body || !current.isConnected)) {
      const tile = [...document.querySelectorAll('.idea-tile')].find(node => node.dataset.idea === ideaOpener);
      (tile || $("ideaSearch"))?.focus({ preventScroll: true });
    }
    ideaOpener = null;
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
    if (view.events.pending.has(view.events.current?.id || "new")) return;
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
  onDialogClosed($("eventDialog"), () => selectDocRecord(null,null));
  $("eventDialogClose")?.addEventListener("click", () => closeEvent());
  $("eventCancel")?.addEventListener("click", () => closeEvent({ discard: true }));
  window.addEventListener("pagehide", () => { pageDocContext?.clear(); closeIdea(); closeEvent(); });
  window.addEventListener("resize", () => drawTimeline(["ready", "partial"].includes(view.events.status) ? view.events.rows : []));
  window.addEventListener("online", () => { load(); loadEvents(); });
  window.addEventListener("popstate", () => {
    const next = parseIdeasState(location.search);
    const previousIdea = view.state.idea;
    // The state moves first, so the dialog's close handler sees no open idea
    // and does not push a history entry of its own.
    view.state = next;
    if (search) search.value = next.q;
    selectTab(next.tab);
    if (!next.idea) closeIdea();
    else if (next.idea !== previousIdea) openIdea(next.idea, { push: false });
  });
}

async function boot() {
  // Read before remember() rewrites the address to the page's own state.
  const reactHost = new URLSearchParams(globalThis.location?.search || "").get("ui") === "react";
  const resolved = resolveDealroomBoot(globalThis.location || { hostname: "", search: "" });
  mountPrefs();

  wire();
  // The markup opens on Ideas; only a remembered Events tab moves it, so a
  // plain visit never steals focus into the tab strip.
  if (view.state.tab === "events") selectTab("events");
  remember();
  render();
  // The inner Ideas host stays fixture-only; the partner workspace owns the live flag.
  if (resolved.mode === "fixture" && reactHost && (!resolved.options.selfActor || ["joe", "dell"].includes(resolved.options.selfActor))) import("./ui.generated.js").then(({ hostNode }) => hostNode($("ideasPanel")));
  client = resolved.mode === "live" ? createLiveClient({docContext:false}) : await (await import("./fixture-client.js")).createFixtureClient({...resolved.options,docContext:false});
  mountNotificationBadge(client);
  mountAutoRefresh({ document, window: globalThis.window, refresh: async () => { await load(); await loadEvents(); } });
  await load();
  await loadEvents();
  if (view.state.idea) openIdea(view.state.idea, { push: false });
}

boot();

export { view };
