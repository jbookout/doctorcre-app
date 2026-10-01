import { mountSystemWorkBoard } from './system-work-board.js';
import { createLiveClient } from "./live-client.js";
import { uuidv4 } from "./uuid.js";
import { boardView, answerRequest, taskPulse, SYSTEM_BOARD_ID, boardDirectory, boardFreshness, nextFreshnessChange } from "./progress-board-model.js";

const boardId = new URLSearchParams(location.search).get("board") || SYSTEM_BOARD_ID;
const client = createLiveClient();
const pendingRequests = new Map();
let questionCards = new Map();
const title = document.getElementById("board-title");
const meta = document.getElementById("board-meta");
const error = document.getElementById("board-error");
const retry = document.getElementById("board-retry");
const signIn = document.getElementById("board-sign-in");
const flow = document.getElementById("board-flow");
const taskDialog = document.getElementById("task-detail");
const taskDetailTitle = document.getElementById("task-detail-title");
const taskDetailBody = document.getElementById("task-detail-body");
const questions = document.getElementById("board-questions");
const taskCount = document.getElementById("task-count");
const questionCount = document.getElementById("question-count");
const directory = document.getElementById("board-directory");
const directoryError = document.getElementById("directory-error");
const freshness = document.getElementById("board-freshness");
const live = document.getElementById("board-live");
let directorySignature = "";
let viewSignature = "";
let refreshGeneration = 0;
const badgeTimes = new Map();
let ageTimer;
let taskNodes = new Map();
let renderedStages = "";
let detailTaskId = null;
let systemWork = null;

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
    { dateStyle: "medium", timeStyle: "short", hour12: true }).format(date);
}

function updateBadge(badge, updatedAt) {
  const age = boardFreshness(updatedAt);
  const label = `${age.label}${age.state === "stale" ? " · Stale · 24h+" : ""}`;
  if (badge.textContent !== label) badge.textContent = label;
  badge.setAttribute("data-freshness", age.state);
}

// This clock only patches badge nodes. It never reads the network or rebuilds
// controls, and wakes at publication-relative minute boundaries (including 24h).
function refreshAges() {
  clearTimeout(ageTimer);
  let delay = Infinity;
  for (const [badge, updatedAt] of badgeTimes) {
    if (badge.isConnected === false) { badgeTimes.delete(badge); continue; }
    updateBadge(badge, updatedAt);
    const next = nextFreshnessChange(updatedAt);
    if (next !== null) delay = Math.min(delay, next);
  }
  if (Number.isFinite(delay)) ageTimer = setTimeout(refreshAges, Math.min(delay, 60000));
}

function freshnessBadge(updatedAt) {
  const badge = element("span", "freshness-badge");
  badgeTimes.set(badge, updatedAt);
  updateBadge(badge, updatedAt);
  return badge;
}

document.addEventListener?.("visibilitychange", refreshAges);

function renderDirectory(read) {
  const boards = boardDirectory(read);
  directoryError.hidden = true;
  const signature = JSON.stringify(boards);
  if (signature === directorySignature || directory.contains(document.activeElement)) return;
  const changed = directorySignature && JSON.stringify(boards) !== directory.dataset?.boards;
  directorySignature = signature;
  directory.replaceChildren();
  if (directory.dataset) directory.dataset.boards = JSON.stringify(boards);
  for (const board of boards) {
    const link = element("a", "board-link");
    link.href = `/control-room/progress?board=${encodeURIComponent(board.board_id)}`;
    if (board.board_id === boardId) link.setAttribute("aria-current", "page");
    link.setAttribute("data-board-id", board.board_id);
    link.append(element("span", "eyebrow", board.board_id === SYSTEM_BOARD_ID ? "System-wide" : "Project"),
      element("h3", "", board.title || board.project || board.board_id));
    const published = element("time", "board-published", formatTime(board.updated_at) || "Publication time unavailable");
    if (board.updated_at) published.dateTime = board.updated_at;
    link.append(published, freshnessBadge(board.updated_at));
    const counts = Object.entries(board.task_counts || {}).map(([status, count]) => `${count} ${status}`).join(" · ");
    link.append(element("span", "board-counts", counts || "0 tasks"));
    directory.append(link);
  }
  if (!boards.length) directory.append(element("p", "empty", "No published boards."));
  refreshAges();
  if (changed) live.textContent = "Published boards updated.";
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
  row.append(element("dt", "", label), element("dd", "", value));
  taskDetailBody.append(row);
}

