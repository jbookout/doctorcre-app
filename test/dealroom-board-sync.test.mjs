// Deal Room board sync: where the values on the board come from, and what
// happens when two reads, a write and a poll are in flight at once.
//
// Every ordering claim here is EXECUTED. The reads are deferred promises
// resolved in a deliberate order, so an overlapping refresh, a slow read, a
// failed read and a poll that lands late are real sequences rather than
// descriptions of one.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createBoardSync, createHolds, mergeBoardSnapshot, batchTouchesBoard,
  resolveCurrentRow, SYNC_STATES, HEALTH,
} from "../js/board-sync.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let every already-settled microtask run before asserting. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const deal = (overrides = {}) => ({
  id: "d1", name: "Riverbank Dental", phase: "Research", owner: "joe", attention: false,
  next_step: "Call broker", next_date: "2026-10-01", operating_state: "active",
  parking_reason: null, account_client_id: null, ...overrides,
});

const board = (deals, extra = {}) => ({ actor: "joe", deals, accounts: [], ...extra });

const changes = (events = [], extra = {}) => ({
  events, presence: [], capture_sessions: [], cursor: "c1", ...extra,
});

const changeEvent = (overrides = {}) => ({
  id: "e1", recorded_at: "2026-09-10T14:00:00.000000+00:00", actor: "dell",
  verb: "patch-deal-field", subject_type: "deal", subject_id: "d1",
  field: "phase", old_value: "Research", new_value: "Negotiation", ...overrides,
});

/**
 * A coordinator over scripted reads. `boardReads` and `changeReads` are queues
 * of thunks; each call takes the next one, so a test decides exactly what the
 * Nth read does and when it answers.
 */
function harness({ boardReads = [], changeReads = [], now = null } = {}) {
  const applied = [];
  const statuses = [];
  let clock = 1000;
  const sync = createBoardSync({
    readBoard: () => {
      const next = boardReads.shift();
      if (!next) throw new Error("no scripted board read left");
      return next();
    },
    readChanges: (cursor) => {
      const next = changeReads.shift();
      if (!next) throw new Error("no scripted change read left");
      return next(cursor);
    },
    applyBoard: (payload, meta) => { applied.push({ payload, meta }); },
    onStatus: (status) => { statuses.push(status); },
    now: now || (() => { clock += 1; return clock; }),
  });
  return {
    sync, applied, statuses,
    last: () => applied.at(-1),
    deals: () => (applied.at(-1)?.payload.deals || []),
    dealById: (id) => (applied.at(-1)?.payload.deals || []).find((row) => row.id === id) || null,
  };
}

// ------------------------------------------------- values come from the board

test("a board snapshot is the only thing that sets a value, and the feed never does", async () => {
  const ancient = changeEvent({
    id: "old-1", recorded_at: "2025-01-04T09:00:00.000000+00:00",
    field: "phase", old_value: "On Deck", new_value: "On Deck",
  });
  const h = harness({
    boardReads: [() => Promise.resolve(board([deal({ phase: "Closing" })]))],
    changeReads: [() => Promise.resolve(changes([ancient], { cursor: "page-1" }))],
  });

  await h.sync.refreshBoard({ reason: "load" });
  assert.equal(h.dealById("d1").phase, "Closing");

  // The oldest page of the log arrives. It carries a phase from January.
  const poll = await h.sync.pollChanges();
  assert.equal(poll.applied, true);
  assert.equal(poll.changes.events[0].new_value, "On Deck", "the page really does carry an old value");
  assert.equal(h.applied.length, 1, "polling applied no board snapshot of its own");
  assert.equal(h.dealById("d1").phase, "Closing", "and the board value did not move");
  assert.equal(h.sync.status().cursor, "page-1", "the cursor advanced; only the values are off limits");
});

// ------------------------------------------------------ serialized board reads

test("overlapping refreshes never run two board reads, and collapse into one follow-up", async () => {
  const first = deferred();
  const second = deferred();
  const h = harness({ boardReads: [() => first.promise, () => second.promise] });

  const a = h.sync.refreshBoard({ reason: "load" });
  const b = h.sync.refreshBoard({ reason: "user" });
  const c = h.sync.refreshBoard({ reason: "user-again" });
  await settle();
  assert.equal(h.sync.stats().board_reads, 1, "the second and third requests started no read");
  assert.equal(h.sync.status().refresh_pending, true);

  first.resolve(board([deal({ phase: "Research" })]));
  await settle();
  assert.equal(h.sync.stats().board_reads, 2, "exactly one follow-up, however many asked");
  second.resolve(board([deal({ phase: "Legal" })]));

  const [outA, outB, outC] = await Promise.all([a, b, c]);
  assert.equal(outA.reason, "applied");
  assert.equal(outB, outC, "the coalesced callers share one answer");
  assert.equal(outB.reason, "applied");
  assert.equal(h.applied.length, 2);
  assert.equal(h.dealById("d1").phase, "Legal", "the later snapshot is the one on screen");
  assert.equal(h.sync.stats().board_coalesced, 1);
  assert.equal(h.sync.status().refresh_pending, false);
});

