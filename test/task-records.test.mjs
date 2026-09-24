import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  BOARD_ROW_KEYS, PARTNERS, TASK_KINDS, closeArgs, dueDateArgs, handoverArgs, handoverTarget,
  loopRefusalMessage, normalizeBoardRow, operationKeys, orderTaskRows, partnerName, quickAddPlan,
  quickAddRecords, scopeRows, stableKey, taskDetailRows, validBoardPayload,
} from "../js/task-records-model.js";
import { parseQuickAdd } from "../js/visual-system.js";
import { createFixtureClient } from "../js/fixture-client.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NOW = "2026-09-16T14:00:00Z";

/** What a reader can actually see. A comment is not a claim the page makes. */
const withoutComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|\s)\/\/.*$/gm, "$1");

/** The loop-board row shape, transcribed from the deployed read. */
function boardRow(overrides = {}) {
  return {
    number: "201", kind: "open_loop", domain: "business", status: "open", owner: "joe",
    marker: "none", title: "Demo Gulf Breeze Dental: send the LOI redline", label: "Joe",
    joint_owner: false, blocker_class: "human_only", blocker_detail: "Joe does this personally: send the LOI redline",
    since_text: "open 3 days", due_on: null, version: 4, ...overrides,
  };
}

const freshLoop = (overrides = {}) => ({ loop_id: "loop-001", version: 4, kind: "open_loop", number: "201", owner: "joe", status: "open", ...overrides });

/* ------------------------------------------------------------------ the board read */

test("a board row is accepted key by key, extra keys are dropped and a row without a version is refused", () => {
  const normalized = normalizeBoardRow({ ...boardRow(), invented_by_a_future_server: "ignore me" });
  assert.deepEqual(Object.keys(normalized).sort(), [...BOARD_ROW_KEYS].sort());
  assert.equal("invented_by_a_future_server" in normalized, false, "an unknown key is dropped, never carried into a write");
  assert.equal(normalized.owner, "joe");

  assert.equal(normalizeBoardRow({ ...boardRow(), version: undefined }), null, "a row with no version cannot be written against");
  assert.equal(normalizeBoardRow({ ...boardRow(), number: null }), null);
  assert.equal(normalizeBoardRow({ ...boardRow(), kind: "idea" }), null, "only the two task kinds are rows here");
  assert.equal(normalizeBoardRow(null), null);

  assert.equal(validBoardPayload({ count: 1, loops: [boardRow()] }), true);
  assert.equal(validBoardPayload({ loops: [] }), false);
  assert.equal(validBoardPayload({ count: 0, loops: {} }), false);
  assert.equal(validBoardPayload(null), false);
});

/* ------------------------------------------------------------------ D4 scoping */

test("Team shows both partners, Mine shows the viewer, and system-owned rows are grouped rather than dropped", () => {
  const rows = [
    boardRow({ number: "201", owner: "joe" }),
    boardRow({ number: "203", owner: "dell" }),
    boardRow({ number: "206", owner: "claude" }),
    boardRow({ number: "208", owner: "joe", joint_owner: true }),
    boardRow({ number: "207", kind: "team_loop", owner: "dell", blocker_class: null, blocker_detail: null }),
    boardRow({ number: "209", owner: "joe", status: "done" }),
  ].map(normalizeBoardRow);

  const team = scopeRows(rows, { scope: "team", viewer: "joe" });
  assert.deepEqual(team.visible.map((row) => row.number), ["201", "203", "207"]);
  assert.deepEqual(team.systemOwned.map((row) => row.number), ["206", "208"], "a claude-owned row and a jointly owned row are shown, in their own group");
  assert.ok(!team.visible.some((row) => row.status !== "open"), "a closed record is not open work");

  const mine = scopeRows(rows, { scope: "mine", viewer: "dell" });
  assert.deepEqual(mine.visible.map((row) => row.number), ["203", "207"]);
  assert.deepEqual(mine.systemOwned, [], "the system-owned group belongs to the Team scope only");

  // Ideas and action-required items are not rows on this surface at all: they
  // cannot even be normalized into one.
  for (const kind of ["idea", "action_required"]) {
    assert.equal(normalizeBoardRow(boardRow({ kind })), null, `${kind} is not shown here`);
    assert.equal(TASK_KINDS.includes(kind), false);
  }
});

