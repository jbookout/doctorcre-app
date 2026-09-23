// V5-UX-B11 — shared, non-recording Meeting Mode. The clauses are the
// business handoff's acceptance ids (a984038c v1):
//
//   UX05  double click, two-client acceptance, reconnect and rejoin yield ONE
//         logical action; a disconnect after dispatch reconciles before any retry
//   UX13  one shared processing owner and action stream; repeated contributions
//         and acceptances dedupe; tentative stays proposed; revisions keep history
//   UX14  J201 captures no audio; D03 needs real recording evidence, not a
//         legacy recorder's presence
//
// The producer is CARR 35009e9d (meeting-mode.js + migration 0556). The
// fixture store mirrors its decisions, so each clause runs the page's own
// builders and kernel against a store that refuses and dedupes as CARR does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createCommandState, performCommand } from "../js/command-feedback.mjs";
import { createFixtureClient } from "../js/fixture-client.js";
import { createLiveClient } from "../js/live-client.js";
import { createMeetingStore } from "../js/meeting-fixture.js";
import { createMeetingMemory } from "../js/meeting-memory.mjs";
import { APP_ROUTE_PATHS } from "../js/notifications-model.js";
import {
  ACTIVATION_INTENT, D03_DEFERRED, DETECTION_UNAVAILABLE, DISPATCHABLE_VERBS, MEETING_VERBS, NO_RECORDING,
  RECORDING_FRAGMENTS, actionRows, actionTag, claimArgs, decideArgs, decideOperationKey, dispatchOperationKey,
  finishAcceptedAction, followUpCommand, joinArgs, joinedHere, meetingRoute, meetingState, mergeStream,
  noteArgs, noteOperationKey, noteRows, outcomeArgs, processingOwner, proposeArgs, proposeOperationKey,
  recapView, reconcileOperationKey, recordingFieldPaths, startArgs, streamCursor, validMeetingPayload,
} from "../js/meeting-model.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const html = await read("meeting.html");
const css = await read("css/meeting.css");
const pageJs = await read("js/meeting.js");
const routes = JSON.parse(await read("contracts/app-routes.v1.json"));
const contract = JSON.parse(await read("contracts/carr-interface.v1.json"));
const seed = await read("data/board-seed.json");

const uuid = () => crypto.randomUUID();
const fixture = (options = {}) => createFixtureClient({
  seedUrl: `data:application/json;base64,${Buffer.from(seed).toString("base64")}`, ...options,
});

/** One device: a partner, a client_instance, a fixture client and its own kernel. */
async function device(store, actor, instance) {
  const client = await fixture({ selfActor: actor, meetingStore: store });
  let state = createCommandState();
  const send = (operationKey, args, call, newKey = uuid) => performCommand({
    operationKey, args, getState: () => state, setState: (next) => { state = next; }, newKey, call,
  });
  return { client, actor, instance, send, get state() { return state; }, set state(next) { state = next; } };
}

/** Joe starts on laptop A; Dell opens the link on laptop B and joins. */
async function sharedMeeting({ now } = {}) {
  let t = Date.parse("2026-09-23T15:00:00.000Z");
  const store = createMeetingStore({ now: now || (() => t) });
  const a = await device(store, "joe", "app-laptop-a");
  const b = await device(store, "dell", "app-laptop-b");
  const started = await a.send("meeting:start:x", startArgs({ title: "Demo renewal review", instance: a.instance, newId: uuid }).args,
    (request) => a.client.startMeeting(request));
  assert.equal(started.status, "ok");
  const id = started.response.meeting_id;
  const seen = await b.client.readMeeting({ meeting_id: id });
  const joined = await b.send(`meeting:join:${id}`, joinArgs(seen, b.instance).args, (request) => b.client.startMeeting(request));
  assert.equal(joined.status, "ok");
  return { store, a, b, id, advance: (ms) => { t += ms; }, readA: () => a.client.readMeeting({ meeting_id: id }), readB: () => b.client.readMeeting({ meeting_id: id }) };
}

const lostAnswer = (call) => async (request) => {
  await call(request);
  throw new Error("the connection dropped before the answer arrived");
};

/* ---------------------------------------------------------------------- UX13 */

