// Review findings on the one interactive board: duplicate decisions, the
// legacy inline question, live threshold crossings, the snapshot boundary,
// superseded reads, question drafts, and failed conflict reconciliation.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

import { boardView, deliveryDetail } from "../js/progress-board-model.js";
import { mountBoard } from "../js/progress-board.js";

const PAGE = await readFile(new URL("../progress-board.html", import.meta.url), "utf8");

function snapshotRead(snapshot_json, { version = 1, questions = [] } = {}) {
  return { snapshot: { board_id: "carr-v5", version, updated_at: "2026-09-30T12:00:00Z", snapshot_json }, questions };
}

function v2(extra = {}) {
  return { schema: "carr-progress-board.v2", kind: "project", project: "carr-v5", title: "Synthetic board",
    tasks: {}, deliverables: [], notes: [], decisions: [], ledger: [], ...extra };
}

const OPEN_QUESTION = { question_id: "q-open", revision: 3, prompt: "Synthetic open question?", choices: [],
  allow_free_text: true, default_answer: null, status: null };

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function mount({ now = "2026-09-30T12:00:00Z", reads, answer } = {}) {
  const dom = new JSDOM(PAGE, { url: "https://app.doctorcre.com/progress-board?board=carr-v5" });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  let clock = new Date(now);
  const client = {
    readProgressBoard: () => reads(),
    answerBoardQuestion: args => answer(args),
  };
  const board = mountBoard({ window, document: window.document, client, storage: null, search: "?board=carr-v5",
    now: () => clock, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {} });
  const doc = window.document;
  return { board, window, doc, setNow: value => { clock = new Date(value); },
    $: selector => doc.querySelector(selector), $$: selector => [...doc.querySelectorAll(selector)] };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test("an answered question published as a snapshot decision is shown and counted once", async () => {
  const read = snapshotRead(v2({ decisions: [{ id: "q1", question: "Synthetic choice?", answer: "A" }] }),
    { questions: [{ question_id: "q1", revision: 2, prompt: "Synthetic choice?", choices: ["A", "B"],
      allow_free_text: false, answer_text: "A", status: "Received" }] });
  const page = mount({ reads: async () => structuredClone(read) });
  await page.board.refresh(true);
  assert.equal(page.$$("#board-decisions .decision").length, 1);
  assert.equal(page.$("#decision-count").textContent, "1 MADE");
  assert.equal(page.$("#board-decisions .decision").dataset.status, "Received", "the typed status is authoritative");
});

test("a legacy inline task question shows in the work detail", async () => {
  const read = snapshotRead({ project: "carr-v5", title: "Legacy", tasks: {
    ask: { title: "Synthetic task", status: "running", updated_at: "2026-09-30T11:55:00", question: "SYNTHETIC INLINE QUESTION" } } });
  const page = mount({ reads: async () => structuredClone(read) });
  await page.board.refresh(true);
  assert.ok(page.$('[data-card-id="ask"] .badge-question'));
  const card = boardView(read, new Date("2026-09-30T12:00:00Z")).cards.find(item => item.id === "ask");
  assert.deepEqual(deliveryDetail(card).rows.find(([label]) => label === "Question"), ["Question", "SYNTHETIC INLINE QUESTION"]);
});

test("live ticking crosses the stale and stuck thresholds, even while a question is being edited", async () => {
  const read = snapshotRead(v2({ tasks: { slow: { title: "Synthetic slow task", status: "running", stage: "build",
    updated_at: "2026-09-30T06:01:00" } } }), { questions: [OPEN_QUESTION] });
  const page = mount({ now: "2026-09-30T08:00:00Z", reads: async () => structuredClone(read) });
  await page.board.refresh(true);
  assert.equal(page.$('[data-card-id="slow"]').dataset.pulse, "healthy");
  assert.equal(page.$(".h-stale").textContent, "0 stale");
  page.$("#free-q-open").focus();
  page.$("#free-q-open").value = "half-written draft";

  page.setNow("2026-09-30T08:02:00Z");   // past the 2h stuck threshold
  page.board.tick();
  assert.equal(page.$('[data-card-id="slow"]').dataset.pulse, "critical");
  assert.ok(page.$('[data-card-id="slow"] .card-blocked'), "the newly stuck card names why and what next");

  page.setNow("2026-09-30T12:02:00Z");   // past the 6h stale threshold
  await page.board.refresh();
  page.board.tick();
  assert.ok(page.$('[data-card-id="slow"] .flag-stale'), "a newly stale card gets the flag");
  assert.equal(page.$(".h-stale").textContent, "1 stale");
  assert.equal(page.$("#free-q-open").value, "half-written draft", "the draft survives");
  assert.equal(page.doc.activeElement, page.$("#free-q-open"), "focus stays in the question");
});

test("the snapshot boundary rejects unsupported schemas visibly and isolates malformed optional rows", async () => {
  const unsupported = boardView(snapshotRead({ schema: "carr-progress-board.v9", tasks: {} }));
  assert.match(unsupported.error, /not supported/);
  const wrongShape = boardView(snapshotRead({ schema: "carr-progress-board.v2", tasks: [] }));
  assert.match(wrongShape.error, /tasks/);

  const view = boardView(snapshotRead(v2({
    tasks: { ok: { title: "Synthetic ok", status: "queued" }, bad: null },
    notes: [null, { text: "Synthetic note" }, 7],
    decisions: [null, { question: "Synthetic decision?", answer: "Yes" }],
    deliverables: [null, { title: "Synthetic link", link: "https://example.test/x" }],
    ledger: [null, { pool: "codex", count: 1 }],
  })));
  assert.equal(view.error, null);
  assert.deepEqual(view.cards.map(card => card.id), ["ok"]);
  assert.equal(view.notes.length, 1);
  assert.equal(view.decisions.length, 1);
  assert.equal(view.deliverables.length, 1);
  assert.deepEqual(view.ledger.map(row => row.pool), ["codex"]);
  assert.equal(boardView(snapshotRead({ title: "Legacy", tasks: {} })).error, null, "v1 snapshots still read");

  const page = mount({ reads: async () => snapshotRead({ schema: "carr-progress-board.v9", tasks: {} }) });
  await page.board.refresh(true);
  assert.equal(page.$("#board-error").hidden, false);
  assert.match(page.$("#board-error").textContent, /not supported/);
  assert.equal(page.$$("#board-stages .column").length, 0, "no empty board is drawn as if it were healthy");
});

test("a superseded read never overwrites a newer one", async () => {
  const first = deferred();
  const second = deferred();
  const queue = [first, second];
  const page = mount({ reads: () => queue.shift().promise });
  const a = page.board.refresh(true);
  const b = page.board.refresh(true);
  second.resolve(snapshotRead(v2({ title: "Version two" }), { version: 2 }));
  await b;
  first.resolve(snapshotRead(v2({ title: "Version one" }), { version: 1 }));
  await a;
  assert.equal(page.$("#board-title").textContent, "Version two");
});

test("a read that lands while an answer is being typed keeps the draft and focus", async () => {
  const late = deferred();
  const reads = [async () => snapshotRead(v2(), { questions: [OPEN_QUESTION] }), () => late.promise];
  const page = mount({ reads: () => reads.shift()() });
  await page.board.refresh(true);
  const pending = page.board.refresh();
  page.$("#free-q-open").focus();
  page.$("#free-q-open").value = "SYNTHETIC DRAFT";
  late.resolve(snapshotRead(v2({ title: "Later" }), { version: 2, questions: [OPEN_QUESTION] }));
  await pending;
  assert.equal(page.$("#board-title").textContent, "Later");
  assert.equal(page.$("#free-q-open").value, "SYNTHETIC DRAFT");
  assert.equal(page.doc.activeElement, page.$("#free-q-open"));
});

test("a conflict whose reconciliation read fails says so and offers a reload, never an obsolete write", async () => {
  const writes = [];
  let failReads = false;
  let readCount = 0;
  const page = mount({
    reads: async () => {
      readCount += 1;
      if (failReads) throw new Error("synthetic network failure");
      return snapshotRead(v2(), { questions: [OPEN_QUESTION] });
    },
    answer: async args => {
      writes.push(args);
      const error = new Error("conflict");
      error.payload = { error: "board_version_conflict" };
      throw error;
    },
  });
  await page.board.refresh(true);
  page.$("#free-q-open").value = "SYNTHETIC ANSWER";
  failReads = true;
  page.$(".answer-form").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
  await settle(); await settle(); await settle();
  assert.equal(writes.length, 1);
  const message = page.$(".answer-form .form-message").textContent;
  assert.match(message, /could not be loaded/);
  assert.doesNotMatch(message, /Refreshing/);
  const button = page.$(".answer-form button");
  assert.equal(button.textContent, "Reload question");
  assert.equal(button.disabled, false);

  failReads = false;
  const before = readCount;
  page.$(".answer-form").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
  await settle(); await settle(); await settle();
  assert.equal(writes.length, 1, "reloading never resubmits the obsolete revision");
  assert.ok(readCount > before);
  assert.equal(page.$(".answer-form button").textContent, "Send answer", "a fresh form after the reload");
  assert.equal(page.$("#free-q-open").disabled, false);
});

test("an unconfirmed transport failure keeps the same request for the retry", async () => {
  const writes = [];
  let fail = true;
  const page = mount({
    reads: async () => snapshotRead(v2(), { questions: fail ? [OPEN_QUESTION] : [{ ...OPEN_QUESTION, status: "Sent", answer_text: "X" }] }),
    answer: async args => {
      writes.push(args);
      if (fail) throw new Error("synthetic transport failure");
      return { ok: true };
    },
  });
  await page.board.refresh(true);
  page.$("#free-q-open").value = "X";
  page.$(".answer-form").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
  await settle(); await settle();
  assert.match(page.$(".answer-form .form-message").textContent, /unconfirmed/);
  fail = false;
  page.$(".answer-form").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
  await settle(); await settle(); await settle();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].idempotency_key, writes[0].idempotency_key);
  assert.equal(writes[1].base_version, writes[0].base_version);
});