test("a caller that asks after its own write waits for a NEW read, not the open one", async () => {
  // The open read was issued before the write was confirmed, so joining it
  // would answer with data that cannot contain it. This is why a request that
  // arrives mid-flight queues a fresh read instead of sharing the current one.
  const open = deferred();
  const follow = deferred();
  const h = harness({ boardReads: [() => open.promise, () => follow.promise] });

  h.sync.refreshBoard({ reason: "background" });
  await settle();
  h.sync.noteLocalWrite("d1", { phase: "Closing" });
  const afterWrite = h.sync.refreshBoard({ reason: "after-write" });
  open.resolve(board([deal({ phase: "Research" })]));
  await settle();
  follow.resolve(board([deal({ phase: "Closing" })]));

  const outcome = await afterWrite;
  assert.equal(outcome.reason, "applied");
  assert.equal(outcome.ticket.reason, "after-write", "the caller got its own read's answer");
  assert.equal(h.applied.length, 2, "both reads landed; the caller waited for the second");
  assert.equal(h.dealById("d1").phase, "Closing");
});

test("a superseded answer is discarded: it applies nothing and moves no clock", async () => {
  const hung = deferred();
  const fresh = deferred();
  const h = harness({ boardReads: [() => hung.promise, () => fresh.promise] });

  const hungRead = h.sync.refreshBoard({ reason: "first" });
  await settle();
  // The reconnect path: do not queue behind a read that may never answer.
  const forced = h.sync.refreshBoard({ reason: "reconnect", force: true });
  fresh.resolve(board([deal({ phase: "Closing" })]));
  assert.equal((await forced).applied, true);
  const readAt = h.sync.status().last_read_at;

  hung.resolve(board([deal({ phase: "On Deck" })]));
  const late = await hungRead;
  assert.equal(late.applied, false);
  assert.equal(late.reason, "superseded");
  assert.equal(h.applied.length, 1, "the late answer never reached the page");
  assert.equal(h.dealById("d1").phase, "Closing");
  assert.equal(h.sync.status().last_read_at, readAt, "and it did not claim a fresh read");
  assert.equal(h.sync.stats().board_superseded, 1);
});

// --------------------------------------------------- slow, failed, recovering

test("a failed read leaves the last successful values on screen and says so", async () => {
  const h = harness({
    boardReads: [
      () => Promise.resolve(board([deal({ phase: "Research" })])),
      () => Promise.reject(new Error("board read -> 503")),
      () => Promise.resolve(board([deal({ phase: "Legal" })])),
    ],
  });

  await h.sync.refreshBoard({ reason: "load" });
  const good = h.sync.status();
  assert.equal(good.state, SYNC_STATES.READY);
  assert.ok(good.last_read_at, "a successful read is dated");

  const failed = await h.sync.refreshBoard({ reason: "retry" });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "read_failed");
  const after = h.sync.status();
  assert.equal(after.state, SYNC_STATES.RECONNECTING);
  assert.equal(after.last_read_at, good.last_read_at,
    "the freshness of the values on screen is unchanged, because they are unchanged");
  assert.match(after.last_error, /503/);
  assert.equal(h.applied.length, 1, "nothing was re-rendered from a failure");
  assert.equal(h.dealById("d1").phase, "Research");

  await h.sync.refreshBoard({ reason: "retry" });
  assert.equal(h.sync.status().state, SYNC_STATES.READY);
  assert.equal(h.sync.status().last_error, null);
  assert.notEqual(h.sync.status().last_read_at, good.last_read_at);
  assert.equal(h.dealById("d1").phase, "Legal");
});

test("the badge never claims more than has actually been read", async () => {
  const slow = deferred();
  const h = harness({
    boardReads: [() => slow.promise, () => Promise.resolve(board([deal()]))],
    changeReads: [() => Promise.resolve(changes())],
  });
  assert.equal(h.sync.status().state, SYNC_STATES.STARTING);
  assert.equal(h.sync.status().last_read_at, null);

  const read = h.sync.refreshBoard({ reason: "load" });
  assert.equal(h.statuses.at(-1).state, SYNC_STATES.SYNCING, "a read a person is waiting on says so");

  // A successful change poll is not evidence that the VALUES are current.
  await h.sync.pollChanges();
  assert.equal(h.sync.status().state, SYNC_STATES.SYNCING);
  assert.equal(h.sync.status().snapshots, 0);
  assert.equal(h.sync.status().feed_health, HEALTH.OK);
  assert.equal(h.sync.status().board_health, HEALTH.UNREAD,
    "the feed's success is recorded against the feed and nothing else");

  slow.resolve(board([deal()]));
  await read;
  assert.equal(h.sync.status().state, SYNC_STATES.READY);
  assert.equal(h.sync.status().snapshots, 1);

  // A background refresh (the feed asked for it) changes no badge while it runs.
  const quiet = h.sync.requestRefresh("change-feed");
  assert.equal(h.sync.status().state, SYNC_STATES.READY, "a background read does not flash the badge");
  await quiet;
  assert.equal(h.sync.status().state, SYNC_STATES.READY);
});

