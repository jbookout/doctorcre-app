import { createLiveClient } from "./live-client.js";
import { uuidv4 } from "./uuid.js";
import { boardView, answerRequest, taskPulse, taskIdentity, taskSummary,
  relatedQuestions } from "./progress-board-model.js";

const boardId = new URLSearchParams(location.search).get("board");
const client = createLiveClient();
const pendingRequests = new Map();
const title = document.getElementById("board-title");
const meta = document.getElementById("board-meta");
const error = document.getElementById("board-error");
const stages = document.getElementById("board-stages");
const flow = document.getElementById("board-flow");
const taskDialog = document.getElementById("task-detail");
const taskDetailTitle = document.getElementById("task-detail-title");
const taskDetailBody = document.getElementById("task-detail-body");
const questions = document.getElementById("board-questions");
const taskCount = document.getElementById("task-count");
const questionCount = document.getElementById("question-count");
const completedList = document.getElementById("completed-list");
const completedCount = document.getElementById("completed-count");

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = String(content);
  return node;
}

function setError(message) {
  error.textContent = message || "";
  error.hidden = !message;
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(undefined,
    { dateStyle: "medium", timeStyle: "short" }).format(date);
}

const SVG_NS = "http://www.w3.org/2000/svg";
const phoneQuery = matchMedia("(max-width: 680px)");
let currentView = null;

function svg(tag, className, attributes = {}, content) {
  const node = document.createElementNS(SVG_NS, tag);
  if (className) node.setAttribute("class", className);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  if (content !== undefined) node.textContent = String(content);
  return node;
}

function detailRow(label, value) {
  if (value === undefined || value === null || value === "") return;
  const row = element("div", "detail-row");
  const detail = element("dd", "", value instanceof Node ? undefined : value);
  if (value instanceof Node) detail.append(value);
  row.append(element("dt", "", label), detail);
  taskDetailBody.append(row);
}

function safeLink(url, label) {
  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol)) return null;
    const link = element("a", "", label);
    link.href = parsed.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  } catch { return null; }
}

function showTask(task, stage) {
  const identity = taskIdentity(task);
  taskDetailTitle.textContent = task.title || task.id;
  taskDetailBody.replaceChildren();
  detailRow("Summary", taskSummary(task));
  detailRow("Stage", stage.label);
  detailRow("Status", task.status);
  detailRow("Task", task.id);
  detailRow("Provider", identity.provider);
  detailRow("Model", identity.model);
  detailRow("Effort", identity.effort);
  detailRow("Repository", task.repo || "jbookout/carr-system");
  if (task.pr != null) {
    const repo = task.repo || "jbookout/carr-system";
    const link = /^[\w.-]+\/[\w.-]+$/.test(repo)
      ? safeLink(`https://github.com/${repo}/pull/${Number(task.pr)}`,
        `PR #${task.pr}${task.pr_head ? ` · ${task.pr_head}` : ""}`) : null;
    detailRow("Pull request", link || `PR #${task.pr}`);
  }
  detailRow("Review", task.review_verdict || task.pr_phase || "Not recorded");
  detailRow("CI", task.pr_checks || "Not recorded");
  detailRow("Created", formatTime(task.created_at));
  detailRow("Updated", formatTime(task.updated_at));
  detailRow("Completed", formatTime(task.completed_at));
  detailRow("Note", task.note);
  detailRow("Question", task.question);
  detailRow("Evidence", task.evidence);
  for (const url of String(task.evidence || "").match(/https?:\/\/[^\s;,]+/g) || []) {
    const link = safeLink(url.replace(/[.)]+$/, ""), url.replace(/[.)]+$/, ""));
    if (link) detailRow("Evidence link", link);
  }
  for (const question of relatedQuestions(task, currentView?.questions || [])) {
    detailRow("Board question", question.prompt);
    detailRow("Answer", question.answer_text || `Waiting · ${question.default_answer || "No default recorded"}`);
  }
  for (const event of task.stage_history || [])
    detailRow("Stage history", `${event.stage || ""} · ${event.status || ""} · ${formatTime(event.at)}`);
  taskDialog.showModal();
}

function titleLines(value, width) {
  const words = String(value).split(/\s+/).filter(Boolean);
  const lines = [];
  for (const word of words) {
    const last = lines.length - 1;
    if (last >= 0 && `${lines[last]} ${word}`.length <= width) lines[last] += ` ${word}`;
    else lines.push(word);
  }
  if (lines.length > 2) return [lines[0], `${lines[1].slice(0, width - 1)}…`];
  return lines;
}

