// V5-UX-B03 — the Deals board.
//
// Four kinds of test, and they are deliberately different kinds:
//
//   1. the model, called directly — the eight columns, the round trip that
//      defect 5e355b84 broke, the completion plan's ordering and its one
//      refusal, the wrapping keyboard;
//   2. the fixture round trip — a real move through patchDealField with the
//      board's own field_base, a stale base becoming a conflict, a replay under
//      one key, and the follow-ups landing only after the phase was accepted;
//   3. source-text assertions on js/pipeline.js, mirroring the ones
//      test/dealroom-board-sync.test.mjs makes about js/app.js, because the
//      properties they protect — one board read, no value from the feed, ids
//      rather than rows — cannot be observed from the outside;
//   4. static assertions on pipeline.html, because the page's promises (no
//      gate wording, calendar-only dates, one Doc) are promises about markup.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createFixtureClient } from "../js/fixture-client.js";
import { PHASES, PHICON, phaseLabel } from "../js/client.js";
import {
  CLOSED_SLUG, COLUMNS, DEAL_OUTCOMES, PHASE_DATE_KIND, closedColumnCaption, columnBySlug,
  columnByValue, columnLabel, completionPlan, filterDeals, groupByColumn, isDealOutcome,
  keyboardTarget, moveIntent, moveSummary, moveTitle, orderColumn, presenceChip,
  recordPanelSections, typeFilters,
} from "../js/pipeline-model.js";

const ROOT = new URL("..", import.meta.url);
const read = (path) => readFile(new URL(path, ROOT), "utf8");

const seedText = await read("data/board-seed.json");
const seedUrl = `data:application/json;base64,${Buffer.from(seedText).toString("base64")}`;
const newClient = () => createFixtureClient({ seedUrl });

/* ------------------------------------------------------------------- the model */

test("the board has the eight deal phases, in the record layer's own order", () => {
  assert.deepEqual(COLUMNS.map((column) => column.slug), [
    "pending", "research", "site_selection", "negotiation", "legal", "due_diligence", "closing", "closed",
  ]);
  assert.deepEqual(COLUMNS.map((column) => column.label), [
    "Pending", "Research", "Site selection", "Negotiation", "Legal", "Due diligence", "Closing", "Closed",
  ]);
  // The board's labels are a display map OVER the client's UI values; the two
  // long-standing Deal Room names are untouched, which is what keeps the pinned
  // markup at /deals green.
  assert.equal(columnBySlug("pending").value, "On Deck");
  assert.equal(columnBySlug("due_diligence").value, "Diligence");
  assert.equal(columnLabel("On Deck"), "Pending");
  assert.equal(columnLabel("Diligence"), "Due diligence");
  // /deals now prints the same display words as the board. One map per word,
  // asserted against the other, so the two surfaces cannot drift apart.
  for (const column of COLUMNS) {
    assert.equal(phaseLabel(column.value), column.label, `${column.value} reads differently on the two surfaces`);
  }
});

test("the /deals phase select shows the display word and writes the wire word", async () => {
  assert.equal(phaseLabel("On Deck"), "Pending");
  assert.equal(phaseLabel("Diligence"), "Due diligence");
  for (const phase of PHASES) {
    if (phase !== "On Deck" && phase !== "Diligence") assert.equal(phaseLabel(phase), phase, `${phase} is renamed`);
  }
  // The option the /deals table renders: the wire word in the value attribute,
  // the display word in the text, so a write still sends 'On Deck'.
  const app = await read("js/app.js");
  assert.match(app, /<option value="\$\{esc\(phase\)\}"/, "the option carries the wire value explicitly");
  assert.match(app, /\$\{esc\(phaseLabel\(phase\)\)\}<\/option>/, "the option text is the display label");
  assert.match(app, /event\.target\.dataset\.phase, *'phase', *event\.target\.value/, "a phase write reads .value, never the option text");
});

test("every phase slug round-trips through the map that defect 5e355b84 made lossy", () => {
  // The defect: research and site_selection both displayed as "Research", and
  // no UI value mapped back to site_selection — so writing the board's own
  // label back moved a site-selection deal into research.
  const values = COLUMNS.map((column) => column.value);
  assert.equal(new Set(values).size, COLUMNS.length, "no two phases share a UI value");
  for (const column of COLUMNS) {
    assert.equal(columnByValue(column.value).slug, column.slug, `${column.slug} does not round-trip`);
    assert.ok(PHASES.includes(column.value), `${column.value} is not an interface phase`);
    assert.ok(PHICON[column.value], `${column.value} has no icon`);
  }
  assert.equal(PHASES.length, 8);
  assert.equal(columnByValue("Site selection").slug, "site_selection");
});