test("UX13: a second device joins the SAME meeting by its native identity and starts no second worker", async () => {
  const { store, a, b, id, readA, readB } = await sharedMeeting();
  assert.equal(store.meetings.size, 1, "a join minted a second meeting");
  const payload = await readB();
  assert.equal(payload.meeting.id, id);
  assert.deepEqual(payload.stream.map((s) => [s.kind, s.client_instance]),
    [["meeting_started", "app-laptop-a"], ["meeting_joined", "app-laptop-b"]]);
  assert.equal(joinedHere(payload.stream, b.instance), true);

  // One processing owner: A takes it, B is told who holds it and stays a participant.
  const claimA = await a.send(`meeting:processing:${id}`, claimArgs(id, a.instance).args, (r) => a.client.claimMeetingProcessing(r));
  const claimB = await b.send(`meeting:processing:${id}`, claimArgs(id, b.instance).args, (r) => b.client.claimMeetingProcessing(r));
  assert.equal(claimA.response.decision, "acquired");
  assert.equal(claimB.response.decision, "held_by_other");
  assert.equal(claimB.response.is_holder, false);
  const after = await readA();
  assert.equal(processingOwner(after, a.instance).state, "held_here");
  assert.equal(processingOwner(after, b.instance).state, "held_by_other");
  assert.match(processingOwner(after, b.instance).sentence, /joe on app-laptop-a.*starts no second worker/);
  assert.equal(after.stream.filter((s) => s.kind.startsWith("processing_")).length, 1, "the refused claim appended history");
});

test("UX13: a lapsed lease is taken over under a new epoch, and the old holder's processing contribution is fenced", async () => {
  const { a, b, id, advance, readB } = await sharedMeeting();
  await a.send(`meeting:processing:${id}`, claimArgs(id, a.instance).args, (r) => a.client.claimMeetingProcessing(r));
  advance(121_000);
  assert.equal(processingOwner(await readB(), b.instance).state, "expired");
  const takeover = await b.send(`meeting:processing:${id}`, claimArgs(id, b.instance).args, (r) => b.client.claimMeetingProcessing(r));
  assert.equal(takeover.response.decision, "taken_over_after_expiry");
  assert.equal(takeover.response.lease.lease_epoch, 2);
  const stale = await a.send("meeting:proc-propose", {
    meeting_id: id, summary: "old worker's suggestion", basis: "tentative_discussion",
    client_instance: a.instance, processing_epoch: 1,
  }, (r) => a.client.proposeMeetingAction(r));
  assert.equal(stale.status, "refused");
  assert.equal(stale.code, "stale_processing_lease");
});

test("UX13: tentative discussion stays proposed — with or without a command — and is never drawn as done", async () => {
  const { a, b, id, readA } = await sharedMeeting();
  const payload = await readA();
  const withCommand = proposeArgs(payload, { summary: "Maybe send comps", basis: "tentative_discussion", instance: a.instance,
    command: followUpCommand({ title: "Send comps to broker", owner: "dell" }) });
  const bare = proposeArgs(payload, { summary: "We might revisit parking", basis: "tentative_discussion", instance: b.instance });
  const one = await a.send(proposeOperationKey(id, "d1"), withCommand.args, (r) => a.client.proposeMeetingAction(r));
  const two = await b.send(proposeOperationKey(id, "d2"), bare.args, (r) => b.client.proposeMeetingAction(r));
  assert.equal(one.response.action.state, "proposed");
  assert.equal(one.response.accepted_as_explicit_instruction, false);
  assert.equal(one.response.action.dispatch, null, "a proposal carries no operation key");
  assert.equal(two.response.action.state, "proposed");

  const rows = actionRows(await readA());
  assert.deepEqual(rows.map((r) => [r.number, r.tag]), [[1, "needs_approval"], [2, "tentative"]]);
  assert.ok(rows.every((r) => !/Done|confirmed in the record/.test(r.stateWord)));
  assert.equal(rows[0].controls.confirm, true);
  assert.equal(rows[1].controls.confirm, false, "Confirm is offered on an item with nothing to run");
  assert.equal(rows[1].controls.skip, true);
  const recap = recapView(await readA());
  assert.deepEqual(recap.buckets.map((bucket) => [bucket.key, bucket.count]),
    [["done", 0], ["delegated", 0], ["needs_approval", 1], ["unresolved", 1], ["closed_without_action", 0]]);

  // Accepting a command-less item is refused by the store, whatever the page shows.
  const forced = await a.send(decideOperationKey(id, 2), decideArgs(await readA(), 2, "accept", a.instance).args, (r) => a.client.decideMeetingAction(r));
  assert.equal(forced.code, "meeting_action_has_no_canonical_command");
});