function showTask(task, stage) {
  detailTaskId = task.id;
  taskDetailTitle.textContent = task.title || task.id;
  taskDetailBody.replaceChildren();
  detailRow("Stage", stage.label);
  detailRow("Status", task.status);
  detailRow("Task", task.id);
  detailRow("Executor", task.executor);
  detailRow("PR", task.pr != null ? `#${task.pr}${task.pr_phase ? ` · ${task.pr_phase}` : ""}` : "No PR");
  detailRow("Updated", formatTime(task.updated_at));
  detailRow("Note", task.note);
  detailRow("Question", task.question);
  detailRow("Evidence", task.evidence);
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
  node.append(svg("text", "node-meta", { x: x + 12, y: y + height - 12 },
    [task.executor || "Unassigned", task.pr != null ? `PR ${task.pr}` : "No PR"].join(" · ")));
  const retained = taskNodes.get(task.id);
  const target = retained?.node || node;
  if (retained) {
    target.replaceChildren(...node.childNodes);
    for (const attribute of node.attributes) target.setAttribute(attribute.name, attribute.value);
  }
  const entry = { node: target, task, stage };
  taskNodes.set(task.id, entry);
  if (retained) return target;
  const open = () => {
    const current = taskNodes.get(task.id);
    if (current) showTask(current.task, current.stage);
  };
  node.addEventListener("click", open);
  node.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
  });
  return node;
}

function renderStages(view) {
  currentView = view;
  const phone = phoneQuery.matches;
  const signature = JSON.stringify([view.stages, phone]);
  if (signature === renderedStages) {
    for (const { node, task } of taskNodes.values()) node.setAttribute("data-pulse", taskPulse(task));
    return;
  }
  renderedStages = signature;
  const focusedId = [...taskNodes].find(([, entry]) => entry.node === document.activeElement)?.[0];
  flow.replaceChildren();
  const total = view.stages.reduce((sum, stage) => sum + stage.tasks.length, 0);
  taskCount.textContent = `${total} TASK${total === 1 ? "" : "S"}`;
  const width = phone ? 360 : 1200;
  const maxTasks = Math.max(1, ...view.stages.map(stage => stage.tasks.length));
  const height = phone ? view.stages.reduce((sum, stage) => sum + Math.max(106, 69 + stage.tasks.length * 88) + 21, 0) - 21
    : Math.max(270, 93 + maxTasks * 89);
  flow.setAttribute("viewBox", `0 0 ${width} ${height}`);
  flow.setAttribute("aria-label", `${total} tasks positioned across Queued, Building, Review, CI, Merged, and Live`);
  let offset = 0;
  view.stages.forEach((stage, index) => {
    const x = phone ? 8 : 8 + index * 199;
    const y = phone ? offset : 8;
    const wellWidth = phone ? 344 : 186;
    const wellHeight = phone ? Math.max(106, 69 + stage.tasks.length * 88) : height - 16;
    const group = svg("g", "flow-stage", { "data-stage": stage.id });
    group.append(svg("rect", "stage-well", { x, y, width: wellWidth, height: wellHeight, rx: 15 }));
    group.append(svg("text", "stage-index", { x: x + 15, y: y + 27 }, String(index + 1).padStart(2, "0")));
    group.append(svg("text", "stage-label", { x: x + 47, y: y + 28 }, stage.label));
    group.append(svg("text", "stage-count", { x: x + wellWidth - 14, y: y + 27, "text-anchor": "end" },
      String(stage.tasks.length).padStart(2, "0")));
    if (!stage.tasks.length) group.append(svg("text", "flow-empty", { x: x + 15, y: y + 79 }, "No tasks"));
    stage.tasks.forEach((task, taskIndex) => group.append(taskNode(task, stage, x + 9,
      y + 44 + taskIndex * (phone ? 88 : 89), wellWidth - 18, phone ? 78 : 79, phone)));
    flow.append(group);
    if (index < view.stages.length - 1) {
      const d = phone ? `M 180 ${y + wellHeight + 2} V ${y + wellHeight + 19}`
        : `M ${x + wellWidth + 2} 47 H ${x + 197}`;
      flow.append(svg("path", "pipeline-connector", { d, "aria-hidden": "true" }));
    }
    if (phone) offset += wellHeight + 21;
  });
  const ids = new Set(view.stages.flatMap(stage => stage.tasks.map(task => task.id)));
  for (const id of taskNodes.keys()) if (!ids.has(id)) taskNodes.delete(id);
  if (focusedId) (taskNodes.get(focusedId)?.node || title).focus();
}

taskDialog.addEventListener("close", () => {
  if (detailTaskId) (taskNodes.get(detailTaskId)?.node || title).focus();
  detailTaskId = null;
});

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
  const priorCards = questionCards;
  questionCards = new Map();
  const nextCards = [];
  questionCount.textContent = `${view.questions.filter(q => !q.status).length} WAITING`;
  if (!view.questions.length) {
    questions.replaceChildren(element("p", "empty", "No questions on this board."));
    return;
  }
  for (const q of view.questions) {
    const signature = JSON.stringify([view.board_id, q]);
    const retained = priorCards.get(q.question_id);
    if (retained?.signature === signature) {
      questionCards.set(q.question_id, retained);
      nextCards.push(retained.card);
      continue;
    }
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
    questionCards.set(q.question_id, { signature, card });
    nextCards.push(card);
  }
  // Keep unchanged form cards connected even when the board version changes.
  for (const [index, card] of nextCards.entries()) {
    if (questions.children[index] !== card) {
      if (questions.insertBefore) questions.insertBefore(card, questions.children[index] || null);
      else questions.append(card);
    }
  }
  for (const child of [...questions.children]) if (!nextCards.includes(child)) child.remove?.();
}