// Regression, root's reproduction: after a board read failed, a poll that
// succeeded with an empty page repainted the badge "ready" — a working feed
// answering for values it does not carry.
test("a working feed cannot clear a failed board read, and a fresh board cannot hide a failed feed", async () => {
  const h = harness({
    boardReads: [
      () => Promise.resolve(board([deal()])),
      () => Promise.reject(new Error("board -> 503")),
      () => Promise.resolve(board([deal({ phase: "Legal" })])),
    ],
    changeReads: [
      () => Promise.resolve(changes([], { cursor: "c1" })),
      () => Promise.resolve(changes([], { cursor: "c2" })),
      () => Promise.reject(new Error("changes -> 500")),
      () => Promise.resolve(changes([], { cursor: "c3" })),
    ],
  });
  await h.sync.refreshBoard({ reason: "load" });
  await h.sync.pollChanges();
  assert.equal(h.sync.status().state, SYNC_STATES.READY);

  // One direction: the board read fails, then the feed answers.
  await h.sync.refreshBoard({ reason: "retry" });
  assert.equal(h.sync.status().board_health, HEALTH.FAILED);
  const afterFeed = await h.sync.pollChanges();
  assert.equal(afterFeed.applied, true, "the feed really did answer");
  assert.equal(h.sync.status().feed_health, HEALTH.OK);
  assert.equal(h.sync.status().state, SYNC_STATES.RECONNECTING,
    "a feed that works says nothing about whether the values are current");
  assert.match(h.sync.status().last_error, /503/, "and the board's trouble is the one reported");
  assert.equal(h.sync.status().cursor, "c2", "while the feed still did its own job");

  // The other direction: the board recovers while the feed is the broken one.
  const feedFailed = await h.sync.pollChanges();
  assert.equal(feedFailed.ok, false);
  assert.equal(h.sync.status().feed_health, HEALTH.FAILED);
  await h.sync.refreshBoard({ reason: "retry" });
  assert.equal(h.sync.status().board_health, HEALTH.OK);
  assert.equal(h.dealById("d1").phase, "Legal", "the snapshot did apply");
  assert.equal(h.sync.status().state, SYNC_STATES.RECONNECTING,
    "a fresh snapshot does not hide a feed that stopped answering");
  assert.match(h.sync.status().last_error, /500/);

  await h.sync.pollChanges();
  assert.equal(h.sync.status().state, SYNC_STATES.READY, "both paths healthy, and only then");
  assert.equal(h.sync.status().last_error, null);
});

// Regression, root's reproduction: start A, queue B, force C, settle A — and B
// started a third read behind C, bumped the sequence, and stopped C applying.
test("forcing a read cancels the queued one, so old work cannot overtake the new generation", async () => {
  const a = deferred();
  const c = deferred();
  const h = harness({ boardReads: [() => a.promise, () => c.promise] });

  const readA = h.sync.refreshBoard({ reason: "A" });
  const queuedB = h.sync.refreshBoard({ reason: "B" });
  await settle();
  assert.equal(h.sync.status().refresh_pending, true);

  const forcedC = h.sync.refreshBoard({ reason: "C", force: true });
  assert.equal(h.sync.status().refresh_pending, false, "the queued read is out of the queue");
  assert.equal(h.sync.stats().board_reads, 2, "C started; B did not");
  assert.equal(h.sync.stats().board_abandoned, 1, "and A is no longer waited on");

  a.resolve(board([deal({ phase: "On Deck" })]));
  await settle();
  assert.equal(h.sync.stats().board_reads, 2, "B did not start behind C when A settled");
  assert.equal(h.applied.length, 0, "and A's own answer, abandoned, applied nothing");

  c.resolve(board([deal({ phase: "Legal" })]));
  const outC = await forcedC;
  assert.equal(outC.applied, true, "C applies, which is the whole point of forcing it");
  assert.equal(h.dealById("d1").phase, "Legal");

  // B's caller is answered rather than left waiting on a read that was dropped.
  const outB = await queuedB;
  assert.equal(outB.applied, true, "B was re-homed onto C rather than run late");
  assert.equal(outB.ticket.reason, "C");
  assert.equal(h.sync.stats().board_rehomed, 1);
  assert.equal((await readA).reason, "superseded");
  assert.equal(h.sync.stats().board_reads, 2, "three requests, two reads, none of them stale");
});

