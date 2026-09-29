import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

import { createLiveClient } from "../js/live-client.js";
import {
  STAGES, EXECUTORS, PULSES, INDICATORS, LIVE_PREVIEW, LIVE_PREF_KEY, legendEntries, boardView, answerRequest,
  taskStage, taskHealth, taskPulse, blockedDetail, isStale, stageTimer, stageDurations, taskIdentity, taskSummary,
  relatedQuestions, cardIndicators, sortLive, filterCards, groupByRepo, boardFromSearch, prLabel,
} from "../js/progress-board-model.js";
import { mountBoard } from "../js/progress-board.js";
import { handleDoctorcreRequest } from "../src/worker.js";

const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const host = `https://${config.env.staging.name}.workers.dev`;
const FULL = JSON.parse(await readFile(new URL("./fixtures/progress-board-full.json", import.meta.url), "utf8"));
const REF = new Date(FULL.reference_time);
const PAGE = await readFile(new URL("../progress-board.html", import.meta.url), "utf8");
const CSS = await readFile(new URL("../css/progress-board.css", import.meta.url), "utf8");

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: key => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)), data };
}

async function mount(read, { now = REF, storage = memoryStorage(), search = "?board=carr-v5" } = {}) {
  const dom = new JSDOM(PAGE, { url: `https://app.doctorcre.com/progress-board${search}` });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  const writes = [];
  let clock = new Date(now);
  const client = {
    readProgressBoard: async () => structuredClone(read),
    answerBoardQuestion: async args => { writes.push(args); return { ok: true }; },
  };
  const board = mountBoard({ window, document: window.document, client, storage, search,
    now: () => clock, setInterval: () => 0 });
  await board.refresh(true);
  const doc = window.document;
  return { board, window, doc, writes, storage, setNow: value => { clock = new Date(value); },
    $: selector => doc.querySelector(selector), $$: selector => [...doc.querySelectorAll(selector)] };
}

test("shared producer stage, health, blocked and stale fixtures match the published board view", async () => {
  const fixtures = JSON.parse(await readFile(new URL("../test/fixtures/progress-board-stages.json", import.meta.url), "utf8"));
  const generator = await readFile(new URL("../scripts/generate-progress-board-parity.py", import.meta.url), "utf8");
  assert.ok(generator.includes(`PIN = "${fixtures.producer_source_commit}"`),
    "the board fixture stays bound to the producer commit that generated it");
  assert.deepEqual(new Set(fixtures.cases.map(({ producer_health }) => producer_health)),
    new Set(["healthy", "question", "blocked"]), "every producer health class is represented");
  for (const stage of STAGES.map(item => item.id))
    for (const health of ["healthy", "question", "blocked"])
      assert.ok(fixtures.cases.some(row => row.task.stage === stage && row.task.health === health),
        `${stage}/${health} producer row is missing`);
  const at = new Date(fixtures.reference_time);
  for (const row of fixtures.cases) {
    assert.equal(taskStage(row.task), row.stage, `${row.id}: stage`);
    assert.equal(STAGES.find(item => item.id === row.stage)?.label, row.stage_label, `${row.id}: label`);
    assert.equal(taskHealth(row.task, at), row.producer_health, `${row.id}: health`);
    assert.equal(taskPulse(row.task, at), row.pulse, `${row.id}: pulse`);
    assert.equal(isStale(row.task, at), row.stale, `${row.id}: stale`);
    assert.equal(stageTimer(row.task, at), row.stage_timer, `${row.id}: stage timer`);
    const blocked = blockedDetail(row.task, at);
    assert.deepEqual(blocked ? [blocked.reason, blocked.next] : null, row.blocked, `${row.id}: blocked detail`);
  }
});

test("progress board route requires the existing signed-in CARR page gate", async () => {
  const gated = [];
  const env = {
    CARR: { fetch: async (request) => {
      gated.push(request);
      return new Response(null, { status: 302, headers: { location: `${host}/auth/login` } });
    } },
    ASSETS: { fetch: async () => { throw Error("signed-out board must not load"); } },
  };
  const signedOut = await handleDoctorcreRequest(new Request(`${host}/control-room/progress?board=project-one`), env);
  assert.equal(signedOut.status, 302);
  assert.equal(new URL(gated[0].url).pathname, "/control-room");
  env.CARR.fetch = async (request) => { gated.push(request); return new Response(); };
  env.ASSETS.fetch = async (request) => new Response(new URL(request.url).pathname);
  const signedIn = await handleDoctorcreRequest(new Request(`${host}/control-room/progress`), env);
  assert.equal(await signedIn.text(), "/progress-board.html");
});