test("grouping files every row under its column and never guesses at one it cannot place", () => {
  const deals = [
    { id: "a", name: "Demo A", phase: "On Deck" },
    { id: "b", name: "Demo B", phase: "Site selection" },
    { id: "c", name: "Demo C", phase: "Not a phase" },
  ];
  const { columns, unplaced } = groupByColumn(deals);
  assert.equal(columns.length, 8);
  assert.deepEqual(columns.find((c) => c.slug === "pending").deals.map((d) => d.id), ["a"]);
  assert.deepEqual(columns.find((c) => c.slug === "site_selection").deals.map((d) => d.id), ["b"]);
  assert.deepEqual(unplaced.map((d) => d.id), ["c"], "an unknown phase is reported, not filed under a guess");
  assert.deepEqual(groupByColumn(null).unplaced, []);
});

test("a move intent names both ends, and a drop on the card's own column is not a move", () => {
  const deal = { id: "d20", name: "Demo Osteopathic Office", phase: "Diligence" };
  const intent = moveIntent(deal, "closing");
  assert.deepEqual({ ...intent }, {
    deal: "d20", name: "Demo Osteopathic Office", field: "phase", value: "Closing",
    from: "due_diligence", from_label: "Due diligence", to: "closing", to_label: "Closing",
  });
  assert.equal(moveSummary(intent), "Demo Osteopathic Office → Closing");
  assert.equal(moveTitle(intent), "Move Demo Osteopathic Office to Closing");
  assert.equal(moveIntent(deal, "due_diligence"), null, "the same column is not a move");
  assert.equal(moveIntent(deal, "not_a_phase"), null);
  assert.equal(moveIntent(null, "closing"), null);
});

test("the completion plan puts the phase patch first and carries only the follow-ups that were filled in", () => {
  const intent = moveIntent({ id: "d01", name: "Demo Dental North", phase: "On Deck" }, "legal");

  const bare = completionPlan(intent, {});
  assert.deepEqual(bare.errors, []);
  assert.equal(bare.steps.length, 1, "an empty dialog is still a move");
  assert.deepEqual(bare.steps[0], {
    verb: "patch-deal-field",
    args: { deal: "d01", field: "phase", value: "Legal" },
    summary: "Demo Dental North → Legal",
  });
  // An untouched box sends nothing at all — not a key holding an empty string.
  assert.equal("change_reason" in bare.steps[0].args, false);
  assert.equal("human_quote" in bare.steps[0].args, false);

  const full = completionPlan(intent, {
    evidence: "  Redline returned unchanged.  ",
    nextStep: "Send the countersigned copy",
    nextWhen: "2026-02-02",
    effectiveDate: "2026-02-01",
    recordCriticalDate: true,
    dateSource: "Landlord email",
  });
  assert.deepEqual(full.errors, []);
  assert.deepEqual(full.steps.map((step) => step.verb),
    ["patch-deal-field", "add-deal-note", "set-next-step", "add-critical-date"]);
  assert.equal(full.steps[1].args.text, "Redline returned unchanged.");
  assert.deepEqual(full.steps[2].args, { deal: "d01", text: "Send the countersigned copy", next_date: "2026-02-02" });
  assert.deepEqual(full.steps[3].args, { deal: "d01", kind: PHASE_DATE_KIND, due_on: "2026-02-01", source: "Landlord email" });

  // Whitespace is not an answer, and an unticked box writes nothing at all.
  const blank = completionPlan(intent, { evidence: "   ", effectiveDate: "2026-02-01", recordCriticalDate: false });
  assert.deepEqual(blank.steps.map((step) => step.verb), ["patch-deal-field"]);
});

test("the phase patch carries the partner's reason and sentence when they were typed", () => {
  const intent = moveIntent({ id: "d01", name: "Demo Dental North", phase: "On Deck" }, "legal");
  const plan = completionPlan(intent, {
    changeReason: "  Countersigned  ",
    humanQuote: "  They signed it this morning.  ",
  });
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.steps.length, 1, "neither field spawns a second verb");
  assert.deepEqual(plan.steps[0].args, {
    deal: "d01",
    field: "phase",
    value: "Legal",
    change_reason: "Countersigned",
    human_quote: "They signed it this morning.",
  });
});

test("whitespace is not a sentence", () => {
  const intent = moveIntent({ id: "d01", name: "Demo Dental North", phase: "On Deck" }, "legal");
  const plan = completionPlan(intent, { changeReason: "   ", humanQuote: "   " });
  assert.equal("change_reason" in plan.steps[0].args, false);
  assert.equal("human_quote" in plan.steps[0].args, false);
});