test("UX13: note and action revisions append; history is kept and a stale base is a conflict, not an overwrite", async () => {
  const { a, b, id, readA, readB } = await sharedMeeting();
  await a.send(noteOperationKey(id, "n1"), noteArgs(await readA(), { body: "Landlord open to 3%", instance: a.instance }).args, (r) => a.client.addMeetingNote(r));
  const onB = await readB();
  const revised = await b.send("meeting:note-revision:1", noteArgs(onB, { body: "Landlord open to 3%, not 4%", instance: b.instance, revises: 1 }).args, (r) => b.client.addMeetingNote(r));
  assert.equal(revised.response.revision, 2);
  // A still holds revision 1 on screen: its revision is refused, not merged.
  const stale = { ...onB, notes: onB.notes };
  const late = await a.send("meeting:note-revision:1:a", noteArgs(stale, { body: "Landlord at 3.5%", instance: a.instance, revises: 1 }).args, (r) => a.client.addMeetingNote(r));
  assert.equal(late.status, "refused");
  assert.equal(late.code, "meeting_note_revision_conflict");
  const [note] = noteRows(await readA());
  assert.equal(note.revision, 2);
  assert.equal(note.current.author, "dell");
  assert.deepEqual(note.history.map((h) => [h.revision, h.author, h.body]), [[1, "joe", "Landlord open to 3%"]]);

  await a.send(proposeOperationKey(id, "p1"), proposeArgs(await readA(), { summary: "Ask for comps", basis: "tentative_discussion", instance: a.instance }).args, (r) => a.client.proposeMeetingAction(r));
  await b.send("meeting:propose-revision", proposeArgs(await readB(), { summary: "Ask the broker for three comps", basis: "tentative_discussion", instance: b.instance, revises: 1 }).args, (r) => b.client.proposeMeetingAction(r));
  const [action] = actionRows(await readA());
  assert.equal(action.revision, 2);
  assert.equal(action.summary, "Ask the broker for three comps");
  assert.deepEqual(action.history.map((h) => [h.revision, h.by, h.summary]), [[1, "joe", "Ask for comps"]]);
});

/* ---------------------------------------------------------------------- UX05 */

test("UX05: a double click is one request, and a lost answer re-sent under the SAME key is one note", async () => {
  const { a, id, readA } = await sharedMeeting();
  const args = noteArgs(await readA(), { body: "Tour Thursday", instance: a.instance }).args;
  const op = noteOperationKey(id, "draft-1");
  const [first, second] = await Promise.all([
    a.send(op, args, (r) => a.client.addMeetingNote(r)),
    a.send(op, args, (r) => a.client.addMeetingNote(r)),
  ]);
  assert.deepEqual([first.status, second.status].sort(), ["in_flight", "ok"]);

  const lostOp = noteOperationKey(id, "draft-2");
  const body = noteArgs(await readA(), { body: "Send LOI draft", instance: a.instance }).args;
  const lost = await a.send(lostOp, body, lostAnswer((r) => a.client.addMeetingNote(r)));
  assert.equal(lost.status, "unknown");
  const retried = await a.send(lostOp, body, (r) => a.client.addMeetingNote(r));
  assert.equal(retried.status, "ok");
  assert.equal(retried.retry, true);
  assert.equal(retried.request.idempotency_key, lost.request.idempotency_key, "a retry minted a second key");
  assert.equal(retried.response.replayed, true);
  assert.deepEqual(noteRows(await readA()).map((n) => n.current.body), ["Tour Thursday", "Send LOI draft"]);
});