// Regression, root's reproduction: setOnline bumped the generation but left the
// hung feed read registered, so every later tick skipped as "busy" forever.
test("a reconnect supersedes a hung feed, and its late answer cannot move the cursor", async () => {
  const hung = deferred();
  const h = harness({
    boardReads: [() => Promise.resolve(board([deal()]))],
    changeReads: [
      () => Promise.resolve(changes([], { cursor: "c1" })),
      () => hung.promise,
      () => Promise.resolve(changes([], { cursor: "c3" })),
    ],
  });
  await h.sync.refreshBoard({ reason: "load" });
  await h.sync.pollChanges();
  assert.equal(h.sync.status().cursor, "c1");

  const stuck = h.sync.pollChanges();
  assert.equal((await h.sync.pollChanges()).reason, "busy", "an interval tick is right to skip");

  h.sync.setOnline(false);
  h.sync.setOnline(true);
  assert.equal(h.sync.stats().change_abandoned, 1, "the hung read is no longer waited on");

  const fresh = await h.sync.pollChanges();
  assert.equal(fresh.applied, true, "polling works again after a reconnect");
  assert.equal(h.sync.status().cursor, "c3");

  // The hung read answers at last, carrying a page built on the OLD cursor.
  hung.resolve(changes([changeEvent({ id: "late" })], { cursor: "c2" }));
  assert.equal((await stuck).reason, "superseded");
  assert.equal(h.sync.status().cursor, "c3", "a late answer cannot move the cursor backwards");
  assert.equal(h.sync.stats().change_superseded, 1);
});

test("a poll can be forced past a read that never answers, without waiting for an offline event", async () => {
  const hung = deferred();
  const h = harness({
    changeReads: [() => hung.promise, () => Promise.resolve(changes([], { cursor: "c9" }))],
  });
  const stuck = h.sync.pollChanges();
  assert.equal((await h.sync.pollChanges()).reason, "busy");

  const forced = await h.sync.pollChanges({ force: true });
  assert.equal(forced.applied, true);
  assert.equal(h.sync.status().cursor, "c9");
  assert.equal(h.sync.stats().change_abandoned, 1);

  hung.resolve(changes([], { cursor: "c-old" }));
  assert.equal((await stuck).reason, "superseded");
  assert.equal(h.sync.status().cursor, "c9");
});

test("going offline stops trusting what is in flight; coming back only says we are trying", async () => {
  const open = deferred();
  const openChanges = deferred();
  const h = harness({
    boardReads: [() => open.promise],
    changeReads: [() => openChanges.promise],
  });
  const read = h.sync.refreshBoard({ reason: "load" });
  const poll = h.sync.pollChanges();
  await settle();

  h.sync.setOnline(false);
  assert.equal(h.sync.status().state, SYNC_STATES.OFFLINE);

  open.resolve(board([deal({ phase: "On Deck" })]));
  openChanges.resolve(changes([], { cursor: "c9" }));
  assert.equal((await read).reason, "superseded", "an answer from before the drop is not evidence about now");
  assert.equal((await poll).reason, "superseded");
  assert.equal(h.applied.length, 0);
  assert.equal(h.sync.status().cursor, null, "and a discarded page does not move the cursor");

  h.sync.setOnline(true);
  assert.equal(h.sync.status().state, SYNC_STATES.RECONNECTING,
    "back on the network is not the same as having read anything");
  assert.equal(h.sync.status().snapshots, 0);
  assert.equal(h.sync.status().board_health, HEALTH.FAILED);
  assert.equal(h.sync.status().feed_health, HEALTH.FAILED,
    "both paths stay unproven until each one answers again");
  assert.match(h.sync.status().last_error, /no network connection/i);
});

// ------------------------------------- a confirmed local write is not undone

test("a snapshot issued before a confirmed write cannot put the old value back", async () => {
  const open = deferred();
  const next = deferred();
  const h = harness({ boardReads: [() => open.promise, () => next.promise] });

  const inFlight = h.sync.refreshBoard({ reason: "background" });
  await settle();
  // The partner changes the phase and parks the record; the server said yes to
  // both while the read above was still open.
  h.sync.noteLocalWrite("d1", { phase: "Closing" });
  h.sync.noteLocalWrite("d1", { operating_state: "parked", parking_reason: "client_paused" });
  assert.equal(h.sync.status().held_fields, 3);

  open.resolve(board([deal({ phase: "Research", operating_state: "active", next_step: "Call broker" })]));
  await inFlight;
  const shown = h.dealById("d1");
  assert.equal(shown.phase, "Closing", "the confirmed value stands");
  assert.equal(shown.operating_state, "parked");
  assert.equal(shown.parking_reason, "client_paused");
  assert.equal(shown.next_step, "Call broker", "every field the write did not touch is the board's");
  assert.deepEqual(h.last().meta.held_fields.sort(),
    ["d1|operating_state", "d1|parking_reason", "d1|phase"]);
  assert.equal(h.sync.status().held_fields, 3, "still held: that read could not have contained them");

  // The next read is issued AFTER the write was confirmed, so it is allowed to
  // disagree — including with a newer value someone else wrote.
  const later = h.sync.refreshBoard({ reason: "after-write" });
  next.resolve(board([deal({ phase: "Legal", operating_state: "parked", parking_reason: "other" })]));
  await later;
  assert.equal(h.dealById("d1").phase, "Legal", "the board is authoritative again");
  assert.equal(h.dealById("d1").parking_reason, "other");
  assert.equal(h.sync.status().held_fields, 0, "and nothing is held any more");
});