test("a critical date is refused without its source, and a date without a step is refused too", () => {
  const intent = moveIntent({ id: "d01", name: "Demo Dental North", phase: "On Deck" }, "closing");

  const noSource = completionPlan(intent, { effectiveDate: "2026-02-01", recordCriticalDate: true });
  assert.equal(noSource.steps.length, 1, "nothing beyond the move is planned");
  assert.ok(noSource.errors.some((line) => /where the date came from/.test(line)));

  const noDate = completionPlan(intent, { recordCriticalDate: true, dateSource: "Landlord email" });
  assert.ok(noDate.errors.some((line) => /Pick the effective date/.test(line)));

  const whenOnly = completionPlan(intent, { nextWhen: "2026-02-02" });
  assert.ok(whenOnly.errors.some((line) => /needs the step itself/.test(line)));
  assert.deepEqual(whenOnly.steps.map((step) => step.verb), ["patch-deal-field"]);

  assert.deepEqual(completionPlan(null, {}).steps, []);
});

test("no sentence the dialog prints claims a gate, and Closed says what it writes", () => {
  assert.equal(closedColumnCaption(), "Records the outcome and the closing date on the deal.");
  const source = completionPlan(
    moveIntent({ id: "d01", name: "Demo", phase: "On Deck" }, "legal"),
    { evidence: "x", nextStep: "y", effectiveDate: "2026-02-01", recordCriticalDate: true, dateSource: "z" },
  );
  for (const step of source.steps) {
    assert.doesNotMatch(step.summary, /blocked|required|gate|approve|permission/i);
  }
});

test("the arrow keys wrap at both ends and ignore every other key", () => {
  assert.equal(keyboardTarget("pending", "ArrowLeft"), "closed", "left from the first column wraps to the last");
  assert.equal(keyboardTarget("closed", "ArrowRight"), "pending", "right from the last wraps to the first");
  assert.equal(keyboardTarget("research", "ArrowRight"), "site_selection");
  assert.equal(keyboardTarget("research", "ArrowDown"), "site_selection", "down reads as forward");
  assert.equal(keyboardTarget("research", "ArrowUp"), "pending", "up reads as back");
  assert.equal(keyboardTarget("research", "Enter"), null);
  assert.equal(keyboardTarget("research", "Tab"), null);
  assert.equal(keyboardTarget("not_a_column", "ArrowRight"), "research", "an unknown start begins at the first column");
  assert.equal(keyboardTarget("pending", "ArrowRight", []), null);
});

test("a partner's lease reads as a chip, and the viewer's own never does", () => {
  const presence = [
    { actor: "joe", deal_id: "d01", field: "phase" },
    { actor: "dell", deal_id: "d02", field: "phase" },
    { actor: "dell", deal_id: "d03", field: "owner" },
  ];
  const label = (slug) => ({ joe: "Joe", dell: "Dell" }[slug]);
  assert.equal(presenceChip(presence, "d02", { selfActor: "joe", field: "phase", actorLabel: label }), "Dell is editing");
  assert.equal(presenceChip(presence, "d01", { selfActor: "joe", field: "phase", actorLabel: label }), null);
  assert.equal(presenceChip(presence, "d03", { selfActor: "joe", field: "phase", actorLabel: label }), null);
  assert.equal(presenceChip([], "d01", { selfActor: "joe" }), null);
});

test("the chips are built from the deal types the board returns, and filter by them", () => {
  const deals = [
    { id: "a", type: "Renewal" }, { id: "b", type: "Startup" }, { id: "c", type: "Renewal" }, { id: "d" },
  ];
  assert.deepEqual(typeFilters(deals).map((chip) => chip.value), ["all", "Renewal", "Startup"]);
  assert.deepEqual(filterDeals(deals, "Renewal").map((deal) => deal.id), ["a", "c"]);
  assert.equal(filterDeals(deals, "all").length, 4);
  assert.equal(filterDeals(deals, null).length, 4);
});

test("a column orders flagged records first, then by name, and the panel states what is missing", () => {
  const ordered = orderColumn([
    { id: "b", name: "Demo B" }, { id: "c", name: "Demo C", attention: true }, { id: "a", name: "Demo A" },
  ]);
  assert.deepEqual(ordered.map((deal) => deal.id), ["c", "a", "b"]);

  const sections = recordPanelSections({
    deal: { name: "Demo A", type: "Renewal", phase: "Diligence", owner: "joe", next_step: "", attention: false },
    critical_dates: [],
    thread: [],
  }, { actorLabel: (slug) => ({ joe: "Joe" }[slug] || "Unassigned"), dateLabel: (value) => value });
  assert.deepEqual(sections.map((section) => section.title),
    ["Situation", "Next action", "Critical dates", "Blockers", "Latest communication", "Doc work"]);
  assert.match(sections[0].lines[0], /Due diligence/, "the panel says the phase's own name");
  assert.equal(sections[1].lines[0], "No next step recorded.");
  assert.deepEqual(sections[2].lines, ["None recorded."]);
  assert.deepEqual(sections[5].lines, ["Not in this release."]);
});