function clearBoard(state) {
  currentView = null;
  viewSignature = "";
  renderedStages = "";
  taskNodes.clear();
  questionCards.clear();
  pendingRequests.clear();
  detailTaskId = null;
  if (taskDialog.open) taskDialog.close();
  taskDetailTitle.textContent = "";
  taskDetailBody.replaceChildren();
  flow.replaceChildren();
  questions.replaceChildren();
  taskCount.textContent = "—";
  questionCount.textContent = "—";
  title.textContent = "Progress";
  document.title = "Progress · DoctorCRE";
  meta.textContent = state === "unpublished" ? "No published snapshot" : "Board access unavailable";
  badgeTimes.delete(freshness);
  freshness.textContent = "";
  freshness.removeAttribute?.("data-freshness");
  meta.setAttribute("data-read-state", state);
}

function clearDirectory() {
  directorySignature = "";
  directory.replaceChildren();
}

function readFailure(cause, target) {
  const unauthorized = cause.status === 401 || cause.status === 403;
  const state = cause.status === 401 ? "signed-out" : cause.status === 403 ? "unauthorized"
    : cause.code === "progress_read_timeout" ? "timeout"
      : globalThis.navigator?.onLine === false ? "offline" : "unavailable";
  let message;
  if (unauthorized) {
    message = cause.status === 401 ? "Your session ended. Sign in to read this board." : "You do not have access to this board.";
    if (cause.status === 401) { ++refreshGeneration; clearBoard(state); clearDirectory(); }
    else if (target === "board") clearBoard(state);
    else clearDirectory();
  } else {
    const label = state === "timeout" ? "The request timed out." : state === "offline" ? "You are offline." : "The read failed.";
    const retained = target === "board" ? Boolean(currentView) : Boolean(directorySignature);
    message = `${label} ${retained ? "Showing last-known publication." : "Publication unavailable."} Retry to read again.`;
  }
  if (target === "directory") {
    directoryError.textContent = message;
    directoryError.hidden = false;
    directoryError.setAttribute("data-read-state", state);
  } else {
    setError(message);
    meta.setAttribute("data-read-state", state);
    if (currentView) meta.textContent = `Last-known publication ${formatTime(currentView.updated_at)} · Version ${currentView.version}`;
  }
  if (cause.status === 401) signIn.hidden = false;
  retry.hidden = false;
  refreshAges();
}

async function refresh(force = false) {
  if (!force && questions.contains(document.activeElement)) return;
  const generation = ++refreshGeneration;
  if (systemWork) systemWork.refresh();
  client.listProgressBoards().then(read => {
    if (generation === refreshGeneration) renderDirectory(read);
  }).catch(cause => {
    if (generation === refreshGeneration) readFailure(cause, "directory");
  });
  const loaded = client.readProgressBoard({ board_id: boardId }).then(read => {
    if (generation !== refreshGeneration) return;
    const view = boardView(read);
    if (!view.version) {
      if (!systemWork) clearBoard("unpublished");
      else {
        meta.textContent = "No published system snapshot.";
        meta.setAttribute("data-read-state", "unpublished");
        badgeTimes.delete(freshness);
      }
      setError("This board has not been published yet.");
      retry.hidden = false;
      return;
    }
    setError("");
    signIn.hidden = true;
    title.textContent = view.title;
    document.title = `${view.title} · DoctorCRE`;
    meta.textContent = `Published ${formatTime(view.updated_at)} · Version ${view.version}`;
    meta.setAttribute("data-read-state", "published");
    badgeTimes.set(freshness, view.updated_at);
    refreshAges();
    const signature = JSON.stringify(view);
    if (signature === viewSignature) { if (!systemWork) renderStages(view); return; }
    live.textContent = viewSignature ? `${view.title} updated.` : `${view.title} loaded.`;
    viewSignature = signature;
    if (!systemWork) renderStages(view);
    renderQuestions(view);
  }).catch(cause => {
    if (generation !== refreshGeneration) return;
    readFailure(cause, "board");
    if (force) throw cause;
  });
  await loaded;
}

if (boardId === SYSTEM_BOARD_ID) systemWork = mountSystemWorkBoard({ client, onPipeline: renderStages });

retry.addEventListener("click", () => refresh(true).catch(() => {}));
refresh();
setInterval(() => refresh(), 15000);