function taskNode(task, stage, x, y, width, height, phone) {
  const pulse = taskPulse(task);
  const identity = taskIdentity(task);
  const node = svg("g", "pipeline-node", { "data-task-id": task.id, "data-stage": stage.id,
    "data-pulse": pulse, role: "button", tabindex: 0,
    "aria-label": `${task.title || task.id}, ${stage.label}. Open task detail.` });
  node.append(svg("rect", "node-shape", { x, y, width, height, rx: 12 }));
  node.append(svg("circle", "node-halo", { cx: x + 20, cy: y + 23, r: 8 }));
  node.append(svg("circle", "node-pulse", { cx: x + 20, cy: y + 23, r: 12 }));
  const title = String(task.title || task.id);
  const lines = titleLines(title, phone ? 38 : 18);
  const label = svg("text", "node-label", { x: x + 35, y: y + 26 });
  for (const [index, line] of lines.entries()) {
    label.append(svg("tspan", "", { x: x + 35, dy: index ? 14 : 0 }, line));
  }
  node.append(label);
  const summary = taskSummary(task);
  const summaryLimit = phone ? 46 : 24;
  node.append(svg("text", "node-summary", { x: x + 12, y: y + height - 42 },
    summary.length > summaryLimit ? `${summary.slice(0, summaryLimit - 1)}…` : summary));
  node.append(svg("text", "node-meta", { x: x + 12, y: y + height - 27 }, identity.provider));
  node.append(svg("text", "node-meta", { x: x + 12, y: y + height - 13 },
    `${identity.model} · ${identity.effort}`));
  node.addEventListener("click", () => showTask(task, stage));
  node.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); showTask(task, stage); }
  });
  return node;
}

function renderStages(view) {
  currentView = view;
  flow.replaceChildren();
  const phone = phoneQuery.matches;
  const total = view.stages.reduce((sum, stage) => sum + stage.tasks.length, 0);
  taskCount.textContent = `${total} TASK${total === 1 ? "" : "S"}`;
  const width = phone ? 360 : 1200;
  const maxTasks = Math.max(1, ...view.stages.map(stage => stage.tasks.length));
  const height = phone ? view.stages.reduce((sum, stage) => sum + Math.max(106, 69 + stage.tasks.length * 115) + 21, 0) - 21
    : Math.max(270, 93 + maxTasks * 115);
  flow.setAttribute("viewBox", `0 0 ${width} ${height}`);
  flow.setAttribute("aria-label", `${total} tasks positioned across Queued, Building, Review, CI, Merged, and Live`);
  let offset = 0;
  view.stages.forEach((stage, index) => {
    const x = phone ? 8 : 8 + index * 199;
    const y = phone ? offset : 8;
    const wellWidth = phone ? 344 : 186;
    const wellHeight = phone ? Math.max(106, 69 + stage.tasks.length * 115) : height - 16;
    const group = svg("g", "flow-stage", { "data-stage": stage.id });
    group.append(svg("rect", "stage-well", { x, y, width: wellWidth, height: wellHeight, rx: 15 }));
    group.append(svg("text", "stage-index", { x: x + 15, y: y + 27 }, String(index + 1).padStart(2, "0")));
    group.append(svg("text", "stage-label", { x: x + 47, y: y + 28 }, stage.label));
    group.append(svg("text", "stage-count", { x: x + wellWidth - 14, y: y + 27, "text-anchor": "end" },
      String(stage.tasks.length).padStart(2, "0")));
    if (!stage.tasks.length) group.append(svg("text", "flow-empty", { x: x + 15, y: y + 79 }, "No tasks"));
    stage.tasks.forEach((task, taskIndex) => group.append(taskNode(task, stage, x + 9,
      y + 44 + taskIndex * 115, wellWidth - 18, 106, phone)));
    flow.append(group);
    if (index < view.stages.length - 1) {
      const d = phone ? `M 180 ${y + wellHeight + 2} V ${y + wellHeight + 19}`
        : `M ${x + wellWidth + 2} 47 H ${x + 197}`;
      flow.append(svg("path", "pipeline-connector", { d, "aria-hidden": "true" }));
    }
    if (phone) offset += wellHeight + 21;
  });
}

