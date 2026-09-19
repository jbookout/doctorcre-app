// The shared command kernel: what ONE logical operation does when the answer is
// late, lost, refused, or never comes at all — for any command the product
// sends, not only a board cell.
//
// Every claim here is EXECUTED against the real model. The `call` under test is
// a scripted transport, so "the answer was lost after the write landed", "the
// person clicked twice" and "the server broke on the way out" are real
// sequences with real return values rather than descriptions of them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  beginCommand, classifyCommandOutcome, commandDockHtml, commandMessage, commandReceiptView,
  createCommandState, feedbackStateFor, pendingCommand, performCommand, sameCommandIntent,
  settleCommand, unresolvedCommands,
} from "../js/command-feedback.mjs";
import { DOCK_ENTRY_CAP, createCommandDock } from "../js/command-dock.js";
import { FEEDBACK_STATES } from "../js/visual-system.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");

/** A surface that owns one command state and one scripted transport. */
function surface(answers = []) {
  let state = createCommandState();
  const sent = [];
  let minted = 0;
  const queue = [...answers];
  return {
    sent,
    state: () => state,
    keys: () => minted,
    send: (operationKey, args, { supersededBy = null } = {}) => performCommand({
      operationKey, args, supersededBy,
      getState: () => state,
      setState: (next) => { state = next; },
      newKey: () => `key-${++minted}`,
      call: async (request) => {
        sent.push(request);
        const answer = queue.shift();
        if (!answer) throw new Error("no scripted answer left");
        return answer(request);
      },
    }),
  };
}

const ok = (extra = {}) => () => ({ ok: true, ...extra });
const dropped = (message = "connection dropped") => () => { throw new Error(message); };
const refusal = (payload) => () => {
  const error = new Error(`refused: ${payload.error}`);
  error.payload = payload;
  throw error;
};
const httpFailure = (status) => () => { throw Object.assign(new Error(String(status)), { status }); };

// --------------------------------------------------------------- 1. the states

test("every answer the record layer can give is a different state, and the ones that share a state do not share a sentence", () => {
  const cases = {
    accepted: classifyCommandOutcome({ response: { ok: true, event_id: "e1" } }),
    declined: classifyCommandOutcome({ error: { payload: { error: "parking_reason_required", hint: "Say why it is parked." } } }),
    version: classifyCommandOutcome({ error: { payload: { error: "version_conflict" } } }),
    confirm: classifyCommandOutcome({ error: { payload: { error: "needs_confirm" } } }),
    base: classifyCommandOutcome({ error: { payload: { error: "invalid_base_version" } } }),
    silence: classifyCommandOutcome({ error: new Error("Failed to fetch") }),
    fault: classifyCommandOutcome({ error: { payload: { error: "unhandled_verb_failure", hint: "TypeError" } } }),
    denied: classifyCommandOutcome({ error: Object.assign(new Error("401"), { status: 401 }) }),
    gateway: classifyCommandOutcome({ error: Object.assign(new Error("502"), { status: 502 }) }),
    spent: classifyCommandOutcome({ error: { payload: { error: "key_reuse" } } }),
  };
  assert.deepEqual(
    Object.fromEntries(Object.entries(cases).map(([name, outcome]) => [name, `${outcome.status}/${outcome.reason}`])),
    {
      accepted: "ok/null", declined: "refused/declined", version: "conflict/version_conflict",
      confirm: "conflict/needs_confirm", base: "conflict/base_version", silence: "unknown/no_answer",
      fault: "unknown/server_error", denied: "refused/unauthorized", gateway: "unknown/server_error",
      spent: "refused/key_reuse",
    });
  // Nine of the ten are distinct pairs; the two that share `unknown/server_error`
  // are still told apart, because one names a status and the other a code.
  assert.equal(new Set(Object.values(cases).map((o) => `${o.status}/${o.reason}`)).size, 9);
  assert.notEqual(commandMessage(cases.fault), commandMessage(cases.gateway));
  assert.match(commandMessage(cases.gateway), /\(HTTP 502\)$/);
  assert.equal(cases.gateway.http_status, 502);
  assert.equal(cases.denied.code, "http_401");
  assert.equal(cases.fault.hint, null, "a server stack is never carried to a person");
  assert.match(commandMessage(cases.declined), /Say why it is parked\./, "the verb's own words come first");
  // The three conflict reasons are three different instructions.
  assert.match(commandMessage(cases.version), /changed since you read it/);
  assert.match(commandMessage(cases.confirm), /needs a confirmation/);
  assert.match(commandMessage(cases.base), /version was missing or stale/);
  // And a shape with no positive answer in it is an unknown, never a success.
  assert.equal(classifyCommandOutcome({ response: null }).status, "unknown");
  assert.equal(classifyCommandOutcome({ response: { ok: false } }).status, "unknown");
  assert.equal(classifyCommandOutcome({}).status, "unknown");
  // The patch-deal-field conflict shape, which carries no `ok` at all.
  const crossed = classifyCommandOutcome({ response: { status: "conflict", conflict: { conflict_id: "c1" } } });
  assert.equal(crossed.status, "conflict");
  assert.deepEqual(crossed.conflict, { conflict_id: "c1" });
});