test("UX05: a reload keeps the words and the unanswered request, and Check outcome replays it under the same key", async () => {
  const { a, id, readA } = await sharedMeeting();
  const storage = new Map();
  const shim = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
  const before = createMeetingMemory({ storage: shim, scope: id, newId: uuid });
  before.setDraft({ note: "Parking ratio is 4/1000" });
  const op = noteOperationKey(id, before.drafts().noteId);
  const args = noteArgs(await readA(), { body: before.drafts().note, instance: a.instance }).args;
  let state = createCommandState();
  const lost = await performCommand({ operationKey: op, args, getState: () => state, setState: (next) => { state = next; before.setCommands(next); }, newKey: uuid,
    call: lostAnswer((r) => a.client.addMeetingNote(r)) });
  assert.equal(lost.status, "unknown");

  // The page dies and loads again.
  const after = createMeetingMemory({ storage: shim, scope: id, newId: uuid });
  assert.equal(after.drafts().note, "Parking ratio is 4/1000");
  assert.equal(after.drafts().noteId, before.drafts().noteId);
  const restored = after.commands()[op];
  assert.equal(restored.status, "unknown");
  assert.equal(restored.request.idempotency_key, lost.request.idempotency_key);
  let reloaded = after.commands();
  const check = await performCommand({ operationKey: op, args, getState: () => reloaded, setState: (next) => { reloaded = next; after.setCommands(next); }, newKey: uuid,
    call: (r) => a.client.addMeetingNote(r) });
  assert.equal(check.status, "ok");
  assert.equal(check.response.replayed, true);
  assert.equal(noteRows(await readA()).length, 1, "the reload wrote the note twice");
  after.clearDraft("note");
  assert.equal(shim.getItem(`doctorcre:meeting:v1:${id}`), null, "a settled meeting leaves nothing on the device");
});

test("UX05: two partners confirming at once resolve to ONE acceptance and ONE operation key", async () => {
  const { a, b, id, readA, readB } = await sharedMeeting();
  await a.send(proposeOperationKey(id, "p"), proposeArgs(await readA(), { summary: "Dell sends comps", basis: "tentative_discussion", instance: a.instance,
    command: followUpCommand({ title: "Send comps", owner: "dell" }) }).args, (r) => a.client.proposeMeetingAction(r));
  const [onA, onB] = [await readA(), await readB()];
  const [ja, db] = await Promise.all([
    a.send(decideOperationKey(id, 1), decideArgs(onA, 1, "accept", a.instance).args, (r) => a.client.decideMeetingAction(r)),
    b.send(decideOperationKey(id, 1), decideArgs(onB, 1, "accept", b.instance).args, (r) => b.client.decideMeetingAction(r)),
  ]);
  assert.equal(ja.status, "ok");
  assert.equal(db.status, "ok");
  assert.equal(ja.response.action.dispatch.idempotency_key, db.response.action.dispatch.idempotency_key);
  assert.equal(ja.response.effect_executed, false, "accepting reported an effect");
  const accepts = (await readA()).stream.filter((s) => s.kind === "action_accepted");
  assert.equal(accepts.length, 1, "a second acceptance appended");
  const [row] = actionRows(await readA());
  assert.equal(row.tag, "accepted");
  assert.equal(row.stateWord, "Accepted — record effect not yet confirmed");
});

test("UX05: a disconnect after dispatch reconciles BEFORE any retry — one canonical write, then done", async () => {
  const { a, b, id, readA } = await sharedMeeting();
  let loopsWritten = 0;
  const addLoop = a.client.addLoop;
  a.client.addLoop = async (args) => { loopsWritten += 1; return addLoop(args); };
  const instruct = await a.send(proposeOperationKey(id, "i"), proposeArgs(await readA(), { summary: "Joe: open a task for Dell to send comps", basis: "explicit_instruction", instance: a.instance,
    command: followUpCommand({ title: "Send comps to broker", owner: "dell" }) }).args, (r) => a.client.proposeMeetingAction(r));
  assert.equal(instruct.response.accepted_as_explicit_instruction, true);
  const storeKey = instruct.response.action.dispatch.idempotency_key;

  const sentKeys = [];
  const steps = (dev, { lose }) => ({
    reconcile: () => dev.send(reconcileOperationKey(id, 1), outcomeArgs(id, 1, dev.instance).args, (r) => dev.client.recordMeetingActionOutcome(r)),
    dispatch: (retry) => dev.send(dispatchOperationKey(id, 1), { verb: retry.verb, args: retry.args }, (r) => {
      sentKeys.push(r.idempotency_key);
      return lose ? lostAnswer((q) => dev.client.dispatchMeetingCommand(q))(r) : dev.client.dispatchMeetingCommand(r);
    }, () => retry.idempotency_key),
  });

  const first = await finishAcceptedAction(steps(a, { lose: true }));
  assert.equal(first.stage, "dispatch_unknown");
  assert.equal(loopsWritten, 1);
  assert.equal(actionRows(await readA())[0].tag, "accepted", "an unanswered dispatch was drawn as done");

  // The second device finishes it: the reconcile finds the committed write and
  // nothing is sent again.
  const second = await finishAcceptedAction(steps(b, { lose: false }));
  assert.equal(second.stage, "reconciled");
  assert.equal(second.outcome, "executed");
  assert.equal(loopsWritten, 1, "the retry wrote the canonical change twice");
  assert.deepEqual(sentKeys, [storeKey], "a dispatch used a key the store did not mint");
  const [row] = actionRows(await readA());
  assert.equal(row.tag, "executed");
  assert.equal(row.outcome.evidence, "public.tool_call");
  const recap = recapView(await readA());
  assert.equal(recap.buckets.find((bucket) => bucket.key === "done").count, 1);
});

