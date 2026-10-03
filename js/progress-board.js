import { mountProgressPipeline } from "./progress-pipeline.js";
import { boardIdFromPath, boardPageUrl } from "./progress-board-route.js";
import { mountSystemWorkBoard } from './system-work-board.js';
import { workDetailUrl } from './progress-work-model.js';
import { createLiveClient } from "./live-client.js";
import { uuidv4 } from "./uuid.js";
import { boardView, answerRequest, taskIdentity, taskSummary, SYSTEM_BOARD_ID, boardDirectory, boardFreshness, nextFreshnessChange } from "./progress-board-model.js";

const pathBoardId = boardIdFromPath(location.pathname || "");
const boardId = pathBoardId || new URLSearchParams(location.search).get("board") || SYSTEM_BOARD_ID;
if (pathBoardId) document.querySelector(".directory-panel").hidden = true;
document.getElementById('board-activity').href = workDetailUrl({board:boardId});
document.getElementById('board-parent-name').textContent = boardId === 'carr-v5' ? 'System board' : 'Project board';
const client = createLiveClient();
const pendingRequests = new Map();
let questionCards = new Map();
const title = document.getElementById("board-title");
const meta = document.getElementById("board-meta");
const error = document.getElementById("board-error");
const retry = document.getElementById("board-retry");
const signIn = document.getElementById("board-sign-in");
const flow = document.getElementById("board-flow");
const questions = document.getElementById("board-questions");
const taskCount = document.getElementById("task-count");
const questionCount = document.getElementById("question-count");
const completedList = document.getElementById("completed-list");
const completedCount = document.getElementById("completed-count");
const directory = document.getElementById("board-directory");
const directoryError = document.getElementById("directory-error");
const freshness = document.getElementById("board-freshness");
const live = document.getElementById("board-live");
let directorySignature = "";
let viewSignature = "";
let refreshGeneration = 0;
const badgeTimes = new Map();
let ageTimer;
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
    link.href = boardPageUrl(board.board_id);
    link.target = "_blank";
    link.rel = "noopener";
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

let currentView = null;
function showTask(task) {
  location.href = workDetailUrl({ board: boardId, task: task.id,
    workRequest: task.work_request || task.human_ref || (/^WR-\d+$/.test(task.id) ? task.id : null) });
}
const boardPipeline = mountProgressPipeline({ flow, taskCount, focusFallback: title, onTask: showTask });
const completedCards = new Map();

function renderCompleted(view) {
  const live = view.stages.find(stage => stage.id === "live");
  const signature = JSON.stringify(live.tasks);
  if (completedList.dataset.signature === signature) return;
  completedList.dataset.signature = signature;
  const focusedId = [...completedCards].find(([, entry]) => entry.card === document.activeElement)?.[0];
  completedList.replaceChildren();
  completedCount.textContent = `${live.tasks.length} LIVE`;
  if (!live.tasks.length) {
    completedList.append(element("p", "empty", "No live tasks yet."));
  }
  for (const task of live.tasks) {
    const identity = taskIdentity(task);
    const retained = completedCards.get(task.id);
    const card = retained?.card || element("article", "completed-card");
    const entry = { card, task };
    completedCards.set(task.id, entry);
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `${task.title || task.id}. Open task detail.`);
    card.replaceChildren(element("strong", "", task.title || task.id),
      element("p", "card-summary", taskSummary(task)),
      element("span", "card-provider", identity.provider),
      element("span", "card-model", `${identity.model} · ${identity.effort}`));
    if (!retained) {
      const open = () => showTask(completedCards.get(task.id).task);
      card.addEventListener("click", open);
      card.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
      });
    }
    completedList.append(card);
  }
  const ids = new Set(live.tasks.map(task => task.id));
  for (const id of completedCards.keys()) if (!ids.has(id)) completedCards.delete(id);
  if (focusedId) (completedCards.get(focusedId)?.card || document.getElementById("completed-title")).focus();
}


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
  boardPipeline.clear();
  questionCards.clear();
  pendingRequests.clear();
  flow.replaceChildren();
  completedList.replaceChildren();
  completedCards.clear();
  delete completedList.dataset.signature;
  completedCount.textContent = "—";
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
    : cause.code === "read_timeout" ? "timeout"
      : globalThis.navigator?.onLine === false ? "offline" : "unavailable";
  let message;
  if (unauthorized) {
    message = cause.status === 401 ? "Sign-in required" : "You do not have access to this board.";
    ++refreshGeneration;
    clearBoard(state);
    clearDirectory();
    systemWork?.clearAccess(cause);
  } else {
    const label = state === "timeout" ? "The request timed out." : state === "offline" ? "You are offline." : `Could not load board “${boardId}”. Retry to load its published tasks.`;
    message = label;
  }
  if (target === "directory") {
    directoryError.textContent = message;
    directoryError.hidden = false;
    directoryError.setAttribute("data-read-state", state);
  } else {
    setError(message);
    meta.setAttribute("data-read-state", state);
    if (currentView) meta.textContent = `Updated ${formatTime(currentView.updated_at)} ↻`;
  }
  if (cause.status === 401) signIn.hidden = false;
  retry.hidden = false;
  refreshAges();
}

async function refresh(force = false) {
  if (!force && questions.contains(document.activeElement)) return;
  const generation = ++refreshGeneration;
  if (systemWork) systemWork.refresh(false, { force });
  if (!pathBoardId) client.listProgressBoards().then(read => {
    if (generation === refreshGeneration) renderDirectory(read);
  }).catch(cause => {
    if (generation === refreshGeneration) readFailure(cause, "directory");
  });
  const loaded = client.readProgressBoard({ board_id: boardId }).then(read => {
    if (generation !== refreshGeneration) return;
    const view = boardView(read);
    if (!view.version) {
      clearBoard("unpublished");
      setError("This board has not been published yet.");
      retry.hidden = false;
      return;
    }
    currentView = view;
    setError("");
    retry.hidden = false;
    signIn.hidden = true;
    title.textContent = view.title;
    document.title = `${view.title} · DoctorCRE`;
    meta.textContent = `Published ${formatTime(view.updated_at)} · Version ${view.version}`;
    meta.setAttribute("data-read-state", "published");
    badgeTimes.set(freshness, view.updated_at);
    refreshAges();
    const signature = JSON.stringify(view);
    if (signature === viewSignature) { boardPipeline.render(view); return; }
    live.textContent = viewSignature ? `${view.title} updated.` : `${view.title} loaded.`;
    viewSignature = signature;
    boardPipeline.render(view);
    renderCompleted(view);
    renderQuestions(view);
  }).catch(cause => {
    if (generation !== refreshGeneration) return;
    readFailure(cause, "board");
    if (force) throw cause;
  });
  await loaded;
}

if (boardId === SYSTEM_BOARD_ID) systemWork = mountSystemWorkBoard({ client,
  onAccessDenied: cause => readFailure(cause, "board") });

retry.addEventListener("click", () => refresh(true).catch(() => {}));
refresh();
setInterval(() => refresh(), 15000);