// ------------------------------------------- identity across a replacement

// Regression, independent review's blocking defect 1: an open review agenda
// captured row OBJECTS, and snapshot replacement left it rendering the values
// they had when it started — permanently, from the first refresh onward.
test("a snapshot's per-cell bases reach the app untouched, even under a held value", async () => {
  // The board read now carries `field_base` — each editable cell's latest
  // committed event — beside the values. The coordinator must pass it through: it
  // is not a value, no hold applies to it, and the app's own forward-only rule is
  // what decides whether an older one is taken. This is the pairing the write path
  // depends on: a HELD value on a row whose base is the older one the read saw.
  const open = deferred();
  const h = harness({ boardReads: [() => open.promise] });
  const base = { phase: { id: "e5", recorded_at: "2026-09-10T14:00:00.000000+00:00" } };

  const inFlight = h.sync.refreshBoard({ reason: "background" });
  await settle();
  h.sync.noteLocalWrite("d1", { phase: "Closing" });
  open.resolve(board([deal({ phase: "Research", field_base: base })]));
  await inFlight;

  const shown = h.dealById("d1");
  assert.equal(shown.phase, "Closing", "the confirmed value still stands over the older read");
  assert.deepEqual(shown.field_base, base, "and the read's bases arrive exactly as the server sent them");
  assert.deepEqual(h.last().meta.held_fields, ["d1|phase"],
    "the hold is on the value; the base is not a value and is not held");
});

test("a row captured before a snapshot resolves to current values by id, in the captured order", async () => {
  const h = harness({
    boardReads: [
      () => Promise.resolve(board([
        deal({ id: "d1", phase: "Research", next_step: "Call broker" }),
        deal({ id: "d2", name: "Demo Veterinary", phase: "Legal" }),
        deal({ id: "d3", name: "Left The Board" }),
      ])),
      () => Promise.resolve(board([
        deal({ id: "d2", name: "Demo Veterinary", phase: "Closing" }),
        deal({ id: "d1", phase: "Negotiation", next_step: "Send LOI" }),
      ])),
    ],
  });
  await h.sync.refreshBoard({ reason: "load" });
  // What an agenda captures when it starts: the row objects, in the order it
  // chose — which is not the board's order and must not become it.
  const captured = [h.dealById("d1"), h.dealById("d3"), h.dealById("d2")];

  await h.sync.refreshBoard({ reason: "periodic" });
  assert.equal(captured[0].phase, "Research",
    "the defect itself, executed: a captured copy never changes again");
  assert.equal(h.dealById("d1").phase, "Negotiation", "while the board moved on");

  const rows = new Map(h.deals().map((row) => [row.id, row]));
  const resolved = captured.map((row) => resolveCurrentRow(row, rows));
  assert.deepEqual(resolved.map((row) => row.id), ["d1", "d3", "d2"],
    "the captured set and order are preserved: nothing joins or leaves mid-review");
  assert.equal(resolved[0].phase, "Negotiation", "and each row reads what the board says now");
  assert.equal(resolved[0].next_step, "Send LOI");
  assert.equal(resolved[2].phase, "Closing");
  assert.equal(resolved[1], captured[1],
    "a record the board no longer holds stays as last seen — not dropped, not invented");

  // Shapes that must not throw in the middle of a review.
  assert.equal(resolveCurrentRow(null, rows), null);
  assert.equal(resolveCurrentRow(undefined, rows), null);
  assert.equal(resolveCurrentRow({ name: "no id" }, rows).name, "no id");
  assert.equal(resolveCurrentRow(captured[0], null), captured[0]);
  assert.equal(resolveCurrentRow(captured[0], h.deals()).phase, "Negotiation",
    "a plain list resolves the same way a Map does");
});