test("/progress-board?board=all-repos keeps its board through the redirect and is accepted", async () => {
  const env = { CARR: { fetch: async () => new Response() }, ASSETS: { fetch: async () => new Response("") } };
  const response = await handleDoctorcreRequest(new Request(`${host}/progress-board?board=all-repos`), env);
  assert.equal(response.status, 308);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.pathname, "/control-room/progress");
  assert.equal(location.searchParams.get("board"), "all-repos");
  assert.equal(boardFromSearch("?board=all-repos"), "all-repos");
  assert.equal(boardFromSearch("?board=<script>"), null);
});

test("the static page is gone: the app page renders every section from a full fixture", async () => {
  const { $, $$, doc } = await mount(FULL.project);
  assert.equal($("#board-title").textContent, "CARR v5 delivery");
  assert.equal($$("#board-stages .column").length, 6, "pipeline");
  assert.ok($$("#board-blocked .blocked-card").length >= 3, "blocked cards with reason and next action");
  assert.match($("#board-blocked").textContent, /Why: Waiting on the production database key/);
  assert.match($("#board-blocked").textContent, /Next: Joe adds CARR_DB_URL to the Mac keychain/);
  assert.match($("#board-questions").textContent, /Release tonight or tomorrow\?/, "open questions");
  assert.ok($("#board-questions form.answer-form"), "answer form");
  assert.match($("#board-questions").textContent, /No, one board only/, "answers");
  assert.match($("#board-decisions").textContent, /Which accent for Live\?.*Green/s, "decision panel");
  assert.match($("#board-deliverables").textContent, /Board contract spec/, "delivery panel");
  assert.equal($("#board-deliverables a").getAttribute("href"), "https://example.com/spec");
  assert.equal($$("#board-deliverables a").length, 1, "unsafe links stay text");
  assert.match($("#board-notes").textContent, /Deploy freeze after 5pm CT\./, "notes");
  const codex = $('#board-ledger [data-pool="codex"]');
  assert.match(codex.textContent, /Codex · gpt-6-sol · high ×9/, "ledger with provider, model and effort");
  assert.ok($('#board-ledger [data-pool="claude-cloud"].ledger-violation'), "policy violation flagged");
  assert.equal($$("#board-completed .completed-card").length, 7, "completed history");
  assert.ok($$("#legend-body [data-legend-id]").length >= INDICATORS.length, "legend");
  assert.ok($("#board-headline").textContent.includes("blocked"), "headline");
  doc.querySelector('[data-card-id="build-card"]').click();
  assert.ok($("#task-detail").hasAttribute("open"), "card detail pop-up");
});