/* -------------------------------------------------------- the fixture round trip */

async function boardRow(client, dealId) {
  const board = await client.getBoard();
  return board.deals.find((deal) => deal.id === dealId);
}

test("a drop sends the board's own field_base and comes back with the committed event", async () => {
  const client = await newClient();
  const row = await boardRow(client, "d20");
  assert.equal(row.phase, "Diligence");
  const intent = moveIntent(row, "closing");
  const [phaseStep] = completionPlan(intent, {}).steps;

  const answer = await client.patchDealField({
    ...phaseStep.args,
    base_event_id: row.field_base?.phase?.id || null,
    idempotency_key: "key-move-1",
  });
  assert.equal(answer.status, "ok");
  assert.ok(answer.event_id, "the answer names the event it committed");
  assert.ok(answer.event_recorded_at);
  assert.equal((await boardRow(client, "d20")).phase, "Closing");
});

test("a stale base is a conflict, not a silent overwrite, and resolve-conflict settles it", async () => {
  const client = await newClient();
  const row = await boardRow(client, "d01");
  await client.patchDealField({
    deal: "d01", field: "phase", value: "Research",
    base_event_id: row.field_base?.phase?.id || null, idempotency_key: "key-first",
  });
  // The second write was built from the base the FIRST one superseded.
  const stale = await client.patchDealField({
    deal: "d01", field: "phase", value: "Legal",
    base_event_id: row.field_base?.phase?.id || null, idempotency_key: "key-second",
  });
  assert.equal(stale.status, "conflict");
  assert.equal(stale.conflict.field, "phase");
  assert.equal(stale.conflict.deal, "d01");
  assert.ok(stale.conflict.conflict_id);
  assert.equal(stale.conflict.a.value, "Research", "the server's side is what it holds now");
  assert.equal(stale.conflict.b.value, "Legal");

  const settled = await client.resolveConflict({
    conflict_id: stale.conflict.conflict_id, winner: "b", idempotency_key: "key-resolve",
  });
  assert.equal(settled.status, "ok");
  assert.equal((await boardRow(client, "d01")).phase, "Legal");
});

test("a re-send under the same key replays the stored answer instead of writing again", async () => {
  const client = await newClient();
  const row = await boardRow(client, "d05");
  const request = {
    deal: "d05", field: "phase", value: "Closed",
    base_event_id: row.field_base?.phase?.id || null, idempotency_key: "key-replay",
  };
  const first = await client.patchDealField({ ...request });
  const second = await client.patchDealField({ ...request });
  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  assert.equal(second.event_id, first.event_id, "the replay names the same event");
  const changes = await client.getChanges(null);
  const phaseEvents = changes.events.filter((event) => event.subject_id === "d05" && event.field === "phase");
  assert.equal(phaseEvents.length, 1, "the second send wrote nothing");
});

test("the follow-ups run after the phase is accepted, each on its own key, and a failure does not un-move the card", async () => {
  const client = await newClient();
  const row = await boardRow(client, "d03");
  const intent = moveIntent(row, "legal");
  const plan = completionPlan(intent, {
    evidence: "Counterparty accepted the sample terms.",
    nextStep: "Circulate the fictional draft",
    nextWhen: "2026-02-10",
    effectiveDate: "2026-02-05",
    recordCriticalDate: true,
    dateSource: "Demo counsel email",
  });
  assert.deepEqual(plan.errors, []);

  const send = {
    "patch-deal-field": (args) => client.patchDealField({ ...args, base_event_id: row.field_base?.phase?.id || null, idempotency_key: "k-phase" }),
    "add-deal-note": (args) => client.addDealNote({ ...args, idempotency_key: "k-note" }),
    "set-next-step": (args) => client.setNextStep({ ...args, idempotency_key: "k-step" }),
    "add-critical-date": (args) => client.addCriticalDate({ ...args, idempotency_key: "k-date" }),
  };
  const [phaseStep, ...followUps] = plan.steps;
  const phase = await send["patch-deal-field"](phaseStep.args);
  assert.equal(phase.status, "ok");
  for (const step of followUps) assert.equal((await send[step.verb](step.args)).status, "ok");

  const detail = await client.getDeal("d03");
  assert.equal(detail.deal.phase, "Legal");
  // The note and the superseded next step are both in the thread; the archive
  // is the newest entry because set-next-step ran last.
  assert.ok(detail.thread.some((entry) => entry.kind === "note" && entry.text === "Counterparty accepted the sample terms."));
  assert.equal(detail.thread[0].kind, "archived_step", "the step it replaced is kept, never erased");
  assert.equal(detail.deal.next_step, "Circulate the fictional draft");
  const recorded = detail.critical_dates.find((entry) => entry.source === "Demo counsel email");
  assert.ok(recorded, "the critical date is on the record");
  assert.equal(recorded.due_on, "2026-02-05");
  assert.equal(recorded.kind, PHASE_DATE_KIND);

  // The record layer refuses a critical date with no source; the fixture must
  // refuse it too, and the card stays exactly where the phase patch put it.
  await assert.rejects(
    client.addCriticalDate({ deal: "d03", kind: PHASE_DATE_KIND, due_on: "2026-02-06", source: "", idempotency_key: "k-bad" }),
    /source required/,
  );
  assert.equal((await boardRow(client, "d03")).phase, "Legal");
});

