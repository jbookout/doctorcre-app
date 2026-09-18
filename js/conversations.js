// V5-UX-B07 — the Doc conversations page: DOM wiring only.
//
// Every decision about a payload, a state or a sentence lives in
// ./conversations-model.js, and every decision about what a command DID lives
// in the shared kernel (./command-feedback.mjs) and its dock. This file reads,
// paints, and sends exactly three writes.
//
// Five shapes govern the file:
//
//   1. THE RECORD LAYER IS THE AUTHORITY FOR EVERY WORD ON THE LIST. This
//      device remembers conversation IDS and nothing else; each card's title,
//      visibility, pin and archive state comes from a fresh read. An id that
//      answers `doc_conversation_not_found` is dropped from the roster, because
//      that is exactly what a revoked grant looks like from the grantee's side
//      and keeping the stale title would be the disclosure the store refuses.
//   2. `visible_conversation_count` is PRINTED from the payload. The roster
//      length is a different number with a different meaning, and the page
//      says both rather than reconciling them into one.
//   3. Each read stamps its OWN clock, and a read that answers after a newer
//      one was issued is IGNORED — the `view.sequence` guard. The server's
//      prose never reaches the page: only its STATUS and its CODE cross.
//   4. Every write goes through performCommand with ONE operation key per
//      intent per subject, and the kernel mints and retains the idempotency
//      key. An unknown outcome keeps its entry so "Check outcome" re-sends the
//      SAME frozen request — which matters most for create, where the key
//      becomes the conversation id and a second key is a second conversation.
//   5. A `version_conflict` is never retried automatically and never answered
//      with the version the refusal carried. The page re-reads, which is the
//      only source of the new version, and asks the person to press again.
import { createCommandDock } from "./command-dock.js";
import { createCommandState, performCommand } from "./command-feedback.mjs";
import { createFixtureClient } from "./fixture-client.js";
import { createLiveClient } from "./live-client.js";
import { resolveDealroomBoot } from "./boot-mode.js";
import { mountDocDock, mountPrefs } from "./shell.js";
import { formatClock } from "./visual-system.js";
import {
  COMPOSER_ABSENT, DOC_REPLY_PENDING, EXPOSURE_STATEMENT, PARTNER_SLUGS, ROSTER_EMPTY,
  ROSTER_SCOPE, SHARING_CAVEAT, TITLE_HISTORY_UNREADABLE,
  accessRows, archiveOperationKey, classifyReadFailure, conversationState, createArgs,
  createOperationKey, idFromSearch, identityHeader, pagingState, pinOperationKey,
  readRoster, renameArgs, renameOperationKey, rosterCard, rosterRows, shareArgs,
  shareCandidates, shareOperationKey, turnRows, visibleCountLine, writeRoster,
} from "./conversations-model.js";
import { uuidv4 } from "./uuid.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

/** The page of turns this page asks for. */
const LIMIT = 50;

/** One place holds what this page believes; nothing else keeps a copy. */
const view = {
  route: { state: "missing", id: null, given: null },
  sequence: 0,
  conversation: { state: "pending" },
  roster: [],
  cards: [],
  showArchived: false,
};

let client = null;
let commandState = createCommandState();
let dock = { record: () => {}, mount: () => {}, render: () => {} };
/** What each open operation would send again: the dock's buttons need it. */
const operations = new Map();

const storage = () => {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
};

function announce(text) {
  const live = $("conversationLive");
  if (live && text && live.textContent !== text) live.textContent = text;
}

const asOf = (read) => (read?.state === "read" && formatClock(read.observed_at)
  ? `As of ${formatClock(read.observed_at)}`
  : "unknown");

const payloadOf = () => (view.conversation.state === "read" ? view.conversation.payload : null);

/* -------------------------------------------------------------------- painting */

function renderHero() {
  const payload = payloadOf();
  $("conversationAsOf").textContent = asOf(view.conversation);
  const header = identityHeader(payload);
  const badge = $("visibilityBadge");
  if (!header) {
    $("pageTitle").textContent = "Conversations";
    $("conversationId").textContent = view.route.given || "no conversation open";
    badge.setAttribute("data-visibility", "none");
    $("visibilityGlyph").textContent = "🔒";
    $("visibilityWord").textContent = "No conversation is open";
    $("heroFacts").innerHTML = "";
    return;
  }
  $("pageTitle").textContent = header.title;
  $("conversationId").textContent = header.id;
  badge.setAttribute("data-visibility", header.visibility);
  $("visibilityGlyph").textContent = header.glyph;
  $("visibilityWord").textContent = header.word;
  const facts = [
    `Version ${header.version}`,
    `Created by ${header.createdBy}`,
    header.pinned ? `Pinned at ${header.pinnedClock}` : "Not pinned",
    header.archived ? `Archived at ${header.archivedClock}` : "Not archived",
  ];
  $("heroFacts").innerHTML = facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("");
}