// --------------------------------------------------------------- 2. one key

test("a double click is one operation: the second send never leaves the page and no second key is minted", async () => {
  let state = createCommandState();
  const sent = [];
  let minted = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const send = () => performCommand({
    operationKey: "loop:612:close", args: { loop: 612, outcome: "closed" },
    getState: () => state,
    setState: (next) => { state = next; },
    newKey: () => `key-${++minted}`,
    call: async (request) => { sent.push(request); await gate; return { ok: true, event_id: "e1" }; },
  });

  const first = send();
  const second = await send();
  assert.equal(second.started, false);
  assert.equal(second.status, "in_flight");
  assert.equal(second.sent, false);
  assert.match(second.message, /still being sent/);
  assert.equal(sent.length, 1, "one request left the page");

  release();
  const settled = await first;
  assert.equal(settled.status, "ok");
  assert.equal(sent.length, 1);
  assert.equal(minted, 1, "one intended action, one key");
  assert.deepEqual(state, {}, "settled: the operation is clear for the next intent");
});

// --------------------------------------------------------------- 3. reconnect

test("a lost answer is reconciled by re-sending the IDENTICAL frozen request, and the replay settles it", async () => {
  const s = surface([dropped(), ok({ replayed: true, event_id: "e1" })]);
  const args = { action: "complete", actor: "joe", note: "signed" };

  const lost = await s.send("action:complete:joe", args);
  assert.equal(lost.status, "unknown");
  assert.equal(lost.reason, "no_answer");
  assert.equal(lost.sent, true);
  assert.match(lost.message, /nothing came back from the server/);
  assert.equal(pendingCommand(s.state(), "action:complete:joe").status, "unknown");
  assert.deepEqual(unresolvedCommands(s.state()).map((entry) => entry.operationKey), ["action:complete:joe"]);
  assert.equal(unresolvedCommands(s.state())[0].idempotency_key, s.sent[0].idempotency_key);

  // The same intent, rebuilt from the same inputs in a different order: still
  // the same operation, so the retained request goes out again unchanged.
  const retry = await s.send("action:complete:joe", { note: "signed", actor: "joe", action: "complete" });
  assert.equal(retry.status, "ok");
  assert.equal(retry.replayed, true, "the server replayed the stored answer");
  assert.equal(retry.retry, true, "and the kernel knows this was the same operation");
  assert.equal(retry.event_id, "e1");

  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[1], s.sent[0], "the very same request object, not a rebuilt copy");
  assert.equal(s.keys(), 1, "no second key was minted");
  assert.deepEqual(s.state(), {});
});

// --------------------------------------------------------------- 4. a different intent

test("a different intent cannot supersede an operation that is still unknown", async () => {
  const s = surface([dropped()]);
  const lost = await s.send("deal:C-12|phase", { deal: "C-12", field: "phase", value: "Negotiation" });
  assert.equal(lost.status, "unknown");
  const before = s.state();

  const different = await s.send("deal:C-12|phase", { deal: "C-12", field: "phase", value: "Legal" });
  assert.equal(different.started, false);
  assert.equal(different.status, "blocked");
  assert.equal(different.sent, false);
  assert.match(different.message, /earlier change that was never confirmed/);
  assert.equal(s.sent.length, 1, "nothing was sent");
  assert.equal(s.keys(), 1, "and nothing was minted over the top of it");
  assert.equal(s.state(), before, "the unresolved entry is untouched");
  assert.equal(different.pending.request.idempotency_key, s.sent[0].idempotency_key);
});

// --------------------------------------------------------------- 5. conflict is terminal