test("the fixture accepts every one of the eight phases by its board value", async () => {
  const client = await newClient();
  let base = (await boardRow(client, "d07")).field_base?.phase?.id || null;
  for (const [index, column] of COLUMNS.entries()) {
    const answer = await client.patchDealField({
      deal: "d07", field: "phase", value: column.value, base_event_id: base, idempotency_key: `k-walk-${index}`,
    });
    assert.equal(answer.status, "ok", `${column.slug} was refused`);
    base = answer.event_id;
  }
  assert.equal((await boardRow(client, "d07")).phase, "Closed");
});

/* ------------------------------------------------------- what js/pipeline.js is */

test("js/pipeline.js reads the board in exactly one place, through the coordinator", async () => {
  const source = await read("js/pipeline.js");
  assert.match(source, /from '\.\/board-sync\.mjs'/);
  assert.equal((source.match(/getBoard\(/g) || []).length, 1, "one board read path");
  assert.equal((source.match(/getChanges\(/g) || []).length, 1, "one changes read path");
  assert.match(source, /readBoard: \(\) => state\.client\.getBoard\(\{ workspace: 'all' \}\)/);
  assert.match(source, /readChanges: \(cursor\) => state\.client\.getChanges\(cursor\)/);
  assert.equal((source.match(/state\.deals = new Map/g) || []).length, 1,
    "one place builds the board, and only an applied snapshot reaches it");
  assert.match(source, /function applyBoardSnapshot\(board\)/);
  assert.doesNotMatch(source, /state\.cursor/, "the cursor belongs to the coordinator");
});

test("js/pipeline.js copies no value out of a change event and holds ids rather than rows", async () => {
  const source = await read("js/pipeline.js");
  const poll = source.slice(source.indexOf("async function pollOnce"), source.indexOf("/* ------------------------------------------------------------------- writing"));
  assert.match(poll, /NO VALUE IS TAKEN FROM AN EVENT/);
  assert.match(poll, /noteCellBase\(cellKey\(event\.subject_id, event\.field\), event\)/);
  assert.match(poll, /batchTouchesBoard\(batch\)\) state\.boardSync\.requestRefresh\('change-feed'\)/,
    "a touching batch buys exactly one coalesced re-read");
  assert.doesNotMatch(poll, /deal\.phase = |Object\.assign\(deal, event/, "no event value is written onto a row");

  // Identity is the id: the lifted card, the open panel and the move in hand are
  // all ids, resolved against the board at the moment they are used.
  assert.match(source, /lifted: null,/);
  assert.match(source, /panelDeal: null,/);
  assert.match(source, /const deal = state\.deals\.get\(id\);/);
  assert.match(source, /if \(state\.panelDeal !== dealId\) return;/,
    "a late detail read never paints over a record the person has since opened");

  const noteCellBase = source.slice(source.indexOf("function noteCellBase"), source.indexOf("function applyBoardSnapshot"));
  assert.match(noteCellBase, /const seen = \{ id: event\.id, recorded_at: event\.recorded_at \?\? null \};/,
    "the base map holds identity and time, never a value");
  assert.match(noteCellBase, /nextCellBase\(/, "the forward-only rule is imported, not re-implemented");
});

test("js/pipeline.js sends the phase first, through the field-write kernel, and the follow-ups only after an ok", async () => {
  const source = await read("js/pipeline.js");
  assert.match(source, /performFieldWrite\(\{/, "the one edited cell goes through the cell kernel");
  assert.match(source, /performCommand\(\{/, "each follow-up is its own command");
  const runMove = source.slice(source.indexOf("async function runMove"), source.indexOf("async function retryFieldWrite"));
  assert.match(runMove, /const \[phaseStep, \.\.\.followUps\] = plan\.steps;/);
  assert.ok(runMove.indexOf("sendPhaseWrite") < runMove.indexOf("for (const step of followUps)"),
    "the phase patch is sent before any follow-up");
  assert.match(runMove, /if \(result\.status === 'conflict'\)/);
  assert.match(runMove, /if \(result\.status !== 'ok'\) \{/);
  assert.match(runMove, /if \(result\.superseded\) \{/, "an accepted answer the board has moved past withholds its value");
  assert.match(runMove, /confirmLocalWrite\(intent\.deal, \{ phase: phaseStep\.args\.value \}\)/);

  const send = source.slice(source.indexOf("async function sendPhaseWrite"), source.indexOf("const FOLLOW_UP_SENDERS"));
  assert.match(send, /newKey: uuidv4/, "one key per intended action");
  assert.match(send, /baseNow: \(\) => state\.fieldBase\.get\(cell\)\?\.id \|\| null/);
  assert.doesNotMatch(source, /\bTODO\b/);
});

test("js/pipeline-model.js is pure: no DOM, no client, no network", async () => {
  const source = await read("js/pipeline-model.js");
  assert.doesNotMatch(source, /document|window|localStorage|fetch\(|innerHTML/);
  assert.doesNotMatch(source, /^import /m, "the model imports nothing");
  assert.doesNotMatch(source, /\bTODO\b/);
});

/* ------------------------------------------------------------ what the page says */

test("pipeline.html is a drag board with a hidden keyboard path and no Move button", async () => {
  const html = await read("pipeline.html");
  assert.match(html, /<div class="kanban" id="kanban"/);
  assert.match(html, /id="dragLive" aria-live="assertive"/, "moves are announced");
  assert.doesNotMatch(html, /<button[^>]*>\s*Move\s*<\/button>/, "there is no Move button");
  assert.match(html, /press Enter to lift it/, "the keyboard path is stated on the page");
  assert.match(html, /Arrows choose a column, Enter drops, Escape cancels/);
});

test("pipeline.html asks for dates with a calendar only, and never claims a gate", async () => {
  const html = await read("pipeline.html");
  assert.match(html, /id="completionDate" type="date"/);
  assert.match(html, /id="completionNextWhen" type="date"/);
  assert.doesNotMatch(html, /type="date"[^>]*placeholder/, "no typed-date fallback");
  assert.doesNotMatch(html, /DateTyped/);
  assert.match(html, /CARR does not require evidence to move a phase\./);
  assert.match(html, /Not recorded anywhere; the move is dated by when it is saved\./);
  assert.match(html, /value="cancel"|id="completionCancel"/);
  assert.match(html, />Cancel, keep phase</);
  // No sentence on this page may imply a check the record layer does not make.
  for (const phrase of ["needs evidence", "blocked", "not allowed", "requires approval", "cannot move until"]) {
    assert.ok(!html.toLowerCase().includes(phrase), `the page still says "${phrase}"`);
  }
  assert.doesNotMatch(html, /data-drop="blocked"/);
});

test("pipeline.html carries the shared shell exactly once and nothing under its title", async () => {
  const html = await read("pipeline.html");
  assert.equal((html.match(/id="docFab"/g) || []).length, 1, "one floating Doc");
  assert.equal((html.match(/id="docChat"/g) || []).length, 1);
  assert.match(html, /id="docReading">Doc is reading: Deals</);
  assert.match(html, /id="receiptDock"/, "the command dock is on the page");
  assert.match(html, /id="pendingWrites"/, "unconfirmed writes have a home above the board");
  assert.match(html, /<dialog id="completionDialog"/);
  assert.match(html, /<dialog id="conflictDialog"/);
  assert.match(html, /<dialog id="receiptsDialog"/, "recent changes are a popup, not an inline panel");
  assert.match(html, /<aside id="recordPanel" class="side-panel glass"[^>]*data-pinned="false"/);
  assert.match(html, /id="panelPin" aria-pressed="false"/);
  assert.doesNotMatch(html, /<p class="(?:intro|lede|description)"/);
  assert.match(html, /<h1 id="pageTitle">Deals<\/h1>/, "Joe's name for this surface, on this surface");
  assert.match(html, /<link rel="stylesheet" href="\/css\/system\.css">/);
});

test("every control on the page clears the 44 px floor through the shared classes", async () => {
  const html = await read("pipeline.html");
  const css = await read("css/system.css");
  assert.match(css, /--touch: 44px/);
  assert.match(css, /\.btn \{[^}]*min-height: var\(--touch\)/);
  const pipelineCss = await read("css/pipeline.css");
  assert.match(pipelineCss, /\.check-option \{[^}]*min-height: var\(--touch\)/,
    "the one control this page adds is a full touch target");
  for (const match of html.matchAll(/<button\b[^>]*class="([^"]*)"/g)) {
    assert.match(match[1], /\bbtn\b|\bchip\b|\bpref-icon\b|\bdoc-fab\b|\bcard-open\b/,
      `a button is outside the sized classes: ${match[0]}`);
  }
});

test("the route and the verbs this surface needs are pinned in the contracts", async () => {
  const routes = JSON.parse(await read("contracts/app-routes.v1.json"));
  assert.equal(routes.routes["/pipeline"], "pipeline.html");
  assert.equal(routes.routes["/deals"], "index.html", "the existing Deal Room keeps its route");
  const contract = JSON.parse(await read("contracts/carr-interface.v1.json"));
  for (const verb of ["patch-deal-field", "add-deal-note", "set-next-step", "add-critical-date", "resolve-conflict", "presence-lease", "revert-deal-field"]) {
    assert.ok(contract.mcp_operations.includes(verb), `${verb} is not pinned`);
  }
});

/* ------------------------------------------------- Closed records an outcome */

const closedIntent = () => moveIntent({ id: "d05", name: "Demo Family Clinic", phase: "Closing" }, CLOSED_SLUG);

test("a move into Closed plans the outcome write, and only into Closed", () => {
  assert.equal(CLOSED_SLUG, "closed");
  assert.deepEqual(DEAL_OUTCOMES.map((entry) => entry.value), ["won", "lost", "paused"]);
  assert.ok(isDealOutcome("paused"));
  assert.equal(isDealOutcome("closed"), false, "the phase is not an outcome");

  const won = completionPlan(closedIntent(), { outcome: "won", closedOn: "2026-09-17", wonValue: "48000" });
  assert.deepEqual(won.errors, []);
  assert.deepEqual(won.steps.map((step) => step.verb), ["patch-deal-field", "update-deal"]);
  assert.deepEqual(won.steps[1].args, {
    deal: "d05",
    fields: { outcome: "won", closed_on: "2026-09-17", won_value: 48000 },
  });
  assert.equal(won.steps[1].summary, "Outcome won on Demo Family Clinic");
  assert.ok(!("base_version" in won.steps[1].args),
    "the version is read fresh at send time, never planned from a stale read");

  // The money belongs to a won record and to nothing else.
  const lost = completionPlan(closedIntent(), { outcome: "lost", closedOn: "2026-09-17", wonValue: "48000" });
  assert.deepEqual(lost.steps[1].args.fields, { outcome: "lost", closed_on: "2026-09-17" });
  const paused = completionPlan(closedIntent(), { outcome: "paused", closedOn: "2026-09-17" });
  assert.deepEqual(paused.steps[1].args.fields, { outcome: "paused", closed_on: "2026-09-17" });
  const noValue = completionPlan(closedIntent(), { outcome: "won", closedOn: "2026-09-17", wonValue: "  " });
  assert.deepEqual(noValue.steps[1].args.fields, { outcome: "won", closed_on: "2026-09-17" });

  // Every other column is untouched by this slice.
  const legal = completionPlan(moveIntent({ id: "d01", name: "Demo Dental North", phase: "On Deck" }, "legal"),
    { outcome: "won", closedOn: "2026-09-17" });
  assert.deepEqual(legal.steps.map((step) => step.verb), ["patch-deal-field"]);
  assert.deepEqual(legal.errors, []);
});

test("Closed refuses without an outcome, and refuses an outcome the record layer would bounce", () => {
  const missing = completionPlan(closedIntent(), { closedOn: "2026-09-17" });
  assert.deepEqual(missing.steps.map((step) => step.verb), ["patch-deal-field"],
    "nothing beyond the move is planned");
  assert.ok(missing.errors.some((line) => /outcome/i.test(line)), "the sentence names the missing outcome");
  assert.match(missing.errors[0], /Won, Lost or Paused/);

  const invented = completionPlan(closedIntent(), { outcome: "settled", closedOn: "2026-09-17" });
  assert.deepEqual(invented.steps.map((step) => step.verb), ["patch-deal-field"]);
  assert.ok(invented.errors.some((line) => /won, lost or paused/.test(line)));

  const nonsense = completionPlan(closedIntent(), { outcome: "won", closedOn: "2026-09-17", wonValue: "lots" });
  assert.deepEqual(nonsense.steps.map((step) => step.verb), ["patch-deal-field"]);
  assert.ok(nonsense.errors.some((line) => /must be a number/.test(line)));
});

test("the fixture takes the outcome write only against the version the deal holds now", async () => {
  const client = await newClient();
  const before = await client.getDeal("d05");
  assert.equal(before.deal.version, 1);
  assert.equal(before.deal.outcome, null);

  await assert.rejects(
    () => client.updateDeal({ deal: "d05", fields: { outcome: "won" }, idempotency_key: "k-no-base" }),
    (error) => error.payload.error === "missing_base_version",
  );
  await assert.rejects(
    () => client.updateDeal({ deal: "d05", base_version: 7, fields: { outcome: "won" }, idempotency_key: "k-stale" }),
    (error) => error.payload.error === "version_conflict",
  );
  await assert.rejects(
    () => client.updateDeal({ deal: "d05", base_version: 1, fields: { outcome: "settled" }, idempotency_key: "k-enum" }),
    (error) => error.payload.error === "deal_outcome_check",
  );

  const answer = await client.updateDeal({
    deal: "d05", base_version: 1,
    fields: { outcome: "won", closed_on: "2026-09-17", won_value: 48000 },
    idempotency_key: "k-outcome",
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.version, 2);
  const after = await client.getDeal("d05");
  assert.equal(after.deal.outcome, "won");
  assert.equal(after.deal.closed_on, "2026-09-17");
  assert.equal(after.deal.won_value, 48000);

  // A replay under the same key returns the stored answer instead of writing again.
  const replay = await client.updateDeal({
    deal: "d05", base_version: 1,
    fields: { outcome: "won", closed_on: "2026-09-17", won_value: 48000 },
    idempotency_key: "k-outcome",
  });
  assert.equal(replay.version, 2, "the second send wrote nothing");
  assert.equal((await client.getDeal("d05")).deal.version, 2);
});

test("the Closed dialog offers the three outcomes, a picker for the date, and both adapters can send it", async () => {
  const html = await read("pipeline.html");
  assert.match(html, /id="completionOutcomeField"[^>]*hidden/, "the outcome belongs to the Closed move only");
  for (const value of ["won", "lost", "paused"]) {
    assert.match(html, new RegExp(`name="completionOutcome" value="${value}"`));
  }
  assert.match(html, /id="completionClosedOn" type="date"/, "a calendar picker, never a typed-date box");
  assert.match(html, /id="completionWonValue" type="number"/);
  assert.match(html, /id="completionWonValueField"[^>]*hidden/, "the value shows only on a won outcome");

  const pageJs = await read("js/pipeline.js");
  assert.match(pageJs, /runOutcomeWrite/);
  assert.match(pageJs, /state\.client\.getDeal\(intent\.deal\)/, "the base_version comes from a fresh read");
  assert.match(pageJs, /base_version: version/);
  const live = await read("js/live-client.js");
  assert.match(live, /async updateDeal\(args\) \{\s*return write\('update-deal', args\);/);

  const contract = JSON.parse(await read("contracts/carr-interface.v1.json"));
  assert.ok(contract.mcp_operations.includes("update-deal"));
  assert.equal(contract.version, "1.10.0");
});

test("the fixture carries the reason and the sentence onto the phase event, word for word", async () => {
  const client = await newClient();
  const row = await boardRow(client, "d20");
  const intent = moveIntent(row, "closing");
  const plan = completionPlan(intent, {
    changeReason: "Countersigned",
    humanQuote: "They signed it this morning.",
  });
  const answer = await client.patchDealField({
    ...plan.steps[0].args,
    base_event_id: row.field_base?.phase?.id || null,
    idempotency_key: "key-words-1",
  });
  assert.equal(answer.status, "ok");

  const changes = await client.getChanges(null);
  const event = changes.events.find((entry) => entry.id === answer.event_id);
  assert.ok(event, "the committed event is on the feed");
  assert.equal(event.field, "phase");
  assert.equal(event.change_reason, "Countersigned");
  assert.equal(event.human_quote, "They signed it this morning.", "sent verbatim, never composed");

  // A move with neither field is not refused; it simply records none.
  const plain = await client.patchDealField({
    deal: "d01", field: "phase", value: "Research",
    base_event_id: (await boardRow(client, "d01")).field_base?.phase?.id || null,
    idempotency_key: "key-words-2",
  });
  assert.equal(plain.status, "ok");
  const plainEvent = (await client.getChanges(null)).events.find((entry) => entry.id === plain.event_id);
  assert.equal(plainEvent.change_reason, null);
  assert.equal(plainEvent.human_quote, null);
});

test("the completion dialog asks for the reason and the partner's own words, and claims no gate", async () => {
  const html = await read("pipeline.html");
  assert.match(html, /id="completionReason"/);
  assert.match(html, /id="completionQuote"/);
  assert.match(html, /A short reason, saved with the phase change itself\./);
  assert.match(html, /Your own sentence, saved word for word with the phase change\./);
  for (const phrase of ["needs evidence", "blocked", "not allowed", "requires approval", "cannot move until"]) {
    assert.ok(!html.toLowerCase().includes(phrase), `the page still says "${phrase}"`);
  }
});

test("the two new controls' values reach the completion plan", async () => {
  const pageJs = await read("js/pipeline.js");
  assert.match(pageJs, /changeReason: \$\('completionReason'\)/);
  assert.match(pageJs, /humanQuote: \$\('completionQuote'\)/);
});