test("the GitHub refresh state is shown: an outage names the unrefreshed cards and the last verified time", async () => {
  const task = { title: "Synthetic PR card", status: "review", stage: "review", pr: 42, repo: "jbookout/carr-system",
    updated_at: "2026-09-30T11:00:00Z" };
  let sync = { checked_at: "2026-09-30T11:58:00Z", last_verified_at: "2026-09-30T11:00:00Z",
    failed: [{ card: "a", pr: "carr-system#42", error: "synthetic timeout" }] };
  const page = mount({ reads: async () => snapshotRead(v2({ tasks: { a: task, b: { ...task, pr: 43 } },
    github_sync: sync, omitted: { live: 3, merged: 0, history: 0 } })) });
  await page.board.refresh(true);
  const line = page.$("#board-sync");
  assert.equal(line.hidden, false);
  assert.equal(line.dataset.state, "failed");
  assert.match(line.textContent, /GitHub refresh failed for 1 card/);
  assert.match(line.textContent, /last verified/);
  assert.match(line.textContent, /3 older Live cards not shown/);
  assert.ok(page.$('[data-card-id="a"] .flag-unrefreshed'), "the unrefreshed card is marked");
  assert.equal(page.$('[data-card-id="b"] .flag-unrefreshed'), null);

  sync = { checked_at: "2026-09-30T12:00:00Z", last_verified_at: "2026-09-30T12:00:00Z", failed: [] };
  await page.board.refresh(true);
  assert.equal(page.$("#board-sync").dataset.state, "ok");
  assert.match(page.$("#board-sync").textContent, /GitHub checked/);
  assert.equal(page.$('[data-card-id="a"] .flag-unrefreshed'), null, "recovery clears the mark");
});

test("an all-repos repository that could not be read marks its cards, and no sync record shows nothing", () => {
  const card = { title: "Synthetic", status: "review", stage: "review", pr: 1, repo: "jbookout/carr-system" };
  const view = boardView(snapshotRead(v2({ kind: "all-repos", tasks: { "carr-system-1": card,
    "doctorcre-app-1": { ...card, repo: "jbookout/doctorcre-app" } },
    github_sync: { checked_at: "2026-09-30T12:00:00Z", last_verified_at: null,
      failed: [{ repo: "jbookout/carr-system", error: "malformed row" }] } })));
  assert.equal(view.sync.state, "failed");
  assert.deepEqual(view.cards.filter(c => c.sync_failed).map(c => c.id), ["carr-system-1"]);
  assert.equal(boardView(snapshotRead(v2())).sync.state, null);
});