function renderCompleted(view) {
  const live = view.stages.find(stage => stage.id === "live");
  completedList.replaceChildren();
  completedCount.textContent = `${live.tasks.length} LIVE`;
  if (!live.tasks.length) {
    completedList.append(element("p", "empty", "No live tasks yet."));
    return;
  }
  for (const task of live.tasks) {
    const identity = taskIdentity(task);
    const card = element("article", "completed-card");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `${task.title || task.id}. Open task detail.`);
    card.append(element("strong", "", task.title || task.id),
      element("p", "card-summary", taskSummary(task)),
      element("span", "card-provider", identity.provider),
      element("span", "card-model", `${identity.model} · ${identity.effort}`));
    card.addEventListener("click", () => showTask(task, live));
    card.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); showTask(task, live); }
    });
    completedList.append(card);
  }
}

phoneQuery.addEventListener("change", () => { if (currentView) renderStages(currentView); });

function answerForm(q, view) {
  const form = element("form", "answer-form");
  const message = element("p", "form-message");
  let choiceInputs = [];
  let freeText = null;
  if (q.choices.length) {
    const options = element("div", "answer-options");
    for (const [index, choice] of q.choices.entries()) {
      const id = `choice-${q.question_id}-${index}`;
      const label = element("label", "answer-option");
      const input = element("input");
      input.type = "radio";
      input.name = `answer-${q.question_id}`;
      input.value = choice;
      input.id = id;
      choiceInputs.push(input);
      label.append(input, element("span", "", choice));
      options.append(label);
    }
    form.append(options);
  }
  if (q.allow_free_text) {
    const id = `free-${q.question_id}`;
    const label = element("label", "", q.choices.length ? "Or write your answer" : "Your answer");
    label.htmlFor = id;
    freeText = element("textarea");
    freeText.id = id;
    freeText.maxLength = 4000;
    freeText.placeholder = "Type your answer";
    form.append(label, freeText);
  }
  if (q.default_answer) form.append(element("p", "question-detail", `If unanswered: ${q.default_answer}`));
  const button = element("button", "", "Send answer");
  button.type = "submit";
  const preview = element("output", "answer-preview");
  preview.setAttribute("aria-live", "polite");
  const actions = element("div", "answer-actions");
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
      message.textContent = cause.payload?.error === "board_version_conflict" ||
        cause.payload?.error === "board_answer_already_sent"
        ? "This question changed or was answered elsewhere. Refreshing…"
        : "Answer status is unconfirmed. Retry will use the same request.";
      if (cause.payload?.error === "board_version_conflict" || cause.payload?.error === "board_answer_already_sent") {
        pendingRequests.delete(q.question_id);
        await refresh(true).catch(() => {});
      }
    }
  });
  return form;
}

function renderQuestions(view) {
  questions.replaceChildren();
  questionCount.textContent = `${view.questions.filter(q => !q.status).length} WAITING`;
  if (!view.questions.length) {
    questions.append(element("p", "empty", "No questions on this board."));
    return;
  }
  for (const q of view.questions) {
    const card = element("article", "question-card");
    if (q.status) card.dataset.status = q.status;
    const top = element("div", "question-top");
    top.append(element("h3", "question-title", q.prompt), element("span", "status", q.status || "Waiting"));
    card.append(top);
    if (q.status) {
      card.append(element("p", "answer-text", q.answer_text || ""));
      const detail = [q.answered_by ? `Answered by ${q.answered_by}` : null,
        q.status === "Applied" && q.effect_ref ? `Applied: ${q.effect_ref}` : null]
        .filter(Boolean).join(" · ");
      if (detail) card.append(element("p", "question-detail", detail));
    } else {
      card.append(answerForm(q, view));
    }
    questions.append(card);
  }
}

async function refresh(force = false) {
  if (!boardId) { setError("Open a published board link to choose a project."); meta.textContent = "No board selected"; return; }
  if (!force && questions.contains(document.activeElement)) return;
  const read = await client.readProgressBoard({ board_id: boardId });
  const view = boardView(read);
  if (!view.version) { setError("This board has not been published yet."); return; }
  setError("");
  title.textContent = view.title;
  document.title = `${view.title} · DoctorCRE`;
  meta.textContent = `${view.board_id} · Published ${formatTime(view.updated_at)} · Version ${view.version}`;
  renderStages(view);
  renderCompleted(view);
  renderQuestions(view);
}

refresh().catch(() => setError("The board could not be loaded. Refresh to try again."));
setInterval(() => refresh().catch(() => setError("The board could not be refreshed.")), 15000);