function renderTurns() {
  const payload = payloadOf();
  const state = conversationState(view.conversation, view.route);
  const block = $("turnsState");
  block.setAttribute("data-state", state.state);
  $("turnsStateTitle").textContent = state.sentence || "";
  block.hidden = state.state === "ready";
  $("conversationOrb").setAttribute(
    "data-state",
    state.state === "ready" || state.state === "empty" ? "healthy"
      : ["refused", "unavailable", "not_found", "malformed"].includes(state.state) ? "urgent" : "still",
  );
  $("turnList").innerHTML = turnRows(payload).map((turn) => `<li class="turn" data-role="${escapeHtml(turn.role)}" data-sequence="${turn.sequence}">
    <div class="turn-top"><span class="turn-role">${escapeHtml(turn.role)}</span><span>${escapeHtml(turn.clock)}</span></div>
    <p class="turn-body">${escapeHtml(turn.body)}</p>
  </li>`).join("");
  const paging = pagingState(payload);
  $("pagingBlock").hidden = !paging.more;
}

function renderAccess() {
  const payload = payloadOf();
  const rows = accessRows(payload);
  $("accessList").innerHTML = rows.map((row) => `<li class="work-item" data-priority="ordinary" data-grantee="${escapeHtml(row.grantee)}">
    <div><h3 class="access-row">${escapeHtml(row.grantee)}</h3>
    <div class="work-meta"><span>granted by ${escapeHtml(row.grantedBy)} · ${escapeHtml(row.clock)}</span></div></div>
    <div class="stack-end"></div>
  </li>`).join("") || (payload
    ? `<li class="work-item" data-priority="ordinary"><div><h3 class="access-row">Nobody else can read this conversation</h3><div class="work-meta"><span>read from the record layer</span></div></div><div class="stack-end"></div></li>`
    : "");
  $("shareControls").innerHTML = shareCandidates(payload, PARTNER_SLUGS).map((row) => `<button class="btn share-toggle" type="button" data-share="${escapeHtml(row.slug)}" aria-pressed="${row.granted}">${row.granted ? "Shared with" : "Not shared with"} ${escapeHtml(row.slug)}</button>`).join("");
  const header = identityHeader(payload);
  $("pinToggle").setAttribute("aria-pressed", header ? String(header.pinned) : "false");
  $("pinToggle").textContent = header?.pinned ? "Unpin this conversation" : "Pin this conversation";
  $("archiveToggle").setAttribute("aria-pressed", header ? String(header.archived) : "false");
  $("archiveToggle").textContent = header?.archived ? "Take this out of the archive" : "Archive this conversation";
}

function renderRoster() {
  const payload = payloadOf();
  $("visibleCountLine").textContent = visibleCountLine(payload, view.roster.length);
  const { live, archived, archivedCount } = rosterRows(view.cards, { showArchived: view.showArchived });
  const rowHtml = (row) => `<li class="work-item" data-priority="${row.pinned ? "deadline" : "ordinary"}" data-conversation="${escapeHtml(row.id)}" data-visibility="${escapeHtml(row.visibility)}">
    <div>
      <h3 class="roster-title">${escapeHtml(row.title)}</h3>
      <p class="roster-meta">${escapeHtml(row.visibility === "shared" ? "shared" : "private")}${row.pinned ? " · pinned" : ""}${row.archived ? " · archived" : ""} · <span class="mono">${escapeHtml(row.id)}</span></p>
      <div class="roster-open"><button class="btn" type="button" data-open="${escapeHtml(row.id)}">Open this conversation</button></div>
    </div>
  </li>`;
  $("rosterList").innerHTML = live.map(rowHtml).join("");
  const archivedList = $("archivedList");
  archivedList.hidden = !view.showArchived;
  archivedList.innerHTML = archived.map(rowHtml).join("");
  $("archivedToggle").setAttribute("aria-pressed", String(view.showArchived));
  $("archivedToggle").textContent = view.showArchived
    ? `Hide the ${archivedCount} archived`
    : `Show archived (${archivedCount})`;
  const block = $("rosterState");
  const bare = live.length === 0 && archived.length === 0;
  block.hidden = !bare;
  $("rosterStateTitle").textContent = bare ? ROSTER_EMPTY : "";
}

