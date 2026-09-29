import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createLiveClient } from "../js/live-client.js";
import { boardView, answerRequest, taskStage, taskHealth, taskPulse } from "../js/progress-board-model.js";
import { handleDoctorcreRequest } from "../src/worker.js";

const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const host = `https://${config.env.staging.name}.workers.dev`;

test("shared producer stage and health fixtures match the published board view", async () => {
  const fixtures = JSON.parse(await readFile(new URL("../test/fixtures/progress-board-stages.json", import.meta.url), "utf8"));
  const contract = JSON.parse(await readFile(new URL("../contracts/carr-interface.v1.json", import.meta.url), "utf8"));
  assert.equal(fixtures.producer_source_commit, contract.producer.source_commit);
  assert.deepEqual(new Set(fixtures.cases.map(({ producer_health }) => producer_health)),
    new Set(["healthy", "question", "blocked"]), "every producer health class is represented");
  const at = new Date(fixtures.reference_time);
  const tasks = Object.fromEntries(fixtures.cases.map(({ id, task }) => [id, task]));
  const view = boardView({ snapshot: { board_id: "synthetic", version: 1, snapshot_json: { tasks } } });
  for (const { id, task, stage, producer_health, pulse } of fixtures.cases) {
    assert.equal(taskStage(task), stage, id);
    assert.equal(taskHealth(task, at), producer_health, id);
    assert.equal(taskPulse(task, at), pulse, id);
    assert.equal(view.stages.find(item => item.id === stage).tasks.some(item => item.id === id), true, id);
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
  const signedOut = await handleDoctorcreRequest(new Request(`${host}/progress-board?board=project-one`), env);
  assert.equal(signedOut.status, 302);
  assert.equal(new URL(gated[0].url).pathname, "/control-room");
  assert.equal(new URL(gated[0].url).search, "");

  env.CARR.fetch = async (request) => { gated.push(request); return new Response(); };
  env.ASSETS.fetch = async (request) => new Response(new URL(request.url).pathname);
  const signedIn = await handleDoctorcreRequest(new Request(`${host}/progress-board`), env);
  assert.equal(await signedIn.text(), "/progress-board.html");
});

test("board view reads current typed questions and keeps status from CARR only", () => {
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
  assert.equal(view.stages.find(stage => stage.id === "build").tasks[0].title, "Build API");
  assert.equal(view.stages.find(stage => stage.id === "review").tasks[0].title, "Ship app");
  assert.equal(view.questions[0].status, null);
  assert.equal(view.questions[1].status, "Received");
  assert.equal(view.questions[1].answer_text, "Keep going");
});

test("answer request uses the question revision and carries no actor or status claim", () => {
  assert.deepEqual(answerRequest({ question_id: "color", revision: 2, choices: ["Blue", "Green"], allow_free_text: false },
    "project-one", "Blue", "same-key"), {
    board_id: "project-one", question_id: "color", base_version: 2,
    answer_text: "Blue", idempotency_key: "same-key",
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
  assert.equal(rpc.params.arguments.idempotency_key, "same-key");
  assert.equal("answered_by" in rpc.params.arguments, false);
});

test("page offers choice and free-text controls, with reduced-motion styling", async () => {
  const html = await readFile(new URL("../progress-board.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../css/progress-board.css", import.meta.url), "utf8");
  assert.match(html, /id="board-stages"/);
  assert.match(html, /id="board-questions"/);
  assert.match(html, /id="board-flow"/);
  assert.match(html, /<dialog id="task-detail"/);
  assert.match(css, /\.pipeline-node\[data-pulse="blocked"\]/);
  assert.match(css, /\.pipeline-node\[data-pulse="question"\]/);
  assert.doesNotMatch(css, /\.pipeline-node\[data-pulse="still"\][^}]*animation/);
  assert.match(css, /\.pipeline-node\[data-pulse="blocked"\] \.node-shape \{[^}]*stroke-dasharray:/,
    "stuck remains distinct when motion is off");
  assert.match(css, /--stage-build:\s*#fb7b32/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^@]*animation: none !important;/,
    "the reduced-motion fallback stops every pulse");
});