// Regression, independent review's residual 6: a request landing in the one
// microtask between a read clearing and its follow-up starting used to see no
// open read, start its own, and then be superseded by the follow-up.
test("a request that lands between a read settling and its follow-up starting does not double-read", async () => {
  const first = deferred();
  const h = harness({
    boardReads: [() => first.promise, () => Promise.resolve(board([deal({ phase: "Legal" })]))],
  });

  const readA = h.sync.refreshBoard({ reason: "A" });
  // Registered BEFORE the queued entry's own callback, so it runs in exactly
  // that window: boardRun already cleared, the follow-up not yet started.
  let inGap = null;
  readA.then(() => { inGap = h.sync.refreshBoard({ reason: "gap" }); });
  const queuedB = h.sync.refreshBoard({ reason: "B" });

  first.resolve(board([deal({ phase: "Research" })]));
  await settle();
  assert.equal(h.sync.stats().board_reads, 2, "one follow-up, not two concurrent reads");
  assert.equal(h.sync.stats().board_superseded, 0, "so nothing had to be thrown away");
  const outcome = await inGap;
  assert.equal(outcome.applied, true, "the request in the gap is answered by the follow-up");
  assert.equal(outcome.ticket.reason, "B");
  assert.equal((await queuedB).ticket.reason, "B");
  assert.equal(h.dealById("d1").phase, "Legal");
});

test("a hold survives a failed read, and is not resurrected onto a record the board dropped", async () => {
  const h = harness({
    boardReads: [
      () => Promise.reject(new Error("gone")),
      () => Promise.resolve(board([deal({ id: "d2", name: "Demo Veterinary" })])),
    ],
  });
  h.sync.noteLocalWrite("d1", { attention: true });
  await h.sync.refreshBoard({ reason: "load" });
  assert.equal(h.sync.status().held_fields, 1, "a read that failed released nothing");

  await h.sync.refreshBoard({ reason: "retry" });
  assert.deepEqual(h.deals().map((row) => row.id), ["d2"],
    "the board decides which records exist; a hold does not re-create one");
  assert.equal(h.sync.status().held_fields, 0);
});

test("a render fault is not a read fault, and a board that could not be shown is never ready", async () => {
  const applied = [];
  let explode = true;
  const sync = createBoardSync({
    readBoard: async () => board([deal()]),
    readChanges: async () => changes(),
    applyBoard: (payload) => {
      if (explode) throw new Error("render blew up");
      applied.push(payload);
    },
  });
  sync.noteLocalWrite("d1", { attention: true });
  const outcome = await sync.refreshBoard({ reason: "load" });
  assert.equal(outcome.reason, "apply_failed");
  assert.equal(sync.status().snapshots, 0, "an unrendered snapshot is not a snapshot");
  assert.equal(sync.status().last_read_at, null);
  assert.equal(sync.status().held_fields, 1);
  // The screen is now older than an answer we already threw away. Saying
  // "ready" would be a claim about the page that the page cannot support.
  assert.equal(sync.status().board_health, HEALTH.RENDER_FAILED);
  assert.equal(sync.status().state, SYNC_STATES.ERROR);
  assert.match(sync.status().last_error, /render blew up/);

  // A working feed does not repair it either: the feed did not fail.
  await sync.pollChanges();
  assert.equal(sync.status().feed_health, HEALTH.OK);
  assert.equal(sync.status().state, SYNC_STATES.ERROR, "still not ready, and still not a connection problem");

  explode = false;
  await sync.refreshBoard({ reason: "retry" });
  assert.equal(applied.length, 1);
  assert.equal(sync.status().snapshots, 1);
  assert.equal(sync.status().state, SYNC_STATES.READY, "a snapshot that reached the page clears it");
  assert.equal(sync.status().last_error, null);
});

// -------------------------------------------------------- serialized polling

test("a poll tick during an open poll is dropped, and a slow page cannot land after a newer one", async () => {
  const first = deferred();
  const h = harness({
    changeReads: [
      () => first.promise,
      () => Promise.resolve(changes([changeEvent({ id: "e2" })], { cursor: "c2" })),
    ],
  });

  const slow = h.sync.pollChanges();
  const tick = await h.sync.pollChanges();
  assert.equal(tick.applied, false);
  assert.equal(tick.reason, "busy");
  assert.equal(h.sync.stats().change_reads, 1, "the interval's second tick issued no request");
  assert.equal(h.sync.stats().change_skipped, 1);

  first.resolve(changes([changeEvent({ id: "e1" })], { cursor: "c1" }));
  assert.equal((await slow).applied, true);
  assert.equal(h.sync.status().cursor, "c1");

  const second = await h.sync.pollChanges();
  assert.equal(second.applied, true);
  assert.equal(h.sync.status().cursor, "c2", "the cursor only ever moves forward, one applied page at a time");
});