/* ------------------------------------------------------------------ D7 ordering */

test("ordering puts a flagged record on top and an overdue one above a distant one, and a personal blocker is not a block", () => {
  const rows = [
    boardRow({ number: "a", due_on: "2026-10-02" }),
    boardRow({ number: "b", blocker_class: "counterparty", blocker_detail: "Demo Coastal Surveying has not answered" }),
    boardRow({ number: "c", due_on: "2026-09-15" }),
    boardRow({ number: "d", marker: "bell", due_on: "2026-10-03" }),
  ].map(normalizeBoardRow);
  const ordered = orderTaskRows(rows, NOW);
  assert.deepEqual(ordered.map((row) => row.number), ["d", "c", "b", "a"]);
  assert.equal(ordered[1].priority, "overdue");
  assert.equal(ordered[2].priority, "blocked");
  assert.match(ordered[2].reason, /Demo Coastal Surveying/);
  // human_only is the person's own task, and the ordering must not sink it
  // below a vendor's delay as though something outside were holding it.
  assert.equal(orderTaskRows([normalizeBoardRow(boardRow())], NOW)[0].priority, "ordinary");
  // The row keeps its record-layer fields; ordering adds, it never replaces.
  assert.equal(ordered[0].kind, "open_loop");
  assert.equal(ordered[0].version, 4);
});

/* ------------------------------------------------------------------ D1/D2 Quick add */

test("a task the viewer keeps files as an open loop with a human_only blocker whose detail says who does what", () => {
  const parsed = parseQuickAdd("Call the CPA by 2026-09-30", { now: Date.parse(NOW), viewer: "joe" });
  const plan = quickAddPlan(parsed, { viewer: "joe", sentence: "Call the CPA by 2026-09-30" });
  assert.equal(plan.kind, "open_loop");
  assert.equal(plan.args.owner, "joe");
  assert.equal(plan.args.blocker, "human_only");
  assert.ok(plan.args.blocker_detail.length >= 12, "the record layer refuses a short or vague detail");
  assert.match(plan.args.blocker_detail, /^Joe does this personally: /);
  assert.ok(plan.args.blocker_detail.includes("Call the CPA"), "the detail names the action, which is what makes it not vague");
  assert.equal(plan.args.title, "Call the CPA");
  assert.equal(plan.args.body, "Call the CPA by 2026-09-30");
  assert.equal(plan.args.domain, "business");
  assert.equal(plan.args.marker, "dated");
  assert.equal(plan.args.due_on, "2026-09-30");
  assert.deepEqual(plan.questions, []);

  const undated = quickAddPlan(parseQuickAdd("Read the Demo Crestview counter", { now: Date.parse(NOW), viewer: "dell" }), { viewer: "dell", sentence: "Read the Demo Crestview counter" });
  assert.equal(undated.args.marker, "none");
  assert.equal("due_on" in undated.args, false, "an undated record carries no due date at all");
  assert.match(undated.args.blocker_detail, /^Dell does this personally: /);
});

test("a task the sentence gives to the other partner files as a team loop, with no blocker and no third owner", () => {
  const sentence = "Send survey window to @dell by friday";
  const plan = quickAddPlan(parseQuickAdd(sentence, { now: Date.parse(NOW), viewer: "joe" }), { viewer: "joe", sentence });
  assert.equal(plan.kind, "team_loop");
  assert.equal(plan.args.owner, "dell");
  assert.equal("blocker" in plan.args, false, "a team loop refuses a blocker");
  assert.equal("blocker_detail" in plan.args, false);
  assert.equal(plan.args.body, sentence, "the original sentence is kept as the body");
  assert.match(plan.summary, /Dell/);

  // The same sentence read by Dell is Dell's own task, not a handover to himself.
  const asDell = quickAddPlan(parseQuickAdd(sentence, { now: Date.parse(NOW), viewer: "dell" }), { viewer: "dell", sentence });
  assert.equal(asDell.kind, "open_loop");
  assert.deepEqual(PARTNERS, ["joe", "dell"], "there is no third owner to offer");
});