function render() {
  renderHero();
  renderTurns();
  renderAccess();
  renderRoster();
}

/* --------------------------------------------------------------------- reading */

/**
 * One read, settled on its own. A failure is classified from its STATUS and its
 * CODE, and a read that lands after a newer one was issued is discarded — the
 * page paints the latest picture it asked for, never the last one that arrived.
 */
async function takeConversation({ after = null } = {}) {
  if (view.route.state !== "ok") {
    view.conversation = view.route.state === "malformed" ? { state: "malformed" } : { state: "pending" };
    render();
    return;
  }
  const sequence = view.sequence;
  const held = payloadOf();
  if (view.conversation.state === "read") view.conversation = { ...view.conversation, refreshing: true };
  render();
  try {
    const args = { conversation_id: view.route.id, limit: LIMIT };
    if (Number.isInteger(after)) args.after_sequence = after;
    const payload = await client.readDocConversation(args);
    if (view.sequence !== sequence) return;
    // Paging APPENDS; the server's order is kept and nothing is re-sorted.
    const merged = (Number.isInteger(after) && held)
      ? { ...payload, turns: [...held.turns, ...payload.turns] }
      : payload;
    view.conversation = { state: "read", payload: merged, observed_at: new Date().toISOString() };
    rememberCard(merged);
  } catch (error) {
    if (view.sequence !== sequence) return;
    const failure = classifyReadFailure(error);
    view.conversation = { state: failure.state, sentence: failure.sentence };
    if (failure.state === "not_found") forget(view.route.id);
  }
  render();
}

/** The roster's own read: one card per remembered id, every refusal survived. */
async function takeRoster() {
  const sequence = view.sequence;
  const ids = readRoster(storage());
  const settled = await Promise.allSettled(
    ids.map((id) => client.readDocConversation({ conversation_id: id, limit: 1 })),
  );
  if (view.sequence !== sequence) return;
  const cards = [];
  const kept = [];
  settled.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    const card = rosterCard(result.value);
    if (!card) return;
    cards.push(card);
    kept.push(ids[index]);
  });
  view.cards = cards;
  view.roster = writeRoster(storage(), kept);
  render();
}

function rememberCard(payload) {
  const card = rosterCard(payload);
  if (!card) return;
  view.roster = writeRoster(storage(), [card.id, ...view.roster]);
  view.cards = [card, ...view.cards.filter((row) => row.id !== card.id)];
}

function forget(id) {
  view.roster = writeRoster(storage(), view.roster.filter((row) => row !== id));
  view.cards = view.cards.filter((row) => row.id !== id);
}

async function load() {
  view.sequence += 1;
  await Promise.all([takeConversation(), takeRoster()]);
  const state = conversationState(view.conversation, view.route);
  announce(state.sentence || visibleCountLine(payloadOf(), view.roster.length));
}

/** Opening one sets `?id=` so Back restores the list this page came from. */
function open(id) {
  const route = idFromSearch(`?id=${id}`);
  view.route = route;
  view.conversation = { state: "pending" };
  try {
    globalThis.history?.pushState?.({ id }, "", `/conversations?id=${id}`);
  } catch {
    // A host that refuses history keeps the page; only the address bar lags.
  }
  load();
}

/* --------------------------------------------------------------------- writing */

async function dispatch(operationKey, args, summary, send) {
  const result = await performCommand({
    operationKey,
    args,
    getState: () => commandState,
    setState: (next) => { commandState = next; },
    newKey: uuidv4,
    call: (request) => send(request),
  });
  operations.set(operationKey, { args, summary, send });
  dock.record(operationKey, {
    summary, status: result.status, reason: result.message || null,
    retry: result.retry, undo: false, request: result.request,
  });
  if (result.message) announce(result.message);
  // Only the record layer knows what the store now holds, so a settled write
  // re-reads it rather than painting the answer this page hoped for.
  //
  // A conflict re-reads for exactly the same reason and for one more: the
  // re-read is the ONLY source of the version the next attempt may carry. The
  // version the refusal named is evidence that something moved, and using it
  // as the next base would overwrite whatever moved it.
  if (result.status === "ok" || result.status === "conflict") {
    if (result.status === "ok" && operationKey === createOperationKey() && result.response?.conversation_id) {
      open(result.response.conversation_id);
      return result;
    }
    await load();
  }
  return result;
}