test("a failed poll is visible and does not move the cursor", async () => {
  const h = harness({
    changeReads: [
      () => Promise.resolve(changes([], { cursor: "c1" })),
      () => Promise.reject(new Error("changes -> 500")),
      () => Promise.resolve(changes([], { cursor: "c2" })),
    ],
    boardReads: [() => Promise.resolve(board([deal()]))],
  });
  await h.sync.refreshBoard({ reason: "load" });
  await h.sync.pollChanges();
  assert.equal(h.sync.status().state, SYNC_STATES.READY);

  const failed = await h.sync.pollChanges();
  assert.equal(failed.ok, false);
  assert.equal(h.sync.status().state, SYNC_STATES.RECONNECTING);
  assert.equal(h.sync.status().cursor, "c1");
  assert.match(h.sync.status().last_error, /500/);

  await h.sync.pollChanges();
  assert.equal(h.sync.status().state, SYNC_STATES.READY);
  assert.equal(h.sync.status().cursor, "c2");
});

// ------------------------------------------------------------- an empty board

test("an empty board still carries presence and capture, and the first record arrives by board read", async () => {
  const h = harness({
    boardReads: [
      () => Promise.resolve(board([])),
      () => Promise.resolve(board([deal({ id: "d9", name: "New Practice" })])),
    ],
    changeReads: [
      () => Promise.resolve(changes([], {
        presence: [{ deal_id: "d9", actor: "dell", field: "next_step", expires_at: "2099-01-01T00:00:00Z" }],
        capture_sessions: [{ id: "cap-1", state: "transcribing" }],
        cursor: "c1",
      })),
    ],
  });

  await h.sync.refreshBoard({ reason: "load" });
  assert.deepEqual(h.deals(), [], "an empty board is a real answer, not a failure");
  assert.equal(h.sync.status().snapshots, 1);

  const poll = await h.sync.pollChanges();
  assert.equal(poll.applied, true, "polling is not skipped because the board is empty");
  assert.equal(poll.changes.presence.length, 1, "presence still arrives");
  assert.equal(poll.changes.capture_sessions[0].state, "transcribing");

  // A record this session has never seen is exactly what a new deal looks like
  // to an empty board, so it is a reason to read the board again.
  assert.equal(batchTouchesBoard([changeEvent({ subject_id: "d9" })]), true);
  await h.sync.requestRefresh("change-feed");
  assert.deepEqual(h.deals().map((row) => row.name), ["New Practice"]);
});

test("what counts as board news", () => {
  assert.equal(batchTouchesBoard([]), false);
  assert.equal(batchTouchesBoard(null), false);
  assert.equal(batchTouchesBoard([null, "nonsense", {}]), false);
  assert.equal(batchTouchesBoard([{ subject_type: "client", subject_id: "c1" }]), false,
    "another subject's event is not this board's business");
  assert.equal(batchTouchesBoard([changeEvent({ field: null, verb: "start-deal-review" })]), true,
    "a deal event with no field can still change what the board shows");
  assert.equal(batchTouchesBoard([{ subject_id: "d1" }]), true, "subject_type may be absent");
  assert.equal(batchTouchesBoard([{ subject_type: "client", subject_id: "c1" }, changeEvent()]), true);
});

// ------------------------------------------------------------ the pure pieces

test("merging holds copies rather than mutates, and only holds newer than the read win", () => {
  const holds = createHolds();
  holds.note("d1", { phase: "Closing" }, 5);
  holds.note("d1", { owner: "dell" }, 2);
  holds.note("d2", { attention: true }, 9);
  assert.equal(holds.size, 3);

  const source = board([deal({ phase: "Research", owner: "joe" }), deal({ id: "d2", attention: false })]);
  const frozen = JSON.stringify(source);
  const merged = mergeBoardSnapshot(source, holds, 3);
  assert.equal(JSON.stringify(source), frozen, "the snapshot handed in is never edited");
  assert.equal(merged.deals[0].phase, "Closing", "confirmed after the read was issued: held");
  assert.equal(merged.deals[0].owner, "joe", "confirmed before it was issued: the board's value");
  assert.equal(merged.deals[1].attention, true);
  assert.deepEqual(merged.held_fields.sort(), ["d1|phase", "d2|attention"]);
  assert.equal(merged.actor, "joe", "everything else on the board passes through");

  holds.release(5);
  assert.deepEqual(holds.list().map((h) => `${h.deal_id}|${h.field}`), ["d2|attention"]);
  holds.release(9);
  assert.equal(holds.size, 0);
  assert.equal(holds.get("d1"), null);

  // Degenerate shapes stay degenerate rather than inventing rows.
  assert.deepEqual(mergeBoardSnapshot({}, holds, 1).deals, []);
  assert.deepEqual(mergeBoardSnapshot(null, null, 1).deals, []);
  holds.note("d1", null, 1);
  holds.note(null, { phase: "x" }, 1);
  assert.equal(holds.size, 0);
});

test("the coordinator refuses to exist without the reads it coordinates", () => {
  assert.throws(() => createBoardSync(), /readBoard/);
  assert.throws(() => createBoardSync({ readBoard: () => {} }), /readChanges/);
  assert.throws(() => createBoardSync({ readBoard: () => {}, readChanges: () => {} }), /applyBoard/);
});