test("every indicator the renderer emits has a legend entry, from the same constants", async () => {
  const legendIds = new Set(legendEntries().flatMap(group => group.entries.map(entry => entry.id)));
  for (const stage of STAGES) assert.ok(legendIds.has(`stage-${stage.id}`), stage.id);
  for (const executor of EXECUTORS) assert.ok(legendIds.has(`glyph-${executor.pool}`), executor.pool);
  for (const pulse of PULSES) assert.ok(legendIds.has(`pulse-${pulse.id}`), pulse.id);
  for (const read of [FULL.project, FULL.all_repos]) {
    const { $$ } = await mount(read, { search: `?board=${read.snapshot.board_id}` });
    const shownLegend = new Set($$("#legend-body [data-legend-id]").map(node => node.dataset.legendId));
    const emitted = new Set($$("[data-indicators]").flatMap(node => node.dataset.indicators.split(" ")));
    assert.ok(emitted.size > 8, "the fixture exercises many indicators");
    for (const id of emitted) assert.ok(shownLegend.has(id), `indicator ${id} has no legend entry`);
    for (const id of ["outline-dashed", "badge-question", "flag-stale"])
      assert.ok(emitted.has(id) || read === FULL.all_repos, `project fixture shows ${id}`);
  }
  // A seeded indicator without a legend entry is caught by the same check.
  const unknown = cardIndicators({ status: "running", updated_at: FULL.reference_time }, REF)
    .concat("glyph-mystery").filter(id => !legendIds.has(id));
  assert.deepEqual(unknown, ["glyph-mystery"]);
  // The legend samples use the renderer's own values.
  const { $ } = await mount(FULL.project);
  assert.match($('[data-legend-id="pulse-critical"] .legend-pulse').getAttribute("style"), /--pulse-speed:1s/);
  assert.match($('[data-legend-id="pulse-healthy"] .legend-pulse').getAttribute("style"), /--pulse-speed:3\.5s/);
  assert.match($('[data-legend-id="stage-build"] .swatch').getAttribute("style"), /#fb7b32/);
  assert.equal($('[data-legend-id="glyph-codex"] .glyph').textContent, "C");
  const card = $('[data-card-id="ci-card"]');
  assert.match(card.getAttribute("style"), /--pulse-speed:1s/);
  assert.match(card.getAttribute("style"), /--stage-accent:#ff88bd/);
  assert.equal(card.querySelector(".glyph").textContent, "G");
});

test("legend is one tap away and closes with Escape", async () => {
  const { $, window } = await mount(FULL.project);
  const toggle = $("#legend-toggle");
  assert.equal($("#legend").hidden, true);
  toggle.click();
  assert.equal($("#legend").hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal($("#legend").hidden, true);
  assert.match(CSS, /\.legend-toggle \{ position: fixed;/);
});

test("Live sorts newest first: highest PR first within a repo, all-repos by release time", () => {
  const project = [
    { id: "a", pr: 10, repo: "jbookout/carr-system", completed_at: "2026-09-29T11:00:00Z" },
    { id: "b", pr: 12, repo: "jbookout/carr-system", completed_at: "2026-09-29T09:00:00Z" },
    { id: "c", pr: 5, repo: "jbookout/doctorcre-app", completed_at: "2026-09-29T10:00:00Z" },
    { id: "d", completed_at: "2026-09-29T08:00:00Z" },
    { id: "e", pr: 11, repo: "jbookout/carr-system", completed_at: "2026-09-29T07:00:00Z" },
  ];
  assert.deepEqual(sortLive(project).map(card => card.id), ["b", "c", "e", "d", "a"]);
  const all = [
    { id: "old", pr: 99, completed_at: "2026-09-29T08:00:00Z" },
    { id: "new", pr: 3, completed_at: "2026-09-29T11:30:00Z" },
    { id: "mid", pr: 50, completed_at: "2026-09-29T10:00:00Z" },
  ];
  assert.deepEqual(sortLive(all, "all-repos").map(card => card.id), ["new", "mid", "old"]);
  const view = boardView(FULL.all_repos, REF);
  assert.deepEqual(view.stages.find(stage => stage.id === "live").tasks.map(card => card.id).slice(0, 3),
    ["doctorcre-app-96", "carr-system-1398", "carr-system-1404"]);
});

test("Live collapses by default to the newest few, expands with one control, and remembers per viewer", async () => {
  const storage = memoryStorage();
  const first = await mount(FULL.project, { storage });
  const live = () => first.$('.column[data-stage="live"]');
  assert.equal(live().dataset.collapsed, "true");
  assert.equal(live().querySelectorAll(".board-card").length, LIVE_PREVIEW);
  assert.match(live().querySelector(".live-summary").textContent, /7 live · latest 5 shown/);
  const shownIds = [...live().querySelectorAll(".board-card")].map(node => node.dataset.cardId);
  const expected = sortLive(boardView(FULL.project, REF).stages.find(stage => stage.id === "live").tasks)
    .slice(0, LIVE_PREVIEW).map(card => card.id);
  assert.deepEqual(shownIds, expected, "collapsed view shows the newest cards");
  const button = first.$("#live-toggle");
  assert.equal(button.textContent, "Show all 7");
  assert.equal(button.getAttribute("aria-expanded"), "false");
  button.click();
  assert.equal(live().querySelectorAll(".board-card").length, 7);
  assert.equal(first.$("#live-toggle").getAttribute("aria-expanded"), "true");
  assert.equal(storage.getItem(LIVE_PREF_KEY), "1");
  const again = await mount(FULL.project, { storage });
  assert.equal(again.$('.column[data-stage="live"]').querySelectorAll(".board-card").length, 7, "choice remembered");
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const locked = await mount(FULL.project, { storage: broken });
  assert.equal(locked.$('.column[data-stage="live"]').querySelectorAll(".board-card").length, LIVE_PREVIEW);
  locked.$("#live-toggle").click();
  assert.equal(locked.$('.column[data-stage="live"]').querySelectorAll(".board-card").length, 7, "works without storage");
});

test("stage timer reads stage_entered_at, updates live, and the pop-up shows history with durations", async () => {
  const task = { status: "running", stage: "build", stage_entered_at: "2026-09-29T09:46:00Z", updated_at: "2026-09-29T11:59:00Z" };
  assert.equal(stageTimer(task, REF), "build 2h 14m");
  assert.equal(stageTimer({ status: "review", stage_entered_at: "2026-09-29T11:25:00Z", updated_at: "2026-09-29T11:59:00Z" }, REF), "review 35m");
  assert.deepEqual(stageDurations({ stage_history: [{ stage: "queued", entered_at: "2026-09-29T09:00:00Z" },
    { stage: "build", entered_at: "2026-09-29T09:46:00Z" }] }, REF).map(row => row.duration), ["46m", "2h 14m"]);
  const { $, board, setNow } = await mount(FULL.project);
  const timer = $('[data-card-id="build-card"] .stage-timer');
  assert.equal(timer.textContent, "build 2h 14m");
  assert.ok(timer.closest(".card-meta"), "the timer sits in the muted meta line");
  assert.equal(timer.classList.contains("badge-question"), false);
  setNow("2026-09-29T12:10:00Z");
  board.tick();
  assert.equal(timer.textContent, "build 2h 24m", "moves without a reload");
  $('[data-card-id="build-card"]').click();
  const history = $("#task-detail .stage-history");
  assert.ok(history);
  assert.deepEqual([...history.querySelectorAll("li")].map(li => li.dataset.stage), ["queued", "build"]);
  assert.match(history.textContent, /Queued 46m/);
  assert.match(history.textContent, /Building 2h 24m/);
});

test("stale cards flag their last-update age; live cards never show a leftover blocked flag", async () => {
  assert.equal(isStale({ status: "running", updated_at: "2026-09-29T06:00:00Z" }, REF), true);
  assert.equal(isStale({ status: "running", updated_at: "2026-09-29T06:00:01Z" }, REF), false);
  assert.equal(isStale({ status: "done", updated_at: "2026-09-20T06:00:00Z" }, REF), false);
  const { $ } = await mount(FULL.project);
  const stale = $('[data-card-id="stale-card"] .flag-stale');
  assert.equal(stale.textContent, "stale 7h 0m");
  assert.equal($('.board-card[data-card-id="live-0"]'), null, "live-0 is older than the collapsed preview");
  assert.doesNotMatch($('.completed-card[data-card-id="live-0"]').textContent, /blocked/i);
  const view = boardView(FULL.project, REF);
  const card = view.cards.find(item => item.id === "live-0");
  assert.equal(card.health, "healthy");
  assert.equal(card.blocked, null);
  assert.equal($('#board-blocked [data-card-id="live-0"]'), null);
});

test("every blocked card shows the reason and the next action", async () => {
  const { $$ } = await mount(FULL.project);
  const cards = $$('.board-card[data-indicators~="outline-dashed"]');
  assert.ok(cards.length >= 3);
  for (const card of cards) {
    const text = card.querySelector(".card-blocked")?.textContent || "";
    assert.match(text, /Why: .+/, card.dataset.cardId);
    assert.match(text, /Next: .+/, card.dataset.cardId);
  }
  assert.match($$('[data-card-id="ci-card"] .card-blocked')[0].textContent, /CI checks are failing/);
});

test("merged but unreleased cards say they are waiting on release, with the pipeline's reason", async () => {
  const { $ } = await mount(FULL.project);
  const wait = $('[data-card-id="merged-card"] .card-wait');
  assert.equal(wait.textContent, "Waiting on release · release pipeline failed at canary: canary pending");
  $('[data-card-id="merged-card"]').click();
  assert.match($("#task-detail").textContent, /Waiting on release.*canary pending/s);
});

test("model line is one line with an ellipsis, full text on hover and in the pop-up", async () => {
  const { $ } = await mount(FULL.project);
  const model = $('[data-card-id="build-card"] .card-model');
  const full = `Codex · ${taskIdentity(boardView(FULL.project, REF).cards.find(c => c.id === "build-card")).model} · xhigh`;
  assert.equal(model.textContent, full);
  assert.equal(model.getAttribute("title"), full);
  assert.match(CSS, /\.card-summary, \.card-model, \.card-wait, \.card-meta \{[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  assert.match(CSS, /\.board-card \{[^}]*min-width: 0;[^}]*overflow: hidden;/);
  assert.match(CSS, /\.column \{ min-width: 0;/);
  $('[data-card-id="build-card"]').click();
  const rows = [...$("#task-detail").querySelectorAll(".detail-row")].map(row => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]);
  assert.ok(rows.some(([label, value]) => label === "Model line" && value === full), "full model text in the pop-up");
});

test("all-repos board groups by repo, keys cards per repo, and filters by repo, stage and blocked", async () => {
  const { $, $$, board } = await mount(FULL.all_repos, { search: "?board=all-repos" });
  assert.equal($("#repos-panel").hidden, false);
  assert.equal($$("#board-repos .repo-chip").length, 4);
  assert.ok($('#board-repos [data-repo="jbookout/tour-lab"].repo-error'));
  const carr = $('[data-card-id="carr-system-93"]');
  const app = $('[data-card-id="doctorcre-app-93"]');
  assert.ok(carr && app && carr !== app, "equal PR numbers never collide");
  assert.equal(carr.querySelector(".card-pr").textContent, "carr-system #93");
  assert.equal(app.querySelector(".card-pr").textContent, "doctorcre-app #93");
  assert.equal(prLabel({ pr: 93, repo: "jbookout/doctorcre-app" }), "doctorcre-app #93");
  const review = $('.column[data-stage="review"]');
  assert.deepEqual([...review.querySelectorAll(".repo-group")].map(node => node.textContent), ["carr-system", "doctorcre-app"]);
  assert.match(carr.querySelector(".card-summary").textContent, /One line about 93\./);
  assert.equal($("#switch-all").hasAttribute("aria-current"), true);
  const count = () => $$("#board-stages .board-card").length;
  const total = count();
  const repo = $("#filter-repo");
  repo.value = "jbookout/doctorcre-app";
  repo.dispatchEvent(new repo.ownerDocument.defaultView.Event("change"));
  assert.ok($$("#board-stages .board-card").every(node => node.querySelector(".card-pr").textContent.startsWith("doctorcre-app")));
  repo.value = "";
  repo.dispatchEvent(new repo.ownerDocument.defaultView.Event("change"));
  assert.equal(count(), total);
  const blocked = $("#filter-blocked");
  blocked.checked = true;
  blocked.dispatchEvent(new blocked.ownerDocument.defaultView.Event("change"));
  assert.deepEqual($$("#board-stages .board-card").map(node => node.dataset.cardId).sort(), ["carr-system-1416", "carr-system-1417", "doctorcre-app-93"]);
  blocked.checked = false;
  blocked.dispatchEvent(new blocked.ownerDocument.defaultView.Event("change"));
  const stage = $("#filter-stage");
  stage.value = "merged";
  stage.dispatchEvent(new stage.ownerDocument.defaultView.Event("change"));
  assert.deepEqual($$("#board-stages .board-card").map(node => node.dataset.cardId), ["carr-system-1400"]);
  assert.deepEqual(board.filters, { repo: "", stage: "merged", blockedOnly: false });
  const view = boardView(FULL.all_repos, REF);
  assert.deepEqual(groupByRepo(filterCards(view.cards, { stage: "review" })).map(group => group.repo),
    ["jbookout/carr-system", "jbookout/doctorcre-app"]);
});

test("board view reads v1 snapshots and typed questions, keeping status from CARR only", () => {
  const view = boardView({
    snapshot: { board_id: "project-one", version: 4, snapshot_json: {
      title: "Launch", project: "project-one",
      tasks: { build: { title: "Build API", status: "running", stage: "build" },
        ship: { title: "Ship app", status: "review", stage: "review" } },
    } },
    questions: [
      { question_id: "color", revision: 2, prompt: "Choose a color", choices: ["Blue", "Green"], allow_free_text: false, status: null },
      { question_id: "note", revision: 1, prompt: "Add a note", choices: [], allow_free_text: true, answer_text: "Keep going", status: "Received" },
    ],
  });
  assert.equal(view.title, "Launch");
  assert.equal(view.kind, "project");
  assert.equal(view.schema, "carr-progress-board.v1");
  assert.equal(view.stages.find(stage => stage.id === "build").tasks[0].title, "Build API");
  assert.equal(view.questions[0].status, null);
  assert.equal(view.questions[1].status, "Received");
  assert.ok(view.ledger.find(row => row.pool === "unassigned"), "ledger derived for a v1 snapshot");
});

test("legacy executor cards expose provider, model, effort and one-line summaries", () => {
  assert.deepEqual(taskIdentity({ executor: "gpt-6-sol high (Codex)" }), { provider: "Codex", model: "gpt-6-sol", effort: "high" });
  assert.deepEqual(taskIdentity({ executor: "orchestrator" }), { provider: "Anthropic", model: "Claude Opus 5.5", effort: "unknown" });
  assert.deepEqual(taskIdentity({ executor: "grok 4.7 medium" }), { provider: "xAI", model: "grok 4.7 medium", effort: "medium" });
  assert.equal(taskSummary({ title: "Build board", summary: "Show model and effort on every card." }), "Show model and effort on every card.");
  assert.equal(taskSummary({ title: "Coordinate delivery" }), "Coordinate delivery.");
  const task = { id: "build", question_ids: ["choice"] };
  const questions = [{ question_id: "choice", prompt: "Ship this?" }, { question_id: "other", prompt: "Unrelated" }];
  assert.deepEqual(relatedQuestions(task, questions), [questions[0]]);
});

test("answer request uses the question revision and carries no actor or status claim", () => {
  assert.deepEqual(answerRequest({ question_id: "color", revision: 2, choices: ["Blue", "Green"], allow_free_text: false },
    "project-one", "Blue", "same-key"), {
    board_id: "project-one", question_id: "color", base_version: 2, answer_text: "Blue", idempotency_key: "same-key",
  });
  assert.throws(() => answerRequest({ question_id: "color", revision: 2, choices: ["Blue"], allow_free_text: false },
    "project-one", "Green", "same-key"), /Choose/);
});

test("live client sends answer through same-origin MCP with the retained key", async () => {
  const calls = [];
  const client = createLiveClient({ fetchImpl: async (path, init) => {
    calls.push({ path, init });
    return new Response(JSON.stringify({ result: { content: [{ text: JSON.stringify({ ok: true }) }] } }),
      { headers: { "content-type": "application/json" } });
  } });
  await client.answerBoardQuestion({ board_id: "project-one", question_id: "color", base_version: 2,
    answer_text: "Blue", idempotency_key: "same-key" });
  assert.equal(calls[0].path, "/mcp");
  assert.equal(calls[0].init.credentials, "same-origin");
  const rpc = JSON.parse(calls[0].init.body);
  assert.equal(rpc.params.name, "answer-board-question");
  assert.equal("answered_by" in rpc.params.arguments, false);
});

test("page keeps motion real and respects reduced motion; phone stacks one column", () => {
  assert.match(CSS, /\.board-card:not\(\[data-pulse="still"\]\) \.halo \{ animation: pulse var\(--pulse-speed\)/);
  assert.match(CSS, /\.rail-line \{[^}]*animation: flow/);
  assert.match(CSS, /\.board-card\.outline-dashed \{ border-style: dashed;/, "blocked stays distinct without motion");
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{[^@]*animation: none !important;/);
  assert.match(CSS, /@media \(max-width: 680px\) \{[^@]*\.columns, \.lower-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(PAGE, /id="legend-toggle"/);
  assert.match(PAGE, /<dialog id="task-detail"/);
});