test("UX05: when the dispatch never happened, reconcile says not_observed and the one send reuses the store's key", async () => {
  const { a, b, id, readA } = await sharedMeeting();
  await a.send(proposeOperationKey(id, "p"), proposeArgs(await readA(), { summary: "Delegate the site visit", basis: "tentative_discussion", instance: a.instance,
    command: followUpCommand({ title: "Visit the site", owner: "dell" }) }).args, (r) => a.client.proposeMeetingAction(r));
  const decided = await a.send(decideOperationKey(id, 1), decideArgs(await readA(), 1, "accept", a.instance, { assignee: "dell" }).args, (r) => a.client.decideMeetingAction(r));
  assert.equal(decided.response.action.disposition, "delegate");
  const sent = [];
  const finish = await finishAcceptedAction({
    reconcile: () => b.send(reconcileOperationKey(id, 1), outcomeArgs(id, 1, b.instance).args, (r) => b.client.recordMeetingActionOutcome(r)),
    dispatch: (retry) => b.send(dispatchOperationKey(id, 1), { verb: retry.verb, args: retry.args }, (r) => { sent.push(r); return b.client.dispatchMeetingCommand(r); }, () => retry.idempotency_key),
  });
  assert.equal(finish.stage, "reconciled");
  assert.equal(finish.outcome, "delegated");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].idempotency_key, decided.response.action.dispatch.idempotency_key);
  assert.equal(recapView(await readA()).buckets.find((bucket) => bucket.key === "delegated").items[0].assignee, "dell");
});

test("UX05: reconnect resumes the stream after the last seq held, and a rejoin adds no meeting and no action", async () => {
  const { store, a, b, id, readA } = await sharedMeeting();
  const held = (await readA()).stream;
  const cursor = streamCursor(held);
  await a.send(noteOperationKey(id, "n"), noteArgs(await readA(), { body: "Reconnect test", instance: a.instance }).args, (r) => a.client.addMeetingNote(r));
  const page = await a.client.readMeeting({ meeting_id: id, after_seq: cursor });
  assert.deepEqual(page.stream.map((s) => s.seq), [cursor + 1], "after_seq is exclusive");
  const merged = mergeStream(mergeStream(held, page.stream), page.stream);
  assert.deepEqual(merged.map((s) => s.seq), [1, 2, 3], "an overlapping page drew an entry twice");

  // Laptop B drops and rejoins with a fresh one-tap.
  const rejoin = await b.send(`meeting:join:${id}:again`, joinArgs(await readA(), b.instance).args, (r) => b.client.startMeeting(r));
  assert.equal(rejoin.response.meeting_id, id);
  assert.equal(rejoin.response.joined_existing, true);
  assert.equal(store.meetings.size, 1);
  assert.equal((await readA()).actions.length, 0);
});

/* ---------------------------------------------------------------------- UX14 */

