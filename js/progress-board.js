import { createLiveClient } from "./live-client.js";
import { uuidv4 } from "./uuid.js";
import {
  STAGES, PULSES, EXECUTORS, ALL_REPOS_BOARD, LIVE_PREVIEW, legendEntries, boardView, headline,
  answerRequest, taskSummary, modelLine, relatedQuestions, stageEnteredAt, stageDurations, ageText,
  executorGlyph, executorPool, prLabel, prUrl, taskRepo, liveView, readLivePreference,
  writeLivePreference, filterCards, groupByRepo, boardFromSearch, safeHref, sortLive,
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
  const boardId = boardFromSearch(deps.search ?? win.location?.search ?? "");
  const byId = id => doc.getElementById(id);
  const pendingRequests = new Map();
  const fingerprints = new Map();
  const filters = { repo: "", stage: "", blockedOnly: false };
  let liveExpanded = readLivePreference(storage);
  let currentView = null;
  let openCardId = null;

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
      { dateStyle: "medium", timeStyle: "short" }).format(date);
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

  function currentNow() {
    return now();
  }

  // ── pipeline ──────────────────────────────────────────────────────────────
  function renderRail(view, visible) {
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
      for (const card of cards) container.append(cardNode(card, index++));
      return;
    }
    for (const group of groupByRepo(cards)) {
      container.append(el("h4", "repo-group", group.repo.split("/")[1], { title: group.repo }));
      for (const card of group.cards) container.append(cardNode(card, index++));
    }
  }

  function toggleLive() {
    liveExpanded = !liveExpanded;
    writeLivePreference(storage, liveExpanded);
    renderStages(currentView);
    byId("live-toggle")?.focus?.();
  }

  function renderStages(view) {
    if (!view) return;
    const container = byId("board-stages");
    container.replaceChildren();
    const visible = filterCards(view.cards, filters);
    const grouped = view.kind === ALL_REPOS_BOARD;
    byId("task-count").textContent = `${visible.length} OF ${view.cards.length} CARD${view.cards.length === 1 ? "" : "S"}`;
    renderRail(view, visible);
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
        const live = liveView(cards, liveExpanded, view.kind);
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
      item.append(top, el("p", "card-pr", prLabel(card)), el("p", "completed-evidence", card.evidence || ""),
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
    const card = currentView?.cards.find(item => item.id === cardId);
    if (!card) return;
    openCardId = cardId;
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
  function answerForm(q, view) {
    const form = el("form", "answer-form");
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
    if (pendingRequests.has(q.question_id)) lockAnswer();
    showAnswer();
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const retained = pendingRequests.get(q.question_id);
      const value = retained?.answer_text || selectedAnswer();
      const key = retained?.idempotency_key || uuidv4();
      let args;
      try { args = retained || answerRequest(q, view.board_id, value, key); }
      catch (cause) { message.textContent = cause.message; return; }
      pendingRequests.set(q.question_id, args);
      lockAnswer();
      showAnswer();
      button.disabled = true;
      message.textContent = "Saving answer…";
      try {
        await client.answerBoardQuestion(args);
        await refresh(true);
        pendingRequests.delete(q.question_id);
      } catch (cause) {
        button.disabled = false;
        const conflict = cause.payload?.error === "board_version_conflict" ||
          cause.payload?.error === "board_answer_already_sent";
        message.textContent = conflict ? "This question changed or was answered elsewhere. Refreshing…"
          : "Answer status is unconfirmed. Retry will use the same request.";
        if (conflict) {
          pendingRequests.delete(q.question_id);
          await refresh(true).catch(() => {});
        }
      }
    });
    return form;
  }

  function renderQuestions(view) {
    const box = byId("board-questions");
    box.replaceChildren();
    byId("question-count").textContent = `${view.questions.filter(q => !q.status).length} WAITING`;
    if (!view.questions.length) { box.append(el("p", "empty", "No questions on this board.")); return; }
    for (const q of view.questions) {
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
        card.append(answerForm(q, view));
      }
      box.append(card);
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  function renderSwitch() {
    const project = byId("switch-project");
    const all = byId("switch-all");
    if (boardId && boardId !== ALL_REPOS_BOARD) project.setAttribute("href", `/progress-board?board=${encodeURIComponent(boardId)}`);
    project.toggleAttribute("aria-current", Boolean(boardId) && boardId !== ALL_REPOS_BOARD);
    all.toggleAttribute("aria-current", boardId === ALL_REPOS_BOARD);
  }

  function render(view) {
    currentView = view;
    byId("board-title").textContent = view.title;
    byId("board-eyebrow").textContent = view.kind === ALL_REPOS_BOARD ? "DELIVERY / ALL REPOSITORIES" : "DELIVERY / PROGRESS BOARD";
    doc.title = `${view.title} · DoctorCRE`;
    byId("board-meta").textContent = `${view.board_id} · Published ${formatTime(view.updated_at)} · Version ${view.version}`;
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
      const card = view.cards.find(item => item.id === openCardId);
      if (card) fillDetail(card);
    }
  }

  // Live timers: stage ages and stale flags move without a reload.
  function tick() {
    const at = currentNow();
    for (const node of doc.querySelectorAll("[data-stage-since]"))
      node.textContent = `${node.dataset.stage} ${ageText(node.dataset.stageSince, at)}`;
    for (const node of doc.querySelectorAll("[data-stale-since]"))
      node.textContent = `stale ${ageText(node.dataset.staleSince, at)}`;
  }

  async function refresh(force = false) {
    if (!boardId) {
      setError("Choose a board: Project or All repositories.");
      byId("board-meta").textContent = "No board selected";
      return;
    }
    if (!force && byId("board-questions").contains(doc.activeElement)) return;
    const read = await client.readProgressBoard({ board_id: boardId });
    const view = boardView(read, currentNow());
    if (!view.version) { setError("This board has not been published yet."); return; }
    setError("");
    render(view);
  }

  function start() {
    refresh().catch(() => setError("The board could not be loaded. Refresh to try again."));
    schedule(() => refresh().catch(() => setError("The board could not be refreshed.")), REFRESH_MS);
    schedule(tick, TICK_MS);
  }

  byId("task-detail").addEventListener("close", () => { openCardId = null; });
  renderLegend();
  wireLegend();
  wireFilters();
  renderSwitch();

  return { start, refresh, tick, openDetail, toggleLive, filters,
    get view() { return currentView; }, get liveExpanded() { return liveExpanded; } };
}

if (typeof document !== "undefined" && document.getElementById("board-stages") && !globalThis.__BOARD_NO_AUTOMOUNT)
  mountBoard().start();