test("a sentence with no action files nothing and asks its question instead", () => {
  const plan = quickAddPlan(parseQuickAdd("", { now: Date.parse(NOW) }), { viewer: "joe", sentence: "" });
  assert.equal(plan.args, null);
  assert.equal(plan.kind, null);
  assert.deepEqual(plan.questions, ["What is the action?"]);
});

/* ------------------------------------------------------------------ D2/D3/D6 writes */

test("a handover changes one field, carries the version it was read at, and never restates a blocker", () => {
  assert.equal(handoverTarget(normalizeBoardRow(boardRow({ owner: "joe" }))), "dell");
  assert.equal(handoverTarget(normalizeBoardRow(boardRow({ owner: "dell" }))), "joe");
  assert.equal(handoverTarget({ owner: "claude" }), null, "a system-owned row has no partner to hand to");
  assert.equal(handoverTarget({}), null);

  for (const kind of TASK_KINDS) {
    const args = handoverArgs(freshLoop({ kind }), "dell");
    assert.deepEqual(args, { loop_id: "loop-001", base_version: 4, owner: "dell" });
    assert.equal("blocker" in args, false);
    assert.equal("blocker_detail" in args, false);
  }
  assert.throws(() => handoverArgs(freshLoop(), "claude"), TypeError, "the UI never offers a third owner");
  assert.throws(() => handoverArgs({ version: 4 }, "dell"), TypeError, "a write without a loop_id is not sent");
  assert.throws(() => handoverArgs({ loop_id: "loop-001" }, "dell"), TypeError, "a write without a base version is not sent");
});

test("completing and dropping both require an outcome the person typed", () => {
  assert.deepEqual(closeArgs(freshLoop(), { resolution: "done", outcome: "Counsel accepted the redline" }), {
    loop_id: "loop-001", base_version: 4, outcome: "Counsel accepted the redline", resolution: "done",
  });
  assert.equal(closeArgs(freshLoop(), { resolution: "dropped", outcome: " no longer needed " }).outcome, "no longer needed");
  assert.throws(() => closeArgs(freshLoop(), { resolution: "done", outcome: "" }), TypeError);
  assert.throws(() => closeArgs(freshLoop(), { resolution: "done", outcome: "   " }), TypeError);
  assert.throws(() => closeArgs(freshLoop(), { resolution: "archived", outcome: "done" }), TypeError);
});

test("a due date is the dated marker and a calendar day, and nothing else", () => {
  assert.deepEqual(dueDateArgs(freshLoop(), "2026-09-30"), {
    loop_id: "loop-001", base_version: 4, marker: "dated", due_on: "2026-09-30",
  });
  assert.throws(() => dueDateArgs(freshLoop(), "next Friday"), TypeError);
  assert.throws(() => dueDateArgs(freshLoop(), ""), TypeError);
});

/* ------------------------------------------------------------------ D5 refusals */

test("an ambiguous number is never guessed at", () => {
  assert.equal(loopRefusalMessage("ambiguous_number", { number: "201" }), "Two open records share number 201; open the record layer to renumber.");
  assert.match(loopRefusalMessage("not_found"), /no longer on the board/);
  assert.match(loopRefusalMessage("need_number_or_id"), /without a number/);
  assert.match(loopRefusalMessage(null), /nothing was sent/);
});

/* ------------------------------------------------------------------ the popup */

test("the popup says what kind of record this is in words, and hides a waiting line that is only the person", () => {
  const mine = taskDetailRows(freshLoop({ ...boardRow(), loop_id: "loop-001" }), "joe");
  assert.deepEqual(mine[0], ["Record kind", "Your task"]);
  assert.deepEqual(mine[1], ["Owner", "Joe"]);
  assert.equal(mine.some(([label]) => label === "Waiting on"), false, "a human_only blocker is not a waiting line");
  assert.deepEqual(mine.at(-1), ["Number", "201"]);

  const handed = taskDetailRows({ ...boardRow({ kind: "team_loop", owner: "dell" }), loop_id: "loop-007" }, "joe");
  assert.deepEqual(handed[0], ["Record kind", "Handed to Dell"]);

  const waiting = taskDetailRows({ ...boardRow({ blocker_class: "counterparty", blocker_detail: "Demo Coastal Surveying has not answered", due_on: "2026-09-18" }) }, "joe");
  assert.ok(waiting.some(([label, value]) => label === "Waiting on" && value === "Demo Coastal Surveying has not answered"));
  assert.ok(waiting.some(([label, value]) => label === "Due" && value === "Fri, Sep 18, 2026"));
  assert.equal(partnerName("dell"), "Dell");
});