test("a conflict is settled, not pending: nothing is retained to retry, and the person is told to re-read", async () => {
  const s = surface([refusal({ error: "version_conflict", hint: "Dell changed this 40 seconds ago." }), ok()]);
  const crossed = await s.send("deal:C-12|owner", { deal: "C-12", field: "owner", value: "joe" });
  assert.equal(crossed.status, "conflict");
  assert.equal(crossed.reason, "version_conflict");
  assert.equal(pendingCommand(s.state(), "deal:C-12|owner"), null, "a conflict leaves nothing to re-send");
  assert.deepEqual(s.state(), {});
  assert.match(crossed.message, /Re-open it and decide from what it holds now\./);
  assert.doesNotMatch(crossed.message, /send it again|try again/i, "a re-send would replay the same refusal");
  assert.equal(feedbackStateFor({ status: crossed.status }), "refused");

  // And the person is not blocked from deciding on that record again.
  const after = await s.send("deal:C-12|owner", { deal: "C-12", field: "owner", value: "dell" });
  assert.equal(after.status, "ok");
  assert.notEqual(s.sent[1].idempotency_key, s.sent[0].idempotency_key);
});

// --------------------------------------------------------------- 6. supersession

test("supersession is the caller's own judgement, and is false when no caller supplies one", async () => {
  const withHook = surface([ok({ event_id: "e1" })]);
  const overtaken = await withHook.send("deal:C-12|attention", { deal: "C-12", value: true }, {
    supersededBy: (request, outcome) => {
      assert.equal(outcome.event_id, "e1", "the hook sees the event the answer named");
      assert.equal(request.idempotency_key, withHook.sent[0].idempotency_key);
      return true;
    },
  });
  assert.equal(overtaken.status, "ok");
  assert.equal(overtaken.superseded, true);
  assert.match(overtaken.message, /Something newer has since landed on this record/);

  const plain = surface([ok({ event_id: "e1" })]);
  const quiet = await plain.send("loop:612:close", { loop: 612 });
  assert.equal(quiet.superseded, false, "a surface with no version to compare claims nothing");
  assert.equal(quiet.message, null, "and a plain success is not narrated");
});

// --------------------------------------------------------------- 7. no authority

test("the kernel adds one field and no more, sends exactly the frozen request, and never edits the caller's arguments", async () => {
  const args = { loop: 612, outcome: "closed", detail: { by: "joe", tags: ["a"] } };
  const snapshot = JSON.parse(JSON.stringify(args));
  const s = surface([dropped()]);
  const lost = await s.send("loop:612:close", args);

  assert.deepEqual(args, snapshot, "the caller's own object is untouched");
  assert.equal(Object.isFrozen(args), false, "and is not frozen out from under it");
  assert.deepEqual(Object.keys(s.sent[0]).sort(), ["detail", "idempotency_key", "loop", "outcome"],
    "one field added, and it is the key");
  assert.equal(s.sent[0], lost.request, "`call` receives the request this operation IS");
  assert.ok(Object.isFrozen(lost.request));
  assert.ok(Object.isFrozen(lost.request.detail), "nested arguments are frozen too");
  assert.throws(() => { lost.request.outcome = "reopened"; }, TypeError);
  assert.throws(() => { lost.request.idempotency_key = "other"; }, TypeError);
  assert.equal(pendingCommand(s.state(), "loop:612:close").request.outcome, "closed");

  // The key is never part of what makes two attempts the same intent.
  assert.equal(sameCommandIntent({ a: 1, idempotency_key: "k1" }, { a: 1, idempotency_key: "k2" }), true);
  assert.equal(sameCommandIntent({ a: 1 }, { a: 2 }), false);
  // begin and settle are pure: neither writes into the state it was handed.
  const state = createCommandState();
  const claim = beginCommand(state, { operationKey: "x", args: { a: 1 }, newKey: () => "k" });
  assert.deepEqual(state, {}, "begin returns a new state instead of mutating one");
  assert.deepEqual(settleCommand(claim.state, "x", { status: "ok" }), {});
  assert.equal(settleCommand(claim.state, "x", { status: "unknown", reason: "no_answer" }).x.status, "unknown");
});

// --------------------------------------------------------------- 8. feedback states

