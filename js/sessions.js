// V5-UX-S02 clauses 1-2 — the Sessions tab: DOM wiring only.
//
// Every decision about a payload is in ./sessions-model.js. This file reads,
// paints, and does nothing else. It writes nothing — both verbs on this surface
// are reads, and neither carries an idempotency key or an actor.
//
// The read is LAZY, like the Atlas tab: it fires on the first selection of this
// tab, never on page boot, so the Control Room's four dashboard reads keep their
// time-to-glance.
//
// There is no open control in this file. Search it for one: `open` appears only
// as `hostState().open`, which is false in every branch, and the drawer's
// <details> element, which reveals history that was already read. Opening a
// native session is S02 clause 3 and no adapter for it exists.
import {
  NO_OPEN_SENTENCE, countsLine, dispatchView, identityRequest, lineageSummary,
  listState, refuseDispatchHistory, refuseSessionIdentity, sessionCards,
} from "./sessions-model.js";
import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { formatClock } from "./visual-system.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

let mounted = false;
let client = null;
let debounce = null;

const view = {
  outage: null,
  status: "idle",
  sequence: 0,
  query: "",
  includeClosed: false,
  payload: null,
  refusal: null,
  /** canonical_session_id -> {state, payload|reason} for the open drawers. */
  history: new Map(),
};

function announce(text) {
  const live = $("sessionsLive");
  if (live && live.textContent !== text) live.textContent = text;
}

const clock = (value) => formatClock(value) || "unknown";

/* -------------------------------------------------------------------- painting */

function renderCounts() {
  const line = $("sessionsCounts");
  if (!line) return;
  const counts = countsLine(view.payload);
  line.textContent = counts.text;
  line.dataset.state = counts.seen === null ? "unavailable" : "read";
}

function renderBanner() {
  const banner = $("sessionsBanner");
  if (!banner) return;
  // Rendered from `permission_filtered` ALONE, so it appears over an empty list
  // exactly as it appears over a full one. That is the difference between
  // "nothing matched" and "nothing you may see matched".
  const state = listState(view.payload);
  if (!state.banner) {
    banner.hidden = true;
    banner.textContent = "";
    return;
  }
  banner.hidden = false;
  banner.textContent = state.banner.text;
}

function chip(label, value, state = "read") {
  return `<span class="chip" data-state="${escapeHtml(state)}">${escapeHtml(label)}: ${escapeHtml(value)}</span>`;
}

function cardHtml(card) {
  return `<article class="card glass session-card" data-session="${escapeHtml(card.id)}">
    <div class="session-head">
      <div class="session-identity">
        <h3>${escapeHtml(card.name)}</h3>
        <p class="mono session-id">${escapeHtml(card.id)}</p>
      </div>
      ${card.derivedName ? '<span class="chip" data-derived="true">derived name</span>' : ""}
    </div>
    <div class="chip-bar session-chips">
      ${chip("surface", card.surface)}
      ${chip("work state", card.workStateLabel, card.workState === "unknown" ? "unknown" : "read")}
      ${chip("observed", clock(card.observedAt))}
      ${chip("source", card.observationSource)}
    </div>
    <p class="session-evidence">${escapeHtml(card.evidence ?? "No observation is recorded behind this state.")}</p>
    <p class="session-lineage" data-relation="${escapeHtml(card.lineage.relation)}">${escapeHtml(card.lineage.text)}</p>
    <p class="session-attempts">${escapeHtml(card.attemptsText)}</p>
    <p class="session-host" data-host="${escapeHtml(card.host.state)}">${escapeHtml(card.host.text)}</p>
    ${card.projectAffinity || card.cwd || card.modelId ? `<p class="session-meta small">${[
      card.projectAffinity ? `project ${escapeHtml(card.projectAffinity)}` : null,
      card.cwd ? `cwd ${escapeHtml(card.cwd)}` : null,
      card.modelId ? `model ${escapeHtml(card.modelId)}` : null,
    ].filter(Boolean).join(" · ")}</p>` : ""}
    <details class="session-history" data-history="${escapeHtml(card.id)}">
      <summary>Dispatch history</summary>
      <div class="session-history-body" data-history-body="${escapeHtml(card.id)}">
        <p class="small">Not read yet.</p>
      </div>
    </details>
  </article>`;
}

function renderList() {
  const list = $("sessionsList");
  const empty = $("sessionsEmpty");
  const summary = $("sessionsLineageSummary");
  if (!list || !empty) return;
  if (view.status === "loading") {
    list.innerHTML = "";
    empty.hidden = false;
    empty.textContent = "Taking the read…";
    if (summary) summary.hidden = true;
    return;
  }
  if (view.refusal) {
    list.innerHTML = "";
    empty.hidden = false;
    empty.textContent = `The session read could not be rendered: ${view.refusal}.`;
    if (summary) summary.hidden = true;
    return;
  }
  const cards = sessionCards(view.payload);
  const state = listState(view.payload);
  list.innerHTML = cards.map(cardHtml).join("");
  empty.hidden = cards.length > 0;
  empty.textContent = state.message ?? "";
  const rows = Array.isArray(view.payload?.sessions) ? view.payload.sessions : [];
  const lineageText = lineageSummary(rows);
  if (summary) {
    summary.hidden = !lineageText.allUnrecorded;
    summary.textContent = lineageText.text ?? "";
  }
  for (const details of list.querySelectorAll("details[data-history]")) {
    details.addEventListener("toggle", () => {
      if (details.open) openHistory(details.dataset.history);
    });
  }
}