test("the coordinator holds no transport, storage, DOM or timer of its own", async () => {

  // The boundary itself: drive the whole surface with every network entry point
  // replaced by a tripwire.
  const tripped = [];
  const originals = new Map();
  for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"]) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    try {
      Object.defineProperty(globalThis, name, {
        configurable: true, writable: true,
        value: function tripwire() { tripped.push(name); throw new Error(`the coordinator reached ${name}`); },
      });
    } catch { originals.delete(name); }
  }
  try {
    const h = harness({
      boardReads: [() => Promise.resolve(board([deal()]))],
      changeReads: [() => Promise.resolve(changes([changeEvent()]))],
    });
    h.sync.noteLocalWrite("d1", { attention: true });
    await h.sync.refreshBoard({ reason: "load" });
    await h.sync.pollChanges();
    h.sync.invalidate();
    h.sync.setOnline(false);
    h.sync.setOnline(true);
    h.sync.status();
    h.sync.holds();
    h.sync.stats();
    assert.deepEqual(tripped, [], "the coordinator made no network call of its own");
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

// ----------------------------------------------------------------- app wiring

// Placement only. What these writes DO under a lost answer, a double click, a
// refusal and a partner conflict is executed in field-write-reconciliation.test.mjs
// (the model) and dealroom.test.js (the model against the real verb).

// Placement for the two review corrections. The behaviour — an answer that
// arrives after the feed moved, for an ordinary cell and for operating state —
// is executed in field-write-reconciliation.test.mjs and, against the real verb,
// in dealroom.test.js.

// --------------------------------------------------- one realistic sequence

test("a long history drains without touching values, and one burst of news costs one board read", async () => {
  // 450 events, 200 to a page: the shape deal-change-receipts.test.mjs drains.
  const page = (n, size, cursor) => changes(
    Array.from({ length: size }, (_, i) => changeEvent({
      id: `ev${n}-${i}`, recorded_at: "2025-02-01T00:00:00.000000+00:00",
      field: "phase", old_value: "On Deck", new_value: "On Deck",
    })),
    { cursor },
  );
  const h = harness({
    boardReads: [
      () => Promise.resolve(board([deal({ phase: "Closing" })])),
      () => Promise.resolve(board([deal({ phase: "Legal" })])),
    ],
    changeReads: [
      () => Promise.resolve(page(1, 200, "c200")),
      () => Promise.resolve(page(2, 200, "c400")),
      () => Promise.resolve(page(3, 50, "c450")),
      () => Promise.resolve(changes([
        changeEvent({ id: "news-1", new_value: "Legal" }),
        changeEvent({ id: "news-2", field: "owner", new_value: "dell" }),
      ], { cursor: "c452" })),
    ],
  });

  await h.sync.refreshBoard({ reason: "load" });
  for (let i = 0; i < 3; i += 1) await h.sync.pollChanges();
  assert.equal(h.sync.stats().board_reads, 1, "draining history reads the board no further times");
  assert.equal(h.dealById("d1").phase, "Closing", "and 450 old events changed nothing on it");
  assert.equal(h.sync.status().cursor, "c450");

  // app.js gates this call on the feed being caught up; here the news page is
  // the caller's own decision, exercised as app.js makes it.
  const news = await h.sync.pollChanges();
  assert.equal(batchTouchesBoard(news.changes.events), true);
  await h.sync.requestRefresh("change-feed");
  assert.equal(h.sync.stats().board_reads, 2, "two events, one read");
  assert.equal(h.dealById("d1").phase, "Legal");
  assert.equal(h.sync.status().state, SYNC_STATES.READY);
});

test('a board refresh waits for asynchronous snapshot reconciliation before completing', async () => {
  const reconciled = deferred();
  let finished = false;
  const sync = createBoardSync({
    readBoard: async () => board([deal()]),
    readChanges: async () => changes(),
    applyBoard: () => reconciled.promise,
  });
  const refresh = sync.refreshBoard().then(result => { finished = true; return result; });
  await settle();
  assert.equal(finished, false, 'dependent detail and evidence reads remain inside the refresh lifetime');
  reconciled.resolve();
  assert.equal((await refresh).applied, true);
});

test('an asynchronous snapshot reconciliation cannot restore health after going offline', async () => {
  const reconciled = deferred();
  const sync = createBoardSync({
    readBoard: async () => board([deal()]),
    readChanges: async () => changes(),
    applyBoard: () => reconciled.promise,
  });
  const refresh = sync.refreshBoard();
  await settle();
  sync.setOnline(false);
  reconciled.resolve();
  assert.equal((await refresh).applied, false);
  assert.equal(sync.status().board_health, HEALTH.FAILED);
});