test("every kernel status maps to a feedback state, and the retry of an unknown is checking, not saving", () => {
  const mapped = {
    sending: feedbackStateFor({ status: "sending" }),
    reconcile: feedbackStateFor({ status: "sending", retry: true }),
    in_flight: feedbackStateFor({ status: "in_flight" }),
    blocked: feedbackStateFor({ status: "blocked" }),
    ok: feedbackStateFor({ status: "ok" }),
    refused: feedbackStateFor({ status: "refused" }),
    conflict: feedbackStateFor({ status: "conflict" }),
    unknown: feedbackStateFor({ status: "unknown" }),
    undone: feedbackStateFor({ status: "undone" }),
  };
  assert.deepEqual(mapped, {
    sending: "pending", reconcile: "checking", in_flight: "pending", blocked: "unknown",
    ok: "confirmed", refused: "refused", conflict: "refused", unknown: "unknown", undone: "undone",
  });
  for (const [status, state] of Object.entries(mapped)) {
    assert.ok(FEEDBACK_STATES.includes(state), `${status} mapped to ${state}, which is not a feedback state`);
  }
  assert.notEqual(mapped.reconcile, mapped.sending,
    "a reconcile is not a fresh save, and must not be badged as one");
});

// --------------------------------------------------------------- 9. the dock