/* ------------------------------------------------------------------ operation keys */

test("one intent is one operation key, stable across renders and different per record", () => {
  const row = normalizeBoardRow(boardRow());
  assert.equal(operationKeys.handover(row), "handover:open_loop:201");
  assert.equal(operationKeys.close(row), "close:open_loop:201");
  assert.equal(operationKeys.due(row), "due:open_loop:201");
  assert.equal(operationKeys.handover(normalizeBoardRow(boardRow({ kind: "team_loop" }))), "handover:team_loop:201",
    "the number is not an identity: the kind is part of the key");
  assert.equal(operationKeys.quickAdd("Call the CPA", "joe"), operationKeys.quickAdd("  Call the CPA  ", "joe"));
  assert.notEqual(operationKeys.quickAdd("Call the CPA", "joe"), operationKeys.quickAdd("Call the CPA", "dell"));
  assert.match(operationKeys.quickAdd("Call the CPA", "joe"), /^quickadd:[0-9a-f]{8}$/);
  assert.equal(stableKey("x"), stableKey("x"));
  assert.notEqual(stableKey("x"), stableKey("y"));
});

/* ------------------------------------------------------------------ the clients */

test("the synthetic client serves the loop verbs the page calls, and honours the version it was read at", async () => {
  const seedText = await readFile(`${ROOT}/data/board-seed.json`, "utf8");
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seedText).toString("base64")}` });

  const open = await client.loopBoard({ kind: "open_loop", status: "open", limit: 300, summary: false });
  const team = await client.loopBoard({ kind: "team_loop", status: "open", limit: 300, summary: false });
  assert.ok(validBoardPayload(open) && validBoardPayload(team));
  const rows = [...open.loops, ...team.loops].map(normalizeBoardRow);
  assert.ok(rows.length >= 8 && rows.every(Boolean), "every fixture row is renderable");
  assert.ok(rows.every((row) => row.title.startsWith("Demo ")), "fixture records are visibly synthetic");
  assert.ok(rows.some((row) => row.owner === "joe") && rows.some((row) => row.owner === "dell"));
  assert.ok(rows.some((row) => row.owner === "claude"), "one row is system-owned");
  assert.ok(rows.some((row) => row.kind === "team_loop"));
  assert.ok(rows.some((row) => row.marker === "dated" && row.due_on));
  assert.ok(rows.some((row) => row.marker === "bell"));
  assert.ok(rows.some((row) => row.blocker_class === "counterparty"));

  // read-loop answers a miss in the payload, with isError false.
  assert.equal((await client.readLoop({ number: "999", kind: "open_loop" })).error, "not_found");
  assert.equal((await client.readLoop({})).error, "need_number_or_id");
  assert.equal((await client.readLoop({ number: "201" })).error, "ambiguous_number", "two records share that number");

  const { loop } = await client.readLoop({ number: "201", kind: "open_loop" });
  assert.equal(loop.owner, "joe");
  const handed = await client.updateLoop({ idempotency_key: "k-1", ...handoverArgs(loop, "dell") });
  assert.equal(handed.ok, true);
  assert.equal((await client.readLoop({ loop_id: loop.loop_id })).loop.owner, "dell");

  // The same request under the same key replays instead of writing again.
  assert.deepEqual(await client.updateLoop({ idempotency_key: "k-1", ...handoverArgs(loop, "dell") }), handed);

  // A stale base version is refused with the payload the kernel classifies.
  await assert.rejects(
    () => client.updateLoop({ idempotency_key: "k-2", ...handoverArgs(loop, "joe") }),
    (error) => error.payload?.error === "version_conflict" && typeof error.payload.hint === "string",
  );

  const added = await client.addLoop({
    idempotency_key: "k-3",
    ...quickAddPlan(parseQuickAdd("Call the CPA", { now: Date.parse(NOW), viewer: "joe" }), { viewer: "joe", sentence: "Call the CPA" }).args,
  });
  assert.equal(added.ok, true);
  assert.equal(added.kind, "open_loop");
  assert.equal(added.blocker, "human_only");

  const capture = await client.readLoop({ loop_id: added.loop_id });
  await assert.rejects(
    () => client.closeLoop({ idempotency_key: "k-4", ...capture.loop, loop_id: added.loop_id, base_version: capture.loop.version, outcome: "", resolution: "done" }),
    (error) => error.payload?.error === "outcome_required",
  );
  const closed = await client.closeLoop({ idempotency_key: "k-5", ...closeArgs(capture.loop, { resolution: "done", outcome: "Spoke to the CPA" }) });
  assert.equal(closed.status, "done");
  // The record layer's own shape: blocks with the version a header edit needs.
  const headers = await client.loopHeaders();
  assert.equal(headers.count, headers.blocks.length);
  assert.ok(headers.blocks.every((block) => block.block_id && block.section && Number.isInteger(block.version) && typeof block.prose_md === "string"));
});

/* ------------------------------------------------------------------ the surface */

test("the Tasks page is a listed surface that captures, hands over and closes through one dock", async () => {
  const html = await readFile(`${ROOT}/tasks.html`, "utf8");
  const js = withoutComments(await readFile(`${ROOT}/js/task-records.js`, "utf8"));
  const model = withoutComments(await readFile(`${ROOT}/js/task-records-model.js`, "utf8"));
  const css = await readFile(`${ROOT}/css/tasks.css`, "utf8");
  const routes = JSON.parse(await readFile(`${ROOT}/contracts/app-routes.v1.json`, "utf8"));
  const carr = JSON.parse(await readFile(`${ROOT}/contracts/carr-interface.v1.json`, "utf8"));
  const artifactScript = await readFile(`${ROOT}/scripts/artifact.mjs`, "utf8");
  const checkScript = await readFile(`${ROOT}/scripts/check-repository.mjs`, "utf8");
  const summary = await readFile(`${ROOT}/SUMMARY.md`, "utf8");

  // Route and contract, both bumped for an additive change.
  assert.equal(routes.routes["/tasks"], "tasks.html");
  assert.equal(routes.version, "1.13.0");
  assert.equal(carr.version, "1.23.0");
  for (const verb of ["add-loop", "close-loop", "loop-board", "loop-headers", "read-loop", "update-loop"]) {
    assert.ok(carr.mcp_operations.includes(verb), `the interface must pin ${verb}`);
  }
  assert.deepEqual(carr.mcp_operations, [...carr.mcp_operations].sort(), "the pinned operations stay sorted");
  assert.match(artifactScript, /"tasks\.html"/, "the page ships in the artifact");
  assert.match(checkScript, /"tasks\.html"/);
  assert.match(summary, /tasks\.html/);

  // The shell, and the dock this slice writes through.
  assert.match(html, /<html lang="en" data-theme="dark"/);
  assert.match(html, /class="skip" href="#main"/);
  assert.match(html, /\/css\/system\.css/);
  assert.match(html, /\/css\/tasks\.css/);
  assert.match(html, /id="taskLive"[^>]*aria-live="polite"/);
  assert.match(html, /<div id="receiptDock" class="receipt-dock"/, "commands report in the shared dock");
  assert.match(html, /<button class="doc-fab" type="button" id="docFab"/);
  assert.match(html, /<a href="\/tasks" aria-current="page">Tasks<\/a>/, "the page is listed in the navigation it belongs to");
  for (const id of ["quickAddForm", "quickAddInput", "quickAddDate", "quickAddParsed", "quickAddQuestion", "quickAddDraft", "scopeSwitch", "taskList", "taskDialog", "taskState", "systemOwned"]) {
    assert.ok(html.includes(`id="${id}"`), `the page must carry #${id}`);
  }

  // Joe's ruling on dates: the calendar picker is the only way in.
  assert.match(html, /id="quickAddDate" type="date"/);
  assert.match(html, /id="taskDue" type="date"/);
  assert.doesNotMatch(html, /Or type the date|DateTyped/, "no typed-date box sits beside a picker");
  assert.equal((html.match(/type="date"/g) || []).length, 2, "two calendar pickers, and no third date control");

  // Titles do the job: no descriptive sentence sits under a heading, and the
  // caption that states what this view is sits ABOVE the title.
  assert.doesNotMatch(html, /<p class="(?:intro|lede|description)"/);
  assert.doesNotMatch(html, /<h1 id="pageTitle">Tasks<\/h1>\s*<p>/);
  assert.match(html, /the shared record, filtered by owner[\s\S]{0,400}<h1 id="pageTitle">/, "the caption is one line above the title");

  // Every control is a real button or input, so the shared 44px rules apply,
  // and the two places the shared sheet sits under the floor are raised here.
  assert.doesNotMatch(html, /<div[^>]*onclick|role="button"/, "nothing is a fake button");
  assert.match(css, /\.btn-group \.btn \{ min-height: var\(--touch\)/);
  assert.match(css, /\.chip \{ min-height: var\(--touch\)/);
  assert.match(css, /\.system-owned > summary \{ min-height: var\(--touch\)/);
  for (const match of html.matchAll(/<button(?![^>]*class="[^"]*(?:btn|chip|pref-icon|doc-fab|task-open)[^"]*")[^>]*>/g)) {
    assert.fail(`a button outside the sized classes: ${match[0]}`);
  }

  // The write discipline: read fresh, freeze, never patch the row locally.
  assert.match(js, /readFresh/);
  assert.match(js, /performCommand\(/);
  assert.match(js, /createCommandDock/);
  assert.match(js, /undo: false/);
  assert.doesNotMatch(js, /onUndo: \(/, "this slice offers no undo");
  assert.match(js, /await load\(\)/, "a settled write re-reads the board");
  assert.doesNotMatch(js, /row\.owner = |row\.status = /, "nothing on screen is patched in place");
  assert.match(js, /resolveDealroomBoot/);
  assert.match(js, /client\.selfActor/);
  assert.doesNotMatch(js, /https?:\/\//, "the page speaks to CARR through the client or not at all");
  assert.doesNotMatch(html, /<script(?![^>]*src="\/js\/)/, "the page runs only its own module");

  // The model stays pure.
  assert.doesNotMatch(model, /document\.|window\.|fetch\(|localStorage|Date\.now\(\)/, "the model has no DOM, no network and no clock of its own");
  for (const source of [html, js, model, css]) assert.doesNotMatch(source, /\bTODO\b/);

  // Quick add reads the board this page is holding, not an empty list.
  assert.doesNotMatch(js, /records:\s*\[\]/, "Quick add is given the records the page already holds");
  assert.match(js, /records: quickAddRecords\(view\.rows\)/);
});

test("Quick add is offered the ids the board holds, not names alone", () => {
  const rows = [
    boardRow({ number: "201", title: "Beasley lease renewal", loop_id: "loop-201" }),
    boardRow({ number: "202", title: "Beasley lease renewal", loop_id: "loop-202" }),
    boardRow({ number: "203", title: "   ", loop_id: "loop-203" }),
    boardRow({ number: "204", title: "Crestview derm site tour", loop_id: "loop-204" }),
  ];
  assert.deepEqual([...quickAddRecords(rows)], [
    { id: "loop-201", name: "Beasley lease renewal" },
    { id: "loop-204", name: "Crestview derm site tour" },
  ], "each record carries the id its own row holds, deduped by name");

  // A row that names no id is still matchable; it just cannot be pointed at.
  assert.deepEqual([...quickAddRecords([{ title: "Nameless id" }])], [{ id: null, name: "Nameless id" }]);
  assert.deepEqual([...quickAddRecords([{ id: "deal-9", name: "Demo Pace Pediatrics" }])], [{ id: "deal-9", name: "Demo Pace Pediatrics" }]);

  // Nothing, and rubbish, produce no records rather than an invented one.
  assert.deepEqual([...quickAddRecords(null)], []);
  assert.deepEqual([...quickAddRecords([null, 7, {}])], []);

  // The cap is a real ceiling, not a comment.
  const many = Array.from({ length: 260 }, (_, index) => ({ title: `Loop ${index}` }));
  assert.equal(quickAddRecords(many).length, 200);

  // And the records actually steer parseQuickAdd's Related field, id and all.
  const parsed = parseQuickAdd("call about Beasley lease renewal friday", { now: Date.parse(NOW), viewer: "joe", records: quickAddRecords(rows) });
  assert.equal(parsed.related, "Beasley lease renewal");
  assert.equal(parsed.relatedId, "loop-201");
});

test("a sentence matches a record on whole words, so 'part' does not resolve the Apartment record", () => {
  const records = [{ id: "loop-301", name: "Apartment clinic fit-out" }];
  const substring = parseQuickAdd("Ask Dell for his part of the budget", { now: Date.parse(NOW), viewer: "joe", records });
  assert.equal(substring.related, null, "'part' is a word inside 'Apartment', not the record's name");
  assert.equal(substring.relatedId, null);
  assert.deepEqual([...substring.relatedCandidates], []);
  assert.deepEqual(substring.questions, [], "no match is not a question");

  const whole = parseQuickAdd("Ask Dell about the Apartment clinic fit-out budget", { now: Date.parse(NOW), viewer: "joe", records });
  assert.equal(whole.related, "Apartment clinic fit-out");
  assert.equal(whole.relatedId, "loop-301");

  // A partial name is not the record either: every scored word has to be there.
  const partial = parseQuickAdd("Ask Dell about the Apartment budget", { now: Date.parse(NOW), viewer: "joe", records });
  assert.equal(partial.related, null);

  // Bare names are still accepted, and resolve with a null id.
  const bare = parseQuickAdd("Ask Dell about the Apartment clinic fit-out budget", { now: Date.parse(NOW), viewer: "joe", records: ["Apartment clinic fit-out"] });
  assert.equal(bare.related, "Apartment clinic fit-out");
  assert.equal(bare.relatedId, null);
});

test("two records matching one sentence resolve neither, and the preview asks which one", () => {
  const records = [
    { id: "loop-401", name: "Crestview derm site tour" },
    { id: "loop-402", name: "Crestview derm site tour follow-up" },
  ];
  const sentence = "Book the Crestview derm site tour follow-up with Dr. Patel";
  const parsed = parseQuickAdd(sentence, { now: Date.parse(NOW), viewer: "joe", records });
  assert.equal(parsed.related, null, "an ambiguous sentence resolves NEITHER record");
  assert.equal(parsed.relatedId, null);
  assert.deepEqual([...parsed.relatedCandidates], ["Crestview derm site tour", "Crestview derm site tour follow-up"]);
  assert.ok(parsed.questions.includes("Which record is this about: Crestview derm site tour, Crestview derm site tour follow-up?"));

  // Ambiguity does not block filing: the action is still a record.
  const plan = quickAddPlan(parsed, { viewer: "joe", sentence });
  assert.ok(plan.args, "the capture still files");
  assert.equal(plan.args.source_note, undefined, "and it points at no record, because none was resolved");
  assert.equal(parsed.complete, false, "the sentence is understood, but one field is still a question");
});

test("the matched record's id rides into add-loop as source_note prose, because the verb has no related-id field", () => {
  const records = [{ id: "loop-501", name: "Beasley lease renewal" }];
  const sentence = "Send the Beasley lease renewal redline friday";
  const parsed = parseQuickAdd(sentence, { now: Date.parse(NOW), viewer: "joe", records });
  assert.equal(parsed.relatedId, "loop-501");

  const plan = quickAddPlan(parsed, { viewer: "joe", sentence });
  assert.equal(plan.args.source_note, "Related: Beasley lease renewal (loop-501)");
  // The verb's own argument list, transcribed: there is nowhere else to put it.
  for (const field of ["related", "related_id", "about", "loop_id"]) {
    assert.equal(field in plan.args, false, `add-loop has no ${field} argument`);
  }

  // Shared work files as a team_loop and carries the same note.
  const shared = quickAddPlan(parseQuickAdd(`${sentence} @dell`, { now: Date.parse(NOW), viewer: "joe", records }), { viewer: "joe", sentence });
  assert.equal(shared.kind, "team_loop");
  assert.equal(shared.args.source_note, "Related: Beasley lease renewal (loop-501)");

  // No resolved record, no source_note from this path at all.
  const unmatched = quickAddPlan(parseQuickAdd("Send the redline friday", { now: Date.parse(NOW), viewer: "joe", records }), { viewer: "joe", sentence: "Send the redline friday" });
  assert.equal("source_note" in unmatched.args, false);
});