test("UX14: nothing the page sends names audio, and the store refuses a field that does", async () => {
  const { a, id, readA } = await sharedMeeting();
  const payload = await readA();
  const built = [
    startArgs({ title: "t", instance: a.instance, newId: uuid }), joinArgs(payload, a.instance), claimArgs(id, a.instance),
    noteArgs(payload, { body: "b", instance: a.instance }),
    proposeArgs(payload, { summary: "s", basis: "explicit_instruction", instance: a.instance, command: followUpCommand({ title: "x", owner: "joe" }) }),
    outcomeArgs(id, 1, a.instance),
  ];
  for (const one of built) {
    assert.equal(one.ok, true);
    assert.deepEqual(recordingFieldPaths(one.args), []);
  }
  assert.deepEqual(recordingFieldPaths({ command: { args: { deep: [{ AudioUrl: "x" }] } } }), ["args.command.args.deep[0].AudioUrl"]);
  const smuggled = await a.send("meeting:note:smuggled", { meeting_id: id, body: "b", client_instance: a.instance, transcript_ref: "x" }, (r) => a.client.addMeetingNote(r));
  assert.equal(smuggled.status, "refused");
  assert.equal(smuggled.code, "recording_field_refused");
  assert.equal(startArgs({ title: "t", instance: a.instance, newId: uuid }).args.activation_intent, ACTIVATION_INTENT);
  const silent = await a.send("meeting:start:silent", { ...startArgs({ title: "t", instance: a.instance, newId: uuid }).args, activation_intent: "automatic_on_detection" }, (r) => a.client.startMeeting(r));
  assert.equal(silent.code, "silent_activation_refused");
  assert.deepEqual(RECORDING_FRAGMENTS, ["audio", "capture", "diariz", "listen", "mic", "pcm", "record", "speech", "stream", "transcri", "voice", "waveform"]);
});

test("UX14: a payload that does not say recording is denied is not drawn, and D03 is not implied", async () => {
  const { readA } = await sharedMeeting();
  const payload = await readA();
  assert.equal(validMeetingPayload(payload), true);
  assert.equal(payload.d03_recording.legacy_recorder_presence_is_evidence, false);
  assert.equal(payload.status.recording, "never_started");
  for (const bad of [
    { ...payload, records_audio: true },
    { ...payload, recording: "allowed" },
    { ...payload, meeting: { ...payload.meeting, recording: "active" } },
  ]) {
    assert.equal(validMeetingPayload(bad), false);
    assert.equal(meetingState({ state: "read", payload: bad }, { state: "ok" }).state, "invalid");
  }
  assert.match(NO_RECORDING, /captures no audio/);
  assert.match(D03_DEFERRED, /an old recorder existing somewhere is not that evidence/);
  assert.match(DETECTION_UNAVAILABLE, /never started for you/);
  assert.equal(recapView(payload).lines[0], "Recording: never started.");
});

test("UX14: the page has no microphone, recorder, dictation or legacy capture session", () => {
  for (const [name, text] of [["meeting.html", html], ["js/meeting.js", pageJs], ["css/meeting.css", css]]) {
    for (const pattern of [/getUserMedia/, /MediaRecorder/, /SpeechRecognition/, /AudioContext/, /docMic|doc-mic|Dictate/, /capture_session|captureSession/, /<audio|<video/]) {
      assert.equal(pattern.test(text), false, `${name} reaches for ${pattern}`);
    }
  }
  assert.equal(/id="docChat"|mountDocDock/.test(html + pageJs), false, "the Doc dock carries a dictation button");
  assert.match(html, /id="noRecordingLine"/);
  assert.match(pageJs, /\$\("noRecordingLine"\)\.textContent = NO_RECORDING/);
});

/* ------------------------------------------------------------ the surface */

test("a proposal is never a record effect: only reconciled evidence draws done", () => {
  const action = (state, extra = {}) => ({ action_number: 1, state, current_revision: 1, revisions: [{ revision: 1, summary: "s", command: { verb: "add-loop", args: {} } }], ...extra });
  assert.equal(actionTag(action("proposed")), "needs_approval");
  assert.equal(actionTag(action("accepted")), "accepted");
  assert.equal(actionTag(action("executed")), "accepted", "executed without evidence was drawn as done");
  assert.equal(actionTag(action("executed", { outcome: { evidence: "public.tool_call" } })), "executed");
  assert.equal(actionTag(action("declined")), "declined");
});