test("the dock renders one receipt per operation with the one action that state offers, escapes what a record is called, and shows the newest four", () => {
  const entry = (operationKey, status, extra = {}) => commandReceiptView({ operationKey, summary: `Change ${operationKey}`, status, ...extra });
  const views = [
    entry("a", "sending"),
    entry("b", "ok", { undo: true }),
    entry("c", "ok"),
    entry("d", "refused", { reason: "declined" }),
    entry("e", "unknown"),
    entry("f", "sending", { retry: true }),
  ];
  const html = commandDockHtml(views);

  assert.equal((html.match(/class="receipt"/g) || []).length, 4, "the dock shows the newest four");
  assert.ok(!html.includes('data-op="a"') && !html.includes('data-op="b"'), "and drops the oldest two");
  for (const state of ["ok", "refused", "unknown", "checking"]) {
    const expected = state === "ok" ? "confirmed" : state;
    assert.ok(html.includes(`data-state="${expected}"`), `no receipt is in state ${expected}`);
  }
  assert.match(html, /data-op="d" data-event="dispatch">Try again</);
  assert.match(html, /data-op="e" data-event="reconcile">Check outcome</);
  assert.ok(!html.includes('data-event="undo"'), "a confirmed receipt without undo offers none");
  // Undo appears only when the caller says the operation can be undone.
  const undoable = commandDockHtml([entry("b", "ok", { undo: true })]);
  assert.match(undoable, /data-op="b" data-event="undo">Undo</);
  assert.ok(!commandDockHtml([entry("c", "ok")]).includes("data-event"), "and never otherwise");
  // A confirmed receipt reads as confirmed and a checking one as checking.
  assert.match(html, /data-state="checking"[^>]*><span class="receipt-badge">Checking</);
  assert.match(undoable, /<span class="receipt-badge">Confirmed<\/span>/);

  // A record's name is text, not markup.
  const nasty = commandDockHtml([commandReceiptView({
    operationKey: 'deal:"x"|phase', summary: '<img src=x onerror="alert(1)">', status: "ok",
  })]);
  assert.ok(!nasty.includes("<img"), "a record name is escaped");
  assert.match(nasty, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(nasty, /data-op="deal:&quot;x&quot;\|phase"/);

  // With no reason to show, the receipt names the safety key this operation
  // carries — which is the thing a person would be asked for.
  const keyed = commandReceiptView({ operationKey: "loop:612:close", summary: "Close loop 612", status: "sending", request: { idempotency_key: "k-9" } });
  assert.equal(keyed.detail, "safety key k-9");
  assert.equal(commandDockHtml([], { limit: 4 }), "");
  assert.equal((commandDockHtml(views, { limit: 2 }).match(/class="receipt"/g) || []).length, 2);
});

// --------------------------------------------------------------- 10. contract and stylesheet

test("checking is a declared state of the shared visual system, and the stylesheet draws it", async () => {
  const contract = JSON.parse(await read("contracts/visual-system.v1.json"));
  assert.deepEqual(contract.components.command_feedback.states, [
    '.receipt[data-state="pending"]',
    '.receipt[data-state="confirmed"]',
    '.receipt[data-state="refused"]',
    '.receipt[data-state="unknown"]',
    '.receipt[data-state="checking"]',
    '.receipt[data-state="undone"]',
  ]);
  const css = await read("css/system.css");
  assert.match(css, /\.receipt\[data-state="checking"\] \{[^}]*border-left-color: var\(--cyan\)/);
  assert.match(css, /\.receipt\[data-state="checking"\] \.receipt-badge \{ color: var\(--cyan-text\); \}/);
  assert.match(css, /\.receipt\[data-state="undone"\] \.receipt-badge \{ color: var\(--muted\); \}/);
  assert.match(css, /\.receipt \.btn \{ min-height: var\(--touch\); \}/, "a dock action is a full touch target");

  // The invariant this whole slice exists to keep, pinned where the consumer
  // contract can be read without the code.
  const carr = JSON.parse(await read("contracts/carr-interface.v1.json"));
  assert.equal(carr.version, "1.16.0");
  assert.ok(carr.invariants.some((line) => /one idempotency key across double click, reconnect and a second device/.test(line)));
});

/* ------------------------------------------------------------------ the dock cap */

// The dock keeps one entry per operation forever, so a long session grew the
// Map without bound. Orchestrator ruling 2026-09-17: evict CONFIRMED receipts
// only, oldest first. An unresolved one is work the person still owes an
// answer to, and forgetting it would quietly drop the only offer to reconcile.

test("a long session drops the oldest confirmed receipt and keeps every pending, refused and unknown one", () => {
  const dock = createCommandDock({ root: null });
  const unresolved = [
    { key: "pending-1", status: "sending" },
    { key: "refused-1", status: "refused" },
    { key: "unknown-1", status: "unknown" },
  ];
  for (const { key, status } of unresolved) dock.record(key, { summary: key, status });

  // Well past the cap, all confirmed, in age order.
  for (let index = 0; index < DOCK_ENTRY_CAP + 20; index += 1) {
    dock.record(`ok-${index}`, { summary: `confirmed ${index}`, status: "ok" });
  }

  assert.equal(dock.entries.size, DOCK_ENTRY_CAP, "the dock settles at the cap");
  for (const { key } of unresolved) {
    assert.equal(dock.entries.has(key), true, `${key} is never evicted`);
  }
  // The oldest confirmed ones went first, and the newest are all still here.
  assert.equal(dock.entries.has("ok-0"), false, "the oldest confirmed receipt is the one that goes");
  assert.equal(dock.entries.has("ok-22"), false);
  assert.equal(dock.entries.has("ok-23"), true);
  assert.equal(dock.entries.has(`ok-${DOCK_ENTRY_CAP + 19}`), true);

  // With nothing confirmed left to drop, the Map is ALLOWED to exceed the cap
  // rather than forget outstanding work.
  const outstanding = createCommandDock({ root: null });
  for (let index = 0; index < DOCK_ENTRY_CAP + 5; index += 1) {
    outstanding.record(`stuck-${index}`, { summary: `pending ${index}`, status: "in_flight" });
  }
  assert.equal(outstanding.entries.size, DOCK_ENTRY_CAP + 5, "nothing resolved, so nothing is evicted");

  // And once those resolve, the backlog drains from the oldest.
  outstanding.record("stuck-0", { summary: "pending 0", status: "ok" });
  assert.equal(outstanding.entries.has("stuck-0"), false, "the receipt that just confirmed is now evictable");
  assert.equal(outstanding.entries.size, DOCK_ENTRY_CAP + 4);
});

test("eviction never changes what the newest four render as", () => {
  const dock = createCommandDock({ root: null });
  for (let index = 0; index < 10; index += 1) {
    dock.record(`ok-${index}`, { summary: `confirmed ${index}`, status: "ok" });
  }
  const newestFour = () => commandDockHtml([...dock.entries.values()].map(commandReceiptView));
  const before = newestFour();
  assert.match(before, /confirmed 9/);
  assert.doesNotMatch(before, /confirmed 5/, "four is four, before the cap is anywhere near");

  for (let index = 10; index < DOCK_ENTRY_CAP + 40; index += 1) {
    dock.record(`ok-${index}`, { summary: `confirmed ${index}`, status: "ok" });
  }
  assert.equal(dock.entries.size, DOCK_ENTRY_CAP, "eviction did run");

  // The rendered four are still the four newest, drawn exactly as they were.
  const after = newestFour();
  const expected = createCommandDock({ root: null });
  for (let index = DOCK_ENTRY_CAP + 36; index < DOCK_ENTRY_CAP + 40; index += 1) {
    expected.record(`ok-${index}`, { summary: `confirmed ${index}`, status: "ok" });
  }
  assert.equal(after, commandDockHtml([...expected.entries.values()].map(commandReceiptView)));
  assert.equal(after.includes("confirmed 9"), false, "the old ones are gone from the render too");
});