function send(operationKey, built, summary, call) {
  if (!built.ok) {
    announce(built.message);
    dock.record(operationKey, { summary, status: "refused", reason: built.message, undo: false });
    return;
  }
  dock.record(operationKey, { summary, status: "sending", undo: false });
  dispatch(operationKey, built.args, summary, call);
}

function create() {
  const built = createArgs({
    title: $("createTitleInput")?.value,
    visibility: $("createVisibility")?.value,
  });
  send(createOperationKey(), built, `Create the conversation "${built.args?.title || ""}"`,
    (request) => client.createDocConversation(request));
}

function rename(change, operationKey, summary) {
  const built = renameArgs(payloadOf(), change);
  send(operationKey, built, summary, (request) => client.renameDocConversation(request));
}

function share(slug, granted) {
  const header = identityHeader(payloadOf());
  const built = shareArgs(header?.id, slug, granted);
  send(shareOperationKey(header?.id, slug), built,
    `${granted ? "Share" : "Stop sharing"} this conversation with ${slug}`,
    (request) => client.shareDocConversation(request));
}

function mountDock() {
  const root = $("receiptDock");
  if (!root) return;
  dock = createCommandDock({
    root,
    // A refusal is settled: the kernel dropped the entry, so this starts over
    // with the same arguments and a new key, which is the only correct retry.
    onDispatch: (operationKey) => {
      const entry = operations.get(operationKey);
      if (entry?.args) dispatch(operationKey, entry.args, entry.summary, entry.send);
    },
    // An unknown outcome is reconciled by re-sending the SAME frozen request;
    // the kernel returns the retained one, so the same arguments are passed.
    onReconcile: (operationKey) => {
      const entry = operations.get(operationKey);
      if (entry?.args) dispatch(operationKey, entry.args, entry.summary, entry.send);
    },
    onUndo: null,
  });
  dock.mount();
}

/* ------------------------------------------------------------------------ boot */

async function boot() {
  mountPrefs();
  mountDocDock("Conversations");
  mountDock();
  $("rosterScope").textContent = ROSTER_SCOPE;
  $("sharingCaveat").textContent = SHARING_CAVEAT;
  $("composerAbsent").textContent = COMPOSER_ABSENT;
  $("docReplyPending").textContent = DOC_REPLY_PENDING;
  $("titleHistoryLine").textContent = TITLE_HISTORY_UNREADABLE;
  $("exposureStatement").textContent = EXPOSURE_STATEMENT;
  const location = globalThis.location || { hostname: "", search: "" };
  const params = new URLSearchParams(location.search || "");
  view.route = idFromSearch(location.search || "");
  $("retryRead")?.addEventListener("click", () => load());
  $("showMore")?.addEventListener("click", () => {
    const paging = pagingState(payloadOf());
    if (paging.more) takeConversation({ after: paging.after });
  });
  $("archivedToggle")?.addEventListener("click", () => {
    view.showArchived = !view.showArchived;
    render();
  });
  for (const list of ["rosterList", "archivedList"]) {
    $(list)?.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-open]") : null;
      if (target) open(target.getAttribute("data-open"));
    });
  }
  $("shareControls")?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-share]") : null;
    if (target) share(target.getAttribute("data-share"), target.getAttribute("aria-pressed") !== "true");
  });
  $("createSave")?.addEventListener("click", () => create());
  $("renameSave")?.addEventListener("click", () => {
    const header = identityHeader(payloadOf());
    rename({ title: $("renameInput")?.value }, renameOperationKey(header?.id), "Rename this conversation");
  });
  $("pinToggle")?.addEventListener("click", (event) => {
    const header = identityHeader(payloadOf());
    const pressed = event.currentTarget.getAttribute("aria-pressed") === "true";
    rename({ pinned: !pressed }, pinOperationKey(header?.id), pressed ? "Unpin this conversation" : "Pin this conversation");
  });
  $("archiveToggle")?.addEventListener("click", (event) => {
    const header = identityHeader(payloadOf());
    const pressed = event.currentTarget.getAttribute("aria-pressed") === "true";
    rename({ archived: !pressed }, archiveOperationKey(header?.id), pressed ? "Unarchive this conversation" : "Archive this conversation");
  });
  globalThis.addEventListener?.("popstate", () => {
    view.route = idFromSearch(globalThis.location?.search || "");
    view.conversation = { state: "pending" };
    load();
  });
  const boot_ = resolveDealroomBoot(location);
  const outage = params.get("outage");
  client = boot_.mode === "live"
    ? createLiveClient()
    : await createFixtureClient({ ...boot_.options, ...(outage ? { outage } : {}) });
  await load();
}

boot();

export { view };