test("the live adapter reaches CARR only through same-origin MCP, and dispatches only a carried verb under a given key", async () => {
  const calls = [];
  const live = createLiveClient({ online: () => true, fetchImpl: async (path, init) => {
    calls.push({ path, body: JSON.parse(init.body), credentials: init.credentials });
    return new Response(JSON.stringify({ result: { content: [{ text: JSON.stringify({ ok: true }) }] } }), { status: 200 });
  } });
  await live.readMeeting({ meeting_id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01", after_seq: 3 });
  const key = uuid();
  await live.addMeetingNote({ idempotency_key: key, meeting_id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01", body: "b", client_instance: "app-x" });
  await live.dispatchMeetingCommand({ verb: "add-loop", args: { kind: "team_loop", owner: "Dell", title: "t" }, idempotency_key: key });
  assert.deepEqual(calls.map((c) => [c.path, c.body.params.name, c.credentials]), [
    ["/mcp", "read-meeting", "same-origin"], ["/mcp", "add-meeting-note", "same-origin"], ["/mcp", "add-loop", "same-origin"]]);
  assert.equal(calls[1].body.params.arguments.idempotency_key, key);
  assert.equal(calls[2].body.params.arguments.idempotency_key, key);
  for (const refused of [{ verb: "log-activity", args: {}, idempotency_key: key }, { verb: "add-loop", args: {} }]) {
    await assert.rejects(live.dispatchMeetingCommand(refused), (error) => error.payload.error === "meeting_dispatch_not_carried");
  }
  assert.equal(calls.length, 3, "a refused dispatch reached the network");
});

test("the route, the versions, the producer pin and the eight verbs are in the contracts", () => {
  assert.equal(routes.version, "1.11.0");
  assert.equal(routes.routes["/meeting"], "meeting.html");
  assert.ok(APP_ROUTE_PATHS.includes("/meeting"), "the route copy drifted from the route contract");
  assert.equal(contract.version, "1.20.0");
  assert.equal(contract.producer.source_commit, "35009e9dedab3a603836c662d0f7f12dfeb1a284", "the producer is the merged CARR Meeting Mode backend");
  for (const verb of MEETING_VERBS) assert.ok(contract.mcp_operations.includes(verb), `${verb} is not pinned`);
  for (const verb of DISPATCHABLE_VERBS) assert.ok(contract.mcp_operations.includes(verb), `the dispatchable ${verb} is not pinned`);
  assert.equal(contract.mcp_operations.length, 65);
  assert.deepEqual(contract.mcp_operations, [...contract.mcp_operations].sort());
  assert.ok(contract.invariants.some((line) => /meeting proposal is never shown as a record effect/.test(line)));
  assert.equal(contract.transport.database_access, "forbidden");
});

test("every name the page imports from its model exists, so the browser module links", async () => {
  const model = await import("../js/meeting-model.js");
  const memory = await import("../js/meeting-memory.mjs");
  const names = (from) => new RegExp(`import \\{([^}]*)\\} from "\\./${from.replace(".", "\\.")}"`).exec(pageJs)[1]
    .split(",").map((name) => name.trim()).filter(Boolean);
  assert.deepEqual(names("meeting-model.js").filter((name) => !(name in model)), []);
  assert.deepEqual(names("meeting-memory.mjs").filter((name) => !(name in memory)), []);
});

test("the page is the shared shell with the dock, Confirm and Skip, and the 44px floor at 360px", () => {
  assert.match(html, /<title>Meeting · DoctorCRE<\/title>/);
  assert.match(html, /<a href="\/meeting" aria-current="page">Meeting<\/a>/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/system\.css">/);
  assert.match(html, /<div id="receiptDock" class="receipt-dock"/);
  assert.match(html, /<script type="module" src="\/js\/meeting\.js"><\/script>/);
  assert.match(pageJs, />Confirm<\/button>/);
  assert.match(pageJs, />Skip<\/button>/);
  assert.match(pageJs, /performCommand/);
  assert.match(pageJs, /finishAcceptedAction/);
  assert.match(css, /\.btn \{ min-height: var\(--touch\); \}/);
  assert.match(css, /\.action-row \.btn \{ width: 100%; \}/);
  assert.equal(/[^-]width:\s*\d{3,}px/.test(css), false, "a fixed pixel width can force a horizontal scroll");
  assert.deepEqual(meetingRoute("?id=nope"), { state: "malformed", id: null, given: "nope" });
  assert.equal(meetingRoute("").state, "missing");
});