function historyHtml(id) {
  const entry = view.history.get(id);
  if (!entry) return '<p class="small">Not read yet.</p>';
  if (entry.state === "loading") return '<p class="small">Taking the read…</p>';
  if (entry.state === "unknown") {
    return `<p class="small">The dispatch read could not be rendered: ${escapeHtml(entry.reason)}.</p>`;
  }
  const drawer = dispatchView(entry.payload);
  const stages = `<p class="dispatch-stages">
    <span data-stage="sent">sent: recorded per event</span>
    <span data-stage="received" data-state="${escapeHtml(drawer.receivedState)}">received: ${escapeHtml(drawer.receivedState)}</span>
    <span data-stage="acknowledged" data-state="${escapeHtml(drawer.acknowledgedState)}">acknowledged: ${escapeHtml(drawer.acknowledgedState)}</span>
    <span data-stage="acted">acted: recorded per event</span>
  </p>`;
  const honesty = drawer.stageSentence
    ? `<p class="dispatch-honesty" data-reason="${escapeHtml(drawer.stageUnavailableReason)}">${escapeHtml(drawer.stageSentence)}</p>`
    : "";
  const emptyLine = drawer.emptySentence ? `<p class="dispatch-empty">${escapeHtml(drawer.emptySentence)}</p>` : "";
  const events = drawer.events.map((event) => `<li class="dispatch-event" data-stage="${escapeHtml(event.stage)}">
    <p class="dispatch-when">${escapeHtml(event.stage)} · ${escapeHtml(clock(event.at))}</p>
    <p class="dispatch-evidence">${escapeHtml(event.evidence ?? "no evidence recorded")}</p>
    ${event.rationale ? `<p class="dispatch-rationale">${escapeHtml(event.rationale)}</p>` : ""}
    <p class="small mono">${[
      event.fromSeat ? `from ${escapeHtml(event.fromSeat)}` : null,
      event.toSeat ? `to ${escapeHtml(event.toSeat)}` : null,
      event.workRequestRef ? `work request ${escapeHtml(event.workRequestRef)}` : null,
      event.supersededBy ? `superseded by ${escapeHtml(event.supersededBy)}` : null,
    ].filter(Boolean).join(" · ")}</p>
  </li>`).join("");
  const older = drawer.more
    ? `<button class="btn" type="button" data-older="${escapeHtml(id)}">Older dispatch events</button>`
    : "";
  return `${stages}${honesty}${emptyLine}<ul class="dispatch-list">${events}</ul>${older}`;
}

function renderHistory(id) {
  const body = document.querySelector(`[data-history-body="${CSS.escape(id)}"]`);
  if (!body) return;
  body.innerHTML = historyHtml(id);
  const older = body.querySelector("button[data-older]");
  if (older) {
    older.addEventListener("click", () => {
      const entry = view.history.get(id);
      readHistory(id, entry?.payload?.next_cursor ?? null);
    });
  }
}

function render() {
  renderCounts();
  renderBanner();
  renderList();
  for (const id of view.history.keys()) renderHistory(id);
}

/* --------------------------------------------------------------------- reading */

async function read() {
  const sequence = ++view.sequence;
  view.status = "loading";
  view.refusal = null;
  view.history.clear();
  render();
  try {
    const payload = await client.sessionIdentity(identityRequest({
      query: view.query, includeClosed: view.includeClosed,
    }));
    if (sequence !== view.sequence) return;
    const refusal = refuseSessionIdentity(payload);
    view.status = "ready";
    view.refusal = refusal;
    view.payload = refusal ? null : payload;
  } catch (error) {
    if (sequence !== view.sequence) return;
    view.status = "ready";
    view.payload = null;
    view.refusal = String(error?.payload?.error || error?.message || "the session read did not answer");
  }
  render();
  announce(view.refusal ? "The session read did not answer." : countsLine(view.payload).text);
}

function openHistory(id) {
  if (!id || view.history.has(id)) return;
  readHistory(id, null);
}

async function readHistory(id, cursor) {
  view.history.set(id, { state: "loading" });
  renderHistory(id);
  try {
    const args = { session_id: id };
    if (cursor) args.cursor = cursor;
    const payload = await client.dispatchHistory(args);
    const refusal = refuseDispatchHistory(payload);
    view.history.set(id, refusal ? { state: "unknown", reason: refusal } : { state: "read", payload });
  } catch (error) {
    view.history.set(id, {
      state: "unknown",
      reason: String(error?.payload?.error || error?.message || "the dispatch read did not answer"),
    });
  }
  renderHistory(id);
}

/* ------------------------------------------------------------------------ mount */

/** Mounted once, on demand. A second call is refused, as the Atlas mount is. */
export function mountSessions({ outage = null } = {}) {
  if (mounted) return;
  mounted = true;
  view.outage = outage;
  const sentence = $("sessionsNoOpen");
  // The permanent sentence is written from the model, so deleting it from the
  // page cannot leave a tab that quietly implies it can open something.
  if (sentence) sentence.textContent = NO_OPEN_SENTENCE;
  const lookup = $("sessionsLookup");
  if (lookup) {
    lookup.addEventListener("input", () => {
      // `query` is a SERVER filter. The browser re-reads rather than narrowing
      // what it already holds, so the page always shows what CARR returned.
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { view.query = lookup.value; read(); }, 250);
    });
  }
  $("sessionsIncludeClosed")?.addEventListener("change", (event) => {
    view.includeClosed = event.target.checked === true;
    read();
  });
  $("sessionsRetry")?.addEventListener("click", () => read());
  const location = globalThis.location || { hostname: "", search: "" };
  const resolved = resolveDealroomBoot(location);
  const boot = resolved.mode === "live"
    ? Promise.resolve(createLiveClient())
    : createFixtureClient({ ...resolved.options, ...(outage ? { outage } : {}) });
  Promise.resolve(boot).then((ready) => {
    client = ready;
    return read();
  });
}

export { view };
