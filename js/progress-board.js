import { createLiveClient } from "./live-client.js";
import { mountSystemWorkBoard } from "./system-work-board.js";
import { uuidv4 } from "./uuid.js";
import { workDetailUrl } from "./progress-work-model.js";
import {
  STAGES, PULSES, EXECUTORS, ALL_REPOS_BOARD, LIVE_PREVIEW, legendEntries, boardView, headline,
  answerRequest, taskSummary, modelLine, relatedQuestions, stageEnteredAt, stageDurations, ageText,
  executorGlyph, executorPool, prLabel, prUrl, taskRepo, liveView, readLivePreference,
  writeLivePreference, filterCards, groupByRepo, boardFromSearch, safeHref, sortLive,
  SYSTEM_BOARD_ID, boardDirectory, boardFreshness, nextFreshnessChange,
} from "./progress-board-model.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const REFRESH_MS = 15000;
const TICK_MS = 30000;

function safeStorage(win) {
  try { return win.localStorage ?? null; } catch { return null; }
}

// One interactive board. Everything it draws comes from the published CARR
// snapshot; every indicator comes from the model's shared constants.
export function mountBoard(deps = {}) {
  const win = deps.window || globalThis;
  const doc = deps.document || win.document;
  const client = deps.client || createLiveClient();
  const storage = "storage" in deps ? deps.storage : safeStorage(win);
  const now = deps.now || (() => new Date());
  const schedule = deps.setInterval || ((fn, ms) => win.setInterval(fn, ms));
  const setTimer = deps.setTimeout || ((fn, ms) => win.setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout || (id => win.clearTimeout(id));
  const requestAnimationFrame = fn => (win.requestAnimationFrame ? win.requestAnimationFrame(fn) : win.setTimeout(fn, 0));
  const boardId = boardFromSearch(deps.search ?? win.location?.search ?? "");
  const byId = id => doc.getElementById(id);
  byId("board-activity").href = workDetailUrl({ board: boardId || SYSTEM_BOARD_ID });
  byId("board-parent-name").textContent = boardId === SYSTEM_BOARD_ID ? "System board" : "Project board";
  const pendingRequests = new Map();
  // Per question: the form's message, whether a write or read is in flight,
  // and whether the form is obsolete and must be reloaded before any write.
  const formState = new Map();
  const fingerprints = new Map();
  const filters = { repo: "", stage: "", blockedOnly: false };
  let liveExpanded = readLivePreference(storage);
  let currentView = null;
  let openCardId = null;
  let lastRead = null;
  let readSeq = 0;
  let latestRead = null;
  // Cards and unchanged question cards keep their nodes across renders, so
  // focus, drafts and the dialog's return target survive every poll.
  const cardNodes = new Map();
  let questionCards = new Map();
  let returnFocus = null;
  let viewSignature = "";
  let directorySignature = "";
  const badgeTimes = new Map();
  let ageTimer = null;
  // On the system board the pipeline shows the system-work census (unfinished
  // work plus recent Live) instead of snapshot tasks; every other panel still
  // reads the snapshot.
  let systemWork = null;
  let censusPipeline = null;
  let pipelineCards = [];

  function el(tag, className, text, attributes = {}) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    return node;
  }

  function svg(tag, className, attributes = {}, text) {
    const node = doc.createElementNS(SVG_NS, tag);
    if (className) node.setAttribute("class", className);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function link(href, text) {
    const url = safeHref(href);
    if (!url) return el("span", "", text);
    const anchor = el("a", "", text, { href: url, target: "_blank", rel: "noopener noreferrer" });
    anchor.addEventListener("click", event => event.stopPropagation());
    return anchor;
  }

  function formatTime(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(undefined,
      { dateStyle: "medium", timeStyle: "short", hour12: true }).format(date);
  }

  // ── publication freshness ─────────────────────────────────────────────────
  function updateBadge(badge, updatedAt) {
    const age = boardFreshness(updatedAt, currentNow());
    const label = `${age.label}${age.state === "stale" ? " · Stale · 24h+" : ""}`;
    if (badge.textContent !== label) badge.textContent = label;
    badge.setAttribute("data-freshness", age.state);
  }

  // This clock only patches badge text. It never reads the network or rebuilds
  // controls, and wakes at publication-relative minute boundaries (including 24h).
  function refreshAges() {
    clearTimer(ageTimer);
    let delay = Infinity;
    const at = currentNow().getTime();
    for (const [badge, updatedAt] of badgeTimes) {
      if (badge.isConnected === false) { badgeTimes.delete(badge); continue; }
      updateBadge(badge, updatedAt);
      const next = nextFreshnessChange(updatedAt, at);
      if (next !== null) delay = Math.min(delay, next);
    }
    if (Number.isFinite(delay)) ageTimer = setTimer(refreshAges, Math.min(delay, 60000));
  }

  function freshnessBadge(updatedAt) {
    const badge = el("span", "freshness-badge");
    badgeTimes.set(badge, updatedAt);
    updateBadge(badge, updatedAt);
    return badge;
  }

  function announce(message) {
    byId("board-live").textContent = message;
  }

  // ── published board directory ─────────────────────────────────────────────
  function renderDirectory(read) {
    const boards = boardDirectory(read);
    const directory = byId("board-directory");
    byId("directory-error").hidden = true;
    const signature = JSON.stringify(boards);
    if (signature === directorySignature || directory.contains(doc.activeElement)) return;
    const changed = Boolean(directorySignature);
    directorySignature = signature;
    directory.replaceChildren();
    for (const board of boards) {
      const item = el("a", "board-link", undefined,
        { href: `/control-room/progress?board=${encodeURIComponent(board.board_id)}`, "data-board-id": board.board_id });
      if (board.board_id === boardId) item.setAttribute("aria-current", "page");
      item.append(el("span", "eyebrow", board.board_id === SYSTEM_BOARD_ID ? "System-wide" : "Project"),
        el("h3", "", board.title || board.project || board.board_id));
      const published = el("time", "board-published", formatTime(board.updated_at) || "Publication time unavailable");
      if (board.updated_at) published.dateTime = board.updated_at;
      const counts = Object.entries(board.task_counts || {}).map(([status, count]) => `${count} ${status}`).join(" · ");
      item.append(published, freshnessBadge(board.updated_at), el("span", "board-counts", counts || "0 tasks"));
      directory.append(item);
    }
    if (!boards.length) directory.append(el("p", "empty", "No published boards."));
    refreshAges();
    if (changed) announce("Published boards updated.");
  }

  function clearDirectory() {
    directorySignature = "";
    byId("board-directory").replaceChildren();
  }

  function loadDirectory(seq) {
    if (typeof client.listProgressBoards !== "function") return;
    client.listProgressBoards().then(read => {
      if (seq === readSeq) renderDirectory(read);
    }).catch(cause => {
      if (seq === readSeq) readFailure(cause, "directory");
    });
  }

  function setError(message) {
    const error = byId("board-error");
    error.textContent = message || "";
    error.hidden = !message;
  }

  function pulseSpeed(id) {
    return PULSES.find(pulse => pulse.id === id)?.speed || "0s";
  }

  function stageColor(id) {
    return STAGES.find(stage => stage.id === id)?.color || "#f2f6fc";
  }

  function clickable(node, open) {
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.addEventListener("click", open);
    node.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
    });
  }

  // ── legend ────────────────────────────────────────────────────────────────
  function renderLegend() {
    const body = byId("legend-body");
    body.replaceChildren();
    for (const group of legendEntries()) {
      const section = el("section", "legend-group");
      section.append(el("h3", "", group.name));
      const list = el("dl", "legend-list");
      for (const entry of group.entries) {
        const row = el("div", "legend-entry", undefined, { "data-legend-id": entry.id });
        const sample = el("dt", "legend-sample");
        sample.setAttribute("aria-hidden", "true");
        if (entry.id.startsWith("stage-")) sample.append(el("span", "swatch", undefined, { style: `--swatch:${entry.swatch}` }));
        else if (entry.id.startsWith("glyph-")) sample.append(el("span", "glyph", entry.glyph));
        else if (entry.id.startsWith("pulse-")) {
          const dot = el("span", "legend-pulse", undefined,
            { "data-pulse": entry.pulse, style: `--pulse-speed:${entry.speed || "0s"};--pulse-color:${entry.swatch}` });
          sample.append(dot);
        } else if (entry.id === "outline-dashed") sample.append(el("span", "dashed-sample"));
        else if (entry.id === "badge-question") sample.append(el("span", "badge-question", "?"));
        else if (entry.id === "flag-stale") sample.append(el("span", "flag-stale", "stale 7h"));
        else if (entry.id === "note-release-wait") sample.append(el("span", "wait-sample", "waiting"));
        const meaning = el("dd", "");
        meaning.append(el("strong", "", entry.label), el("span", "", entry.meaning));
        row.append(sample, meaning);
        list.append(row);
      }
      section.append(list);
      body.append(section);
    }
  }

  function wireLegend() {
    const toggle = byId("legend-toggle");
    const legend = byId("legend");
    toggle.addEventListener("click", () => {
      legend.hidden = !legend.hidden;
      toggle.setAttribute("aria-expanded", String(!legend.hidden));
    });
    doc.addEventListener("keydown", event => {
      if (event.key === "Escape" && !legend.hidden) {
        legend.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  // ── cards ─────────────────────────────────────────────────────────────────
  function fingerprint(card) {
    return JSON.stringify([card.stage, card.status, card.health, card.pr_phase, card.pr_head,
      card.updated_at, card.release_wait, card.stale]);
  }

  function cardNode(card, index) {
    const node = el("article", "board-card", undefined, {
      "data-card-id": card.id, "data-stage": card.stage, "data-pulse": card.pulse,
      "data-indicators": card.indicators.join(" "),
      style: `--stage-accent:${stageColor(card.stage)};--pulse-speed:${pulseSpeed(card.pulse)};--i:${Math.min(index, 12)}`,
      "aria-label": `${card.title || card.id}, ${STAGES.find(stage => stage.id === card.stage).label}. Open details.`,
    });
    if (card.indicators.includes("outline-dashed")) node.classList.add("outline-dashed");
    const previous = fingerprints.get(card.id);
    const now = fingerprint(card);
    if (previous && previous !== now) node.classList.add("changed");
    fingerprints.set(card.id, now);

    const top = el("div", "card-top");
    const pool = executorPool(card.executor);
    const glyph = el("span", "glyph", executorGlyph(card.executor),
      { title: EXECUTORS.find(item => item.pool === pool).label, "data-pool": pool });
    glyph.prepend(el("span", "halo", undefined, { "aria-hidden": "true" }));
    const title = el("strong", "card-title", card.title || card.id, { title: card.title || card.id });
    top.append(glyph, title);
    if (card.indicators.includes("badge-question"))
      top.append(el("span", "badge-question", "?", { title: "Waiting on an answer or a review" }));
    if (card.indicators.includes("flag-stale"))
      top.append(el("span", "flag-stale", `stale ${ageText(card.updated_at, currentNow())}`,
        { "data-stale-since": card.updated_at, title: "No update for 6 hours or more" }));
    if (card.sync_failed)
      top.append(el("span", "flag-unrefreshed", "not refreshed",
        { title: "GitHub could not be read for this card; it shows its last verified state" }));
    node.append(top);

    const summary = taskSummary(card);
    node.append(el("p", "card-summary", summary, { title: summary }));
    const meta = el("p", "card-meta");
    meta.append(el("span", "card-pr", prLabel(card)), el("span", "dot", "·"),
      el("span", "stage-timer", `${card.stage} ${ageText(stageEnteredAt(card), currentNow())}`,
        { "data-stage-since": stageEnteredAt(card) || "", "data-stage": card.stage,
          title: "Time in this stage" }));
    node.append(meta);
    const model = modelLine(card);
    node.append(el("p", "card-model", model, { title: model }));
    if (card.blocked) {
      const blocked = el("div", "card-blocked");
      blocked.append(el("p", "", `Why: ${card.blocked.reason}`), el("p", "", `Next: ${card.blocked.next}`));
      node.append(blocked);
    }
    if (card.indicators.includes("note-release-wait")) {
      const wait = `Waiting on release · ${card.release_wait}`;
      node.append(el("p", "card-wait", wait, { title: wait }));
    }
    clickable(node, () => openDetail(card.id));
    return node;
  }

  // The first node drawn for a card is kept and updated in place.
  function placeCard(card, index) {
    const fresh = cardNode(card, index);
    const kept = cardNodes.get(card.id);
    if (!kept) { cardNodes.set(card.id, fresh); return fresh; }
    if (fresh.classList.contains("changed")) { kept.classList.remove("changed"); void kept.offsetWidth; }
    for (const attribute of [...kept.attributes]) if (!fresh.hasAttribute(attribute.name)) kept.removeAttribute(attribute.name);
    for (const attribute of fresh.attributes) kept.setAttribute(attribute.name, attribute.value);
    kept.replaceChildren(...fresh.childNodes);
    return kept;
  }

  function currentNow() {
    return now();
  }

  // ── pipeline ──────────────────────────────────────────────────────────────
  function censusCards() {
    if (!censusPipeline) return null;
    const tasks = {};
    for (const stage of censusPipeline.stages)
      for (const task of stage.tasks) tasks[task.id] = { ...task, stage: stage.id };
    return boardView({ snapshot: { board_id: SYSTEM_BOARD_ID, version: 1, snapshot_json: { tasks } } }, currentNow()).cards;
  }

  function findCard(cardId) {
    return pipelineCards.find(card => card.id === cardId) || currentView?.cards.find(card => card.id === cardId) || null;
  }

  function renderRail(visible) {
    const rail = byId("board-rail");
    rail.replaceChildren();
    const step = 600 / STAGES.length;
    rail.append(svg("path", "rail-line", { d: `M ${step / 2} 20 H ${600 - step / 2}` }));
    STAGES.forEach((stage, index) => {
      const x = step / 2 + index * step;
      const count = visible.filter(card => card.stage === stage.id).length;
      rail.append(svg("circle", "rail-node", { cx: x, cy: 20, r: 7, style: `--stage-accent:${stage.color}`,
        "data-active": count ? "true" : "false" }));
    });
  }

  function renderFilters(view) {
    const repo = byId("filter-repo");
    const stage = byId("filter-stage");
    const repos = [...new Set([...view.repos.map(row => row.repo), ...view.cards.map(taskRepo)])].sort();
    repo.replaceChildren(el("option", "", "All", { value: "" }),
      ...repos.map(name => el("option", "", name.split("/")[1], { value: name })));
    stage.replaceChildren(el("option", "", "All", { value: "" }),
      ...STAGES.map(item => el("option", "", item.label, { value: item.id })));
    if (!repos.includes(filters.repo)) filters.repo = "";
    repo.value = filters.repo;
    stage.value = filters.stage;
    byId("filter-blocked").checked = filters.blockedOnly;
    repo.closest("label").hidden = repos.length < 2;
  }

  function wireFilters() {
    byId("filter-repo").addEventListener("change", event => { filters.repo = event.target.value; renderStages(currentView); });
    byId("filter-stage").addEventListener("change", event => { filters.stage = event.target.value; renderStages(currentView); });
    byId("filter-blocked").addEventListener("change", event => { filters.blockedOnly = event.target.checked; renderStages(currentView); });
    byId("board-filters").addEventListener("submit", event => event.preventDefault());
  }

  function appendCards(container, cards, grouped) {
    let index = 0;
    if (!grouped) {
      for (const card of cards) container.append(placeCard(card, index++));
      return;
    }
    for (const group of groupByRepo(cards)) {
      container.append(el("h4", "repo-group", group.repo.split("/")[1], { title: group.repo }));
      for (const card of group.cards) container.append(placeCard(card, index++));
    }
  }

  function toggleLive() {
    liveExpanded = !liveExpanded;
    writeLivePreference(storage, liveExpanded);
    renderStages(currentView);
    byId("live-toggle")?.focus?.();
  }

  function renderStages(view) {
    const census = censusCards();
    if (!view && !census) return;
    const all = census || view.cards;
    const kind = census ? "project" : view.kind;
    pipelineCards = all;
    const container = byId("board-stages");
    const focusedId = [...cardNodes].find(([, node]) => node === doc.activeElement)?.[0];
    container.replaceChildren();
    const visible = filterCards(all, filters);
    const grouped = kind === ALL_REPOS_BOARD;
    byId("task-count").textContent = `${visible.length} OF ${all.length} CARD${all.length === 1 ? "" : "S"}`;
    renderRail(visible);
    STAGES.forEach((stage, index) => {
      const cards = visible.filter(card => card.stage === stage.id);
      const column = el("section", "column", undefined,
        { "data-stage": stage.id, style: `--stage-accent:${stage.color}`, "aria-label": `${stage.label}: ${cards.length}` });
      const head = el("header", "column-head");
      head.append(el("span", "stage-index", String(index + 1).padStart(2, "0")),
        el("h3", "stage-label", stage.label), el("span", "stage-count", String(cards.length).padStart(2, "0")));
      column.append(head);
      const body = el("div", "column-body");
      if (stage.id === "live") {
        const live = liveView(cards, liveExpanded, kind);
        column.dataset.collapsed = String(!liveExpanded);
        if (!liveExpanded && live.total)
          body.append(el("p", "live-summary", `${live.total} live · latest ${Math.min(LIVE_PREVIEW, live.total)} shown`));
        appendCards(body, live.shown, false);
        if (live.total > LIVE_PREVIEW) {
          const button = el("button", "live-toggle", liveExpanded ? `Show latest ${LIVE_PREVIEW}` : `Show all ${live.total}`,
            { id: "live-toggle", type: "button", "aria-expanded": String(liveExpanded) });
          button.addEventListener("click", toggleLive);
          body.append(button);
        }
      } else {
        appendCards(body, cards, grouped);
      }
      if (!cards.length) body.append(el("p", "column-empty", "Nothing here"));
      column.append(body);
      container.append(column);
    });
    for (const id of [...cardNodes.keys()]) if (!all.some(card => card.id === id)) cardNodes.delete(id);
    if (focusedId) {
      const node = cardNodes.get(focusedId);
      (node?.isConnected ? node : byId("board-title")).focus();
    }
    // Cards animate in on the first draw only; later renders (refresh, tick)
    // flash just the cards whose state changed.
    requestAnimationFrame(() => { container.dataset.settled = "true"; });
  }

  // ── panels ────────────────────────────────────────────────────────────────
  function renderHeadline(view) {
    const counts = headline(view);
    const box = byId("board-headline");
    box.replaceChildren(
      el("strong", "h-running", `${counts.running} running`),
      el("strong", "h-waiting", `${counts.waiting} need Joe`),
      el("strong", "h-blocked", `${counts.blocked} blocked`),
      el("strong", "h-stale", `${counts.stale} stale`),
      el("strong", "h-live", `${counts.live} live · ${counts.remaining} remaining`));
  }

  function renderRepos(view) {
    const panel = byId("repos-panel");
    panel.hidden = view.kind !== ALL_REPOS_BOARD;
    const list = byId("board-repos");
    list.replaceChildren();
    byId("repo-count").textContent = `${view.repos.length} REPOS`;
    for (const row of view.repos) {
      const item = el("button", "repo-chip", undefined, { type: "button", "data-repo": row.repo, title: row.repo });
      item.append(el("strong", "", row.repo.split("/")[1]),
        el("span", "", `${Number(row.open) || 0} open · ${Number(row.merged) || 0} merged`));
      if (row.error) {
        item.classList.add("repo-error");
        item.append(el("span", "repo-error-text", "gh read failed; showing the last cards"));
      }
      item.addEventListener("click", () => {
        filters.repo = filters.repo === row.repo ? "" : row.repo;
        byId("filter-repo").value = filters.repo;
        renderStages(currentView);
      });
      list.append(item);
    }
  }

  function renderBlocked(view) {
    const list = byId("board-blocked");
    list.replaceChildren();
    const blocked = view.cards.filter(card => card.blocked);
    byId("blocked-count").textContent = `${blocked.length} BLOCKED`;
    if (!blocked.length) { list.append(el("p", "empty", "Nothing is blocked.")); return; }
    for (const card of blocked) {
      const item = el("article", "blocked-card", undefined, { "data-card-id": card.id, style: `--stage-accent:${stageColor(card.stage)}` });
      const top = el("div", "blocked-top");
      top.append(el("strong", "card-title", card.title || card.id, { title: card.title || card.id }),
        el("span", "card-pr", prLabel(card)));
      item.append(top, el("p", "blocked-why", `Why: ${card.blocked.reason}`),
        el("p", "blocked-next", `Next: ${card.blocked.next}`));
      clickable(item, () => openDetail(card.id));
      list.append(item);
    }
  }

  function renderLedger(view) {
    const box = byId("board-ledger");
    box.replaceChildren();
    for (const row of view.ledger) {
      const item = el("div", `ledger-row${row.violation ? " ledger-violation" : ""}`, undefined, { "data-pool": row.pool });
      const head = el("div", "ledger-head");
      head.append(el("span", "glyph", row.glyph), el("span", "ledger-label", row.label),
        el("strong", "ledger-count", String(Number(row.count) || 0).padStart(2, "0")));
      item.append(head);
      if (row.violation) item.append(el("p", "ledger-flag", "POLICY VIOLATION · in-plan Claude subagent"));
      for (const model of row.models || []) {
        const text = `${model.provider} · ${model.model} · ${model.effort} ×${model.count}`;
        item.append(el("p", "ledger-model", text, { title: text }));
      }
      box.append(item);
    }
  }

  function renderDeliverables(view) {
    const box = byId("board-deliverables");
    box.replaceChildren();
    byId("deliverable-count").textContent = `${view.deliverables.length} LINKS`;
    if (!view.deliverables.length) { box.append(el("p", "empty", "No deliverables yet.")); return; }
    for (const item of view.deliverables) {
      const row = el("div", "link-row");
      row.append(link(item.link, item.title || "Deliverable"), el("time", "", formatTime(item.created_at)));
      box.append(row);
    }
  }

  function renderDecisions(view) {
    const box = byId("board-decisions");
    box.replaceChildren();
    const answered = view.questions.filter(q => q.status);
    byId("decision-count").textContent = `${view.decisions.length + answered.length} MADE`;
    if (!view.decisions.length && !answered.length) { box.append(el("p", "empty", "No decisions recorded yet.")); return; }
    for (const decision of view.decisions) {
      const row = el("article", "decision");
      row.append(el("strong", "", decision.question), el("p", "", `Answer: ${decision.answer}`),
        el("time", "", formatTime(decision.answered_at)));
      box.append(row);
    }
    for (const q of answered) {
      const row = el("article", "decision", undefined, { "data-status": q.status });
      row.append(el("strong", "", q.prompt), el("p", "", `Answer: ${q.answer_text || ""} · ${q.status}`));
      box.append(row);
    }
  }

  function renderNotes(view) {
    const box = byId("board-notes");
    box.replaceChildren();
    if (!view.notes.length) { box.append(el("p", "empty", "No notes.")); return; }
    for (const note of view.notes) {
      const row = el("article", "note");
      row.append(el("p", "", note.text), el("time", "", formatTime(note.created_at)));
      box.append(row);
    }
  }

  function renderCompleted(view) {
    const box = byId("board-completed");
    box.replaceChildren();
    const live = sortLive(view.cards.filter(card => card.stage === "live"), view.kind);
    byId("completed-count").textContent = `${live.length} LIVE`;
    if (!live.length) { box.append(el("p", "empty", "No live work yet.")); return; }
    for (const card of live) {
      const item = el("article", "completed-card", undefined, { "data-card-id": card.id });
      const top = el("div", "completed-top");
      top.append(el("strong", "card-title", card.title || card.id, { title: card.title || card.id }),
        el("time", "", formatTime(card.completed_at || card.updated_at)));
      const model = modelLine(card);
      const summary = taskSummary(card);
      item.append(top, el("p", "card-pr", prLabel(card)), el("p", "card-summary", summary, { title: summary }),
        el("p", "completed-evidence", card.evidence || ""),
        el("p", "card-model", model, { title: model }));
      clickable(item, () => openDetail(card.id));
      box.append(item);
    }
  }

  // ── detail pop-up ─────────────────────────────────────────────────────────
  function detailRow(body, label, value) {
    if (value === undefined || value === null || value === "") return;
    const row = el("div", "detail-row");
    const cell = el("dd", "");
    if (typeof value === "object" && value.nodeType) cell.append(value); else cell.textContent = String(value);
    row.append(el("dt", "", label), cell);
    body.append(row);
  }

  function openDetail(cardId) {
    const card = findCard(cardId);
    if (!card) return;
    openCardId = cardId;
    returnFocus = doc.activeElement;
    fillDetail(card);
    const dialog = byId("task-detail");
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    }
  }

  function fillDetail(card) {
    const at = currentNow();
    const stage = STAGES.find(item => item.id === card.stage);
    byId("task-detail-title").textContent = card.title || card.id;
    byId("task-detail-eyebrow").textContent = `${stage.label.toUpperCase()} / ${prLabel(card).toUpperCase()}`;
    const body = byId("task-detail-body");
    body.replaceChildren();
    const work = el("a", "", "Open work detail", { href: workDetailUrl({
      board: boardId || SYSTEM_BOARD_ID, task: card.id,
      workRequest: card.work_request || card.human_ref || (/^WR-\d+$/.test(card.id) ? card.id : null),
    }) });
    detailRow(body, "Activity", work);
    detailRow(body, "Summary", taskSummary(card));
    detailRow(body, "Stage", `${stage.label} · ${card.stage} ${ageText(stageEnteredAt(card), at)} in this stage`);
    detailRow(body, "Status", card.status);
    if (card.blocked) {
      detailRow(body, "Blocked because", card.blocked.reason);
      detailRow(body, "Next action", card.blocked.next);
    }
    if (card.stale) detailRow(body, "Stale", `No update for ${ageText(card.updated_at, at)}`);
    if (card.release_wait && card.stage === "merged") detailRow(body, "Waiting on release", card.release_wait);
    detailRow(body, "Repository", taskRepo(card));
    if (card.pr != null) {
      const url = prUrl(card);
      detailRow(body, "Pull request", url ? link(url, prLabel(card)) : prLabel(card));
    }
    detailRow(body, "Head SHA", card.pr_head);
    detailRow(body, "Merge commit", card.merge_sha);
    detailRow(body, "Executor", card.executor);
    detailRow(body, "Model line", modelLine(card));
    detailRow(body, "Provider", card.identity.provider);
    detailRow(body, "Model", card.identity.model);
    detailRow(body, "Effort", card.identity.effort);
    detailRow(body, "Author", card.author);
    detailRow(body, "Branch", card.branch);
    detailRow(body, "Review", card.review_verdict || card.pr_phase);
    detailRow(body, "CI", card.pr_checks);
    detailRow(body, "Created", formatTime(card.created_at));
    detailRow(body, "Updated", `${formatTime(card.updated_at)} · ${ageText(card.updated_at, at)} ago`);
    detailRow(body, "Completed", formatTime(card.completed_at));
    if (typeof card.question === "string") detailRow(body, "Question", card.question);
    detailRow(body, "Note", card.note);
    detailRow(body, "Evidence", card.evidence);
    for (const url of String(card.evidence || "").match(/https?:\/\/[^\s;,]+/g) || []) {
      const clean = url.replace(/[.)]+$/, "");
      detailRow(body, "Evidence link", link(clean, clean));
    }
    const history = stageDurations(card, at);
    if (history.length) {
      const list = el("ol", "stage-history");
      for (const entry of history) {
        const label = STAGES.find(item => item.id === entry.stage)?.label || entry.stage;
        const item = el("li", "", undefined, { "data-stage": entry.stage, style: `--stage-accent:${stageColor(entry.stage)}` });
        item.append(el("strong", "", label), el("span", "", ` ${entry.duration}`),
          el("time", "", ` from ${formatTime(entry.entered_at)}`));
        list.append(item);
      }
      detailRow(body, "Stage history", list);
    }
    for (const question of relatedQuestions(card, currentView?.questions || [])) {
      detailRow(body, "Board question", question.prompt);
      detailRow(body, "Answer", question.answer_text || `Waiting · ${question.default_answer || "No default recorded"}`);
    }
  }

  // ── questions ─────────────────────────────────────────────────────────────
  function liveForm(questionId) {
    return [...byId("board-questions").querySelectorAll(".answer-form")]
      .find(form => form.dataset.questionId === questionId) || null;
  }

  function applyFormState(form, state) {
    const button = form.querySelector("button[type=submit]");
    form.querySelector(".form-message").textContent = state.message || "";
    button.disabled = Boolean(state.busy);
    button.textContent = state.reload ? "Reload question" : "Send answer";
  }

  // Forms are rebuilt on every render, so state lives here and is applied to
  // whichever form is on the page now.
  function setFormState(questionId, patch) {
    const state = { ...(formState.get(questionId) || {}), ...patch };
    formState.set(questionId, state);
    const form = liveForm(questionId);
    if (form) applyFormState(form, state);
  }

  // A conflict makes the form obsolete: only a successful read may replace it.
  async function reloadQuestion(questionId, message) {
    setFormState(questionId, { busy: true, reload: true, message });
    let applied = false;
    try { applied = await refresh(true); } catch { applied = false; }
    if (applied) {
      formState.delete(questionId);
      questionCards.delete(questionId);
      renderQuestions(currentView);
      return;
    }
    setFormState(questionId, { busy: false, reload: true,
      message: "This question changed elsewhere and its latest version could not be loaded. Reload question to try again." });
  }

  function answerForm(q, view, draft) {
    const form = el("form", "answer-form");
    form.dataset.questionId = q.question_id;
    const message = el("p", "form-message");
    const choiceInputs = [];
    let freeText = null;
    if (q.choices.length) {
      const options = el("div", "answer-options");
      for (const [index, choice] of q.choices.entries()) {
        const label = el("label", "answer-option");
        const input = el("input", "", undefined, { type: "radio", name: `answer-${q.question_id}`,
          id: `choice-${q.question_id}-${index}` });
        input.value = choice;
        choiceInputs.push(input);
        label.append(input, el("span", "", choice));
        options.append(label);
      }
      form.append(options);
    }
    if (q.allow_free_text) {
      const id = `free-${q.question_id}`;
      const label = el("label", "", q.choices.length ? "Or write your answer" : "Your answer", { for: id });
      freeText = el("textarea", "", undefined, { id, maxlength: 4000, placeholder: "Type your answer" });
      form.append(label, freeText);
    }
    if (q.default_answer) form.append(el("p", "question-detail", `If unanswered: ${q.default_answer}`));
    const button = el("button", "", "Send answer", { type: "submit" });
    const preview = el("output", "answer-preview", undefined, { "aria-live": "polite" });
    const actions = el("div", "answer-actions");
    actions.append(button, preview);
    form.append(actions, message);
    if (draft) {
      if (freeText && draft.text) freeText.value = draft.text;
      for (const input of choiceInputs) input.checked = input.value === draft.choice;
    }
    const selectedAnswer = () => freeText?.value.trim() || choiceInputs.find(input => input.checked)?.value || "";
    const showAnswer = () => {
      preview.textContent = `Will send: ${pendingRequests.get(q.question_id)?.answer_text || selectedAnswer() || "—"}`;
    };
    const lockAnswer = () => {
      for (const input of choiceInputs) input.disabled = true;
      if (freeText) freeText.disabled = true;
    };
    for (const input of choiceInputs) input.addEventListener("change", () => {
      if (freeText) freeText.value = "";
      showAnswer();
    });
    freeText?.addEventListener("input", () => {
      for (const input of choiceInputs) input.checked = false;
      showAnswer();
    });
    const state = formState.get(q.question_id);
    if (pendingRequests.has(q.question_id) || state?.reload) lockAnswer();
    showAnswer();
    if (state) applyFormState(form, state);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const questionId = q.question_id;
      const current = formState.get(questionId) || {};
      if (current.busy) return;
      if (current.reload) { await reloadQuestion(questionId, "Reloading this question…"); return; }
      const retained = pendingRequests.get(questionId);
      const value = retained?.answer_text || selectedAnswer();
      const key = retained?.idempotency_key || uuidv4();
      let args;
      try { args = retained || answerRequest(q, view.board_id, value, key); }
      catch (cause) { setFormState(questionId, { message: cause.message }); return; }
      pendingRequests.set(questionId, args);
      lockAnswer();
      showAnswer();
      setFormState(questionId, { busy: true, message: "Saving answer…" });
      try {
        await client.answerBoardQuestion(args);
      } catch (cause) {
        const conflict = cause.payload?.error === "board_version_conflict" ||
          cause.payload?.error === "board_answer_already_sent";
        if (!conflict) {
          setFormState(questionId, { busy: false, message: "Answer status is unconfirmed. Retry will use the same request." });
          return;
        }
        pendingRequests.delete(questionId);
        await reloadQuestion(questionId, "This question changed or was answered elsewhere. Refreshing…");
        return;
      }
      pendingRequests.delete(questionId);
      formState.delete(questionId);
      const applied = await refresh(true).catch(() => false);
      if (!applied) setFormState(questionId, { busy: true, message: "Answer sent. The board will update on the next refresh." });
    });
    return form;
  }

  // Drafts, choices and focus in open forms survive every re-render.
  function captureDrafts(box) {
    const drafts = new Map();
    for (const form of box.querySelectorAll(".answer-form")) {
      drafts.set(form.dataset.questionId, {
        text: form.querySelector("textarea")?.value || "",
        choice: form.querySelector("input[type=radio]:checked")?.value ?? null,
      });
    }
    const active = doc.activeElement;
    const focus = active && box.contains(active) && active.id
      ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
    return { drafts, focus };
  }

  function restoreFocus(focus) {
    if (!focus) return;
    const node = byId(focus.id);
    if (!node || node.disabled) return;
    node.focus();
    try { if (typeof focus.start === "number") node.setSelectionRange(focus.start, focus.end); } catch { /* radios have no selection */ }
  }

  function renderQuestions(view) {
    const box = byId("board-questions");
    const { drafts, focus } = captureDrafts(box);
    const prior = questionCards;
    questionCards = new Map();
    const open = new Set(view.questions.filter(q => !q.status).map(q => q.question_id));
    for (const id of [...formState.keys()]) if (!open.has(id)) formState.delete(id);
    byId("question-count").textContent = `${open.size} WAITING`;
    if (!view.questions.length) { box.replaceChildren(el("p", "empty", "No questions on this board.")); return; }
    const next = [];
    for (const q of view.questions) {
      const signature = JSON.stringify(q);
      const kept = prior.get(q.question_id);
      if (kept?.signature === signature) {
        questionCards.set(q.question_id, kept);
        next.push(kept.card);
        continue;
      }
      const card = el("article", "question-card");
      if (q.status) card.dataset.status = q.status;
      const top = el("div", "question-top");
      top.append(el("h3", "question-title", q.prompt), el("span", "status", q.status || "Waiting"));
      card.append(top);
      if (q.status) {
        card.append(el("p", "answer-text", q.answer_text || ""));
        const detail = [q.answered_by ? `Answered by ${q.answered_by}` : null,
          q.status === "Applied" && q.effect_ref ? `Applied: ${q.effect_ref}` : null].filter(Boolean).join(" · ");
        if (detail) card.append(el("p", "question-detail", detail));
      } else {
        card.append(answerForm(q, view, drafts.get(q.question_id)));
      }
      questionCards.set(q.question_id, { signature, card });
      next.push(card);
    }
    // Unchanged cards stay connected, so a focused control is never detached.
    next.forEach((card, index) => {
      if (box.children[index] !== card) box.insertBefore(card, box.children[index] || null);
    });
    for (const child of [...box.children]) if (!next.includes(child)) child.remove();
    restoreFocus(focus);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  function renderSwitch() {
    const project = byId("switch-project");
    const all = byId("switch-all");
    if (boardId && boardId !== ALL_REPOS_BOARD) project.setAttribute("href", `/progress-board?board=${encodeURIComponent(boardId)}`);
    project.toggleAttribute("aria-current", Boolean(boardId) && boardId !== ALL_REPOS_BOARD);
    all.toggleAttribute("aria-current", boardId === ALL_REPOS_BOARD);
  }

  function renderSync(view) {
    const line = byId("board-sync");
    const { state, failed, checked_at, last_verified_at, trimmed } = view.sync;
    const parts = [];
    if (state === "failed") {
      const cards = failed.filter(row => row.card).length;
      const repos = failed.filter(row => !row.card && row.repo).length;
      const what = [cards && `${cards} card${cards === 1 ? "" : "s"}`,
        repos && `${repos} repositor${repos === 1 ? "y" : "ies"}`].filter(Boolean).join(" and ");
      parts.push(`GitHub refresh failed for ${what} at ${formatTime(checked_at) || "an unknown time"}; ` +
        `showing facts last verified ${formatTime(last_verified_at) || "never"}`);
    } else if (state === "ok") {
      parts.push(`GitHub checked ${formatTime(checked_at)} · every card verified`);
    }
    for (const row of trimmed)
      parts.push(`${row.count} older ${row.kind === "history" ? "History row" : `${row.kind[0].toUpperCase()}${row.kind.slice(1)} card`}` +
        `${row.count === 1 ? "" : "s"} not shown`);
    line.textContent = parts.join(" · ");
    line.hidden = parts.length === 0;
    if (state) line.dataset.state = state;
    else delete line.dataset.state;
  }

  function render(view) {
    currentView = view;
    byId("board-title").textContent = view.title;
    byId("board-eyebrow").textContent = view.kind === ALL_REPOS_BOARD ? "DELIVERY / ALL REPOSITORIES" : "DELIVERY / PROGRESS BOARD";
    doc.title = `${view.title} · DoctorCRE`;
    byId("board-meta").textContent = `${view.board_id} · Published ${formatTime(view.updated_at)} · Version ${view.version}`;
    renderSync(view);
    renderHeadline(view);
    renderRepos(view);
    renderFilters(view);
    renderStages(view);
    renderBlocked(view);
    renderQuestions(view);
    renderLedger(view);
    renderDeliverables(view);
    renderDecisions(view);
    renderNotes(view);
    renderCompleted(view);
    const dialog = byId("task-detail");
    if (openCardId && dialog.open) {
      const card = findCard(openCardId);
      if (card) fillDetail(card);
    }
  }

  // Live time: every time-dependent mark (stage ages, stale, stuck, health,
  // counts, blocked details) is derived again from the last read, so a card
  // that crosses a threshold changes without waiting for new data.
  function tick() {
    if (lastRead) render(boardView(lastRead, currentNow()));
  }

  const BOARD_PANELS = ["board-stages", "board-rail", "board-questions", "board-blocked", "board-ledger",
    "board-deliverables", "board-decisions", "board-notes", "board-completed", "board-headline", "board-repos"];
  const BOARD_COUNTS = ["task-count", "question-count", "blocked-count", "deliverable-count",
    "decision-count", "completed-count", "repo-count"];

  // A confirmed unpublished or denied read removes the protected board.
  function clearBoard(state) {
    currentView = null;
    lastRead = null;
    viewSignature = "";
    openCardId = null;
    returnFocus = null;
    cardNodes.clear();
    questionCards = new Map();
    fingerprints.clear();
    formState.clear();
    pendingRequests.clear();
    const dialog = byId("task-detail");
    if (dialog.open) dialog.close();
    byId("task-detail-title").textContent = "";
    byId("task-detail-body").replaceChildren();
    for (const id of BOARD_PANELS) byId(id).replaceChildren();
    for (const id of BOARD_COUNTS) byId(id).textContent = "—";
    byId("repos-panel").hidden = true;
    byId("board-sync").hidden = true;
    byId("board-title").textContent = "Progress";
    doc.title = "Progress · DoctorCRE";
    const meta = byId("board-meta");
    meta.textContent = state === "unpublished" ? "No published snapshot" : "Board access unavailable";
    meta.setAttribute("data-read-state", state);
    const freshness = byId("board-freshness");
    badgeTimes.delete(freshness);
    freshness.textContent = "";
    freshness.removeAttribute("data-freshness");
  }

  function readFailure(cause, target) {
    const status = cause?.status;
    const state = status === 401 ? "signed-out" : status === 403 ? "unauthorized"
      : cause?.code === "read_timeout" ? "timeout"
        : win.navigator?.onLine === false ? "offline" : "unavailable";
    let message;
    if (status === 401 || status === 403) {
      message = status === 401 ? "Sign-in required" : "You do not have access to this board.";
      if (status === 401) { ++readSeq; clearBoard(state); clearDirectory(); }
      else if (target === "board") clearBoard(state);
      else clearDirectory();
    } else {
      message = state === "timeout" ? "The request timed out." : state === "offline" ? "You are offline." : "Progress temporarily unavailable.";
    }
    if (target === "directory") {
      const error = byId("directory-error");
      error.textContent = message;
      error.hidden = false;
      error.setAttribute("data-read-state", state);
    } else {
      setError(message);
      const meta = byId("board-meta");
      meta.setAttribute("data-read-state", state);
      if (currentView) meta.textContent = `Updated ${formatTime(currentView.updated_at)} ↻`;
    }
    if (status === 401) byId("board-sign-in").hidden = false;
    byId("board-retry").hidden = false;
    refreshAges();
  }

  // Reads are ordered: a read that finishes after a newer one started is
  // discarded, and its caller waits for the newest read instead. Returns true
  // when a board was drawn. A poll waits while an answer form has focus; an
  // answer, a reload or Retry reads at once (force). The directory is read
  // alongside and never holds up the board.
  async function refresh(force = false) {
    if (!force && byId("board-questions").contains(doc.activeElement)) return false;
    if (!boardId) {
      setError("Choose a board: Project or All repositories.");
      byId("board-meta").textContent = "No board selected";
      return false;
    }
    const seq = ++readSeq;
    systemWork?.refresh();
    loadDirectory(seq);
    const run = (async () => {
      let read;
      try { read = await client.readProgressBoard({ board_id: boardId }); }
      catch (cause) {
        if (seq !== readSeq) return "superseded";
        readFailure(cause, "board");
        if (force) throw cause;
        return false;
      }
      if (seq !== readSeq) return "superseded";
      const view = boardView(read, currentNow());
      if (view.error) { setError(view.error); return false; }
      if (!view.version) {
        if (!systemWork) clearBoard("unpublished");
        else {
          const meta = byId("board-meta");
          meta.textContent = "No published system snapshot.";
          meta.setAttribute("data-read-state", "unpublished");
          badgeTimes.delete(byId("board-freshness"));
        }
        setError("This board has not been published yet.");
        byId("board-retry").hidden = false;
        return false;
      }
      lastRead = read;
      setError("");
      byId("board-sign-in").hidden = true;
      byId("board-meta").setAttribute("data-read-state", "published");
      const signature = JSON.stringify(read);
      if (signature !== viewSignature) {
        announce(viewSignature ? `${view.title} updated.` : `${view.title} loaded.`);
        viewSignature = signature;
      }
      render(view);
      badgeTimes.set(byId("board-freshness"), view.updated_at);
      refreshAges();
      return true;
    })();
    latestRead = run;
    let result = await run;
    while (result === "superseded") result = await latestRead;
    return result;
  }

  function start() {
    if (boardId === SYSTEM_BOARD_ID && typeof client.unfinishedWork === "function" && byId("system-work-panel"))
      systemWork = mountSystemWorkBoard({ client, onPipeline: pipeline => { censusPipeline = pipeline; renderStages(currentView); } });
    refresh().catch(() => setError("Progress temporarily unavailable."));
    schedule(() => refresh().catch(() => setError("Progress temporarily unavailable.")), REFRESH_MS);
    schedule(tick, TICK_MS);
  }

  // Closing the pop-up returns focus to what opened it, or to the card.
  byId("task-detail").addEventListener("close", () => {
    if (!openCardId && !returnFocus) return;
    const target = returnFocus?.isConnected ? returnFocus : cardNodes.get(openCardId);
    openCardId = null;
    returnFocus = null;
    (target?.isConnected ? target : byId("board-title")).focus();
  });
  byId("board-retry").addEventListener("click", () => refresh(true).catch(() => {}));
  doc.addEventListener("visibilitychange", refreshAges);
  renderLegend();
  wireLegend();
  wireFilters();
  renderSwitch();

  return { start, refresh, tick, openDetail, toggleLive, filters,
    get view() { return currentView; }, get liveExpanded() { return liveExpanded; } };
}

if (typeof document !== "undefined" && document.getElementById("board-stages") && !globalThis.__BOARD_NO_AUTOMOUNT)
  mountBoard().start();
