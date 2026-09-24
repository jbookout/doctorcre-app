// V5-UX-B07 — the Doc conversations page, one test per clause of the frozen spec.
//
// The payloads below are the producer's own shapes. Three of them are the whole
// reason this file exists, and a friendlier fixture would let the page pass
// while shipping a disclosure the record layer is built to withhold:
//
//   * `doc_conversation_not_found` is ONE answer for absent, for not-shared and
//     for a malformed id. Clause 1 asserts all three side by side.
//   * `visible_conversation_count` is computed inside the definer over what the
//     ACTING actor may see, so it changes with the actor and cannot be derived
//     from a device roster. Clause 2 asserts the page prints it.
//   * `rename-doc-conversation` is a compare-and-swap that appends the PRIOR
//     title and touches no turn. Clauses 6 and 8 assert both halves.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  COMPOSER_ABSENT, CONVERSATION_ID, CONVERSATION_STATES, DOC_REPLY_PENDING, EXPOSURE_STATEMENT,
  LIST_EMPTY, LIST_PAGE_SIZE, LIST_SCOPE, PARTNER_SLUGS, SHARING_CAVEAT,
  TITLE_HISTORY_UNREADABLE, accessRows, archiveOperationKey, classifyReadFailure,
  conversationState, createArgs, createOperationKey, idFromSearch, identityHeader, listArgs,
  listPagingState, listRows, pagingState, pinOperationKey, renameArgs, renameOperationKey,
  shareArgs, shareCandidates, shareOperationKey, turnRows, validDocConversationPayload,
  visibleCountLine,
} from "../js/conversations-model.js";
import { APP_ROUTE_PATHS } from "../js/notifications-model.js";
import { classifyCommandOutcome, createCommandState, settleCommand } from "../js/command-feedback.mjs";
import { createFixtureClient } from "../js/fixture-client.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const html = await read("conversations.html");
const css = await read("css/conversations.css");
const pageJs = await read("js/conversations.js");
const fixtureJs = await read("js/fixture-client.js");
const routes = JSON.parse(await read("contracts/app-routes.v1.json"));
const contract = JSON.parse(await read("contracts/carr-interface.v1.json"));

const fixture = async (options = {}) => {
  const seed = await read("data/board-seed.json");
  return createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seed).toString("base64")}`, ...options });
};

const PRIVATE = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01";
const SHARED = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c02";
const REVOKED = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c03";
const SHARED_NO_GRANT = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c04";
const ABSENT = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3cff";
const key = (tail) => `9b8a7c6d-5e4f-4a3b-8c2d-${String(tail).padEnd(12, "0")}`;
const codeOf = async (run) => {
  try {
    await run();
    return null;
  } catch (error) {
    return error?.payload?.error ?? null;
  }
};

/* ------------------------------------------------------------------ clause 1 */

test("clause 1: a private conversation is invisible to the partner, and absent, not-yours and malformed are ONE answer", async () => {
  const dell = await fixture({ selfActor: "dell" });

  const notYours = await codeOf(() => dell.readDocConversation({ conversation_id: PRIVATE }));
  const absent = await codeOf(() => dell.readDocConversation({ conversation_id: ABSENT }));
  const malformed = await codeOf(() => dell.readDocConversation({ conversation_id: "not-a-uuid" }));

  // Side by side, in one block, so a future friendlier fixture goes red here.
  assert.equal(notYours, "doc_conversation_not_found");
  assert.equal(absent, "doc_conversation_not_found");
  assert.equal(malformed, "doc_conversation_not_found");
  assert.equal(notYours, absent);
  assert.equal(absent, malformed);

  // The revoked one is invisible to the partner for the same reason and by the
  // same code: a grant that ended is indistinguishable from one never made.
  assert.equal(await codeOf(() => dell.readDocConversation({ conversation_id: REVOKED })), "doc_conversation_not_found");

  // And the page renders that ambiguity as the ambiguity it is.
  const state = conversationState({ state: "not_found" });
  assert.equal(state.state, "not_found");
  assert.match(state.sentence, /the record layer answers those the same way on purpose/);
  assert.equal(classifyReadFailure({ payload: { error: "doc_conversation_not_found" } }).state, "not_found");
});

/* ------------------------------------------------------------------ clause 2 */

test("clause 2: the visible count is the payload's own number, and the page prints it rather than counting", async () => {
  const joe = await fixture();
  const dell = await fixture({ selfActor: "dell" });

  assert.equal((await joe.readDocConversation({ conversation_id: PRIVATE })).visible_conversation_count, 4);
  assert.equal((await dell.readDocConversation({ conversation_id: SHARED })).visible_conversation_count, 1,
    "the partner's count includes a conversation that is not shared with him");

  // The list door carries the same definer-computed scalar, and it is the one
  // the page prints. It is NOT the number of rows on screen: the default page
  // hides the archived conversation, so the rows and the count differ here.
  const listed = await joe.listDocConversations(listArgs({}));
  assert.equal(listed.visible_conversation_count, 4);
  assert.equal(listRows(listed).length, 3, "the archived conversation is in the default page");
  assert.equal(visibleCountLine(listed), "You can see 4 conversations.");
  assert.equal(visibleCountLine(await dell.listDocConversations(listArgs({}))), "You can see 1 conversation.");
  assert.equal(visibleCountLine(null), "unknown");
  assert.equal(visibleCountLine({ conversations: [], visible_conversation_count: null }), "unknown");

  assert.match(pageJs, /\$\("visibleCountLine"\)\.textContent = visibleCountLine\(payload\)/);
  assert.equal(/visible_conversation_count\s*=|rows\.length \+|conversations\.filter\(/.test(pageJs), false,
    "the page derives a visible count of its own");
  assert.match(LIST_SCOPE, /read from the record layer/);
});

/* ------------------------------------------------------------------ clause 3 */

test("clause 3: sharing on grants the partner a read, names him in the grants, and a second grant is not a second row", async () => {
  const joe = await fixture();
  const dell = await fixture({ selfActor: "dell" });
  assert.equal(await codeOf(() => dell.readDocConversation({ conversation_id: PRIVATE })), "doc_conversation_not_found");

  const granted = await joe.shareDocConversation({ idempotency_key: key("aa0001"), conversation_id: PRIVATE, grantee_slug: "dell", granted: true });
  assert.equal(granted.ok, true);
  assert.equal(granted.already, false);
  assert.equal(granted.granted, true);

  const mine = await joe.readDocConversation({ conversation_id: PRIVATE });
  assert.equal(mine.identity.visibility, "shared");
  const rows = accessRows(mine);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].grantee, "dell");
  assert.ok(rows[0].clock && rows[0].clock !== "unknown", "the grant carries no granted_at");
  assert.equal(rows[0].grantedBy, "joe");

  // A second identical grant is `already: true` and adds no second row.
  const again = await joe.shareDocConversation({ idempotency_key: key("aa0002"), conversation_id: PRIVATE, grantee_slug: "dell", granted: true });
  assert.equal(again.already, true);
  assert.equal(again.granted, true);
  assert.equal(accessRows(await joe.readDocConversation({ conversation_id: PRIVATE })).length, 1);

  // The share toggle is per partner slug, and never offers the creator himself.
  assert.deepEqual(shareCandidates(mine, PARTNER_SLUGS), [{ slug: "dell", granted: true }]);
  assert.equal(await codeOf(() => joe.shareDocConversation({ idempotency_key: key("aa0003"), conversation_id: PRIVATE, grantee_slug: "joe", granted: true })), "doc_conversation_grantee_is_creator");
  assert.equal(await codeOf(() => joe.shareDocConversation({ idempotency_key: key("aa0004"), conversation_id: PRIVATE, grantee_slug: "nobody", granted: true })), "doc_conversation_grantee_not_found");
  assert.equal(await codeOf(() => joe.shareDocConversation({ idempotency_key: key("aa0005"), conversation_id: PRIVATE, grantee_slug: "  ", granted: true })), "doc_conversation_grantee_slug_invalid");
  assert.equal(await codeOf(() => joe.shareDocConversation({ idempotency_key: key("aa0006"), conversation_id: "not-a-uuid", grantee_slug: "dell", granted: true })), "doc_conversation_id_invalid");
});

/* ------------------------------------------------------------------ clause 4 */

test("clause 4: sharing off revokes the read, keeps the revoked row, and the caveat is on the page verbatim", async () => {
  const joe = await fixture();
  await joe.shareDocConversation({ idempotency_key: key("bb0001"), conversation_id: PRIVATE, grantee_slug: "dell", granted: true });

  const revoked = await joe.shareDocConversation({ idempotency_key: key("bb0002"), conversation_id: PRIVATE, grantee_slug: "dell", granted: false });
  assert.equal(revoked.already, false);
  assert.equal(revoked.granted, false);

  const after = await joe.readDocConversation({ conversation_id: PRIVATE });
  assert.deepEqual(after.effective_grants, []);
  assert.equal(after.identity.visibility, "private");

  // Revoking again is `already: true`, not a refusal: the store wrote nothing.
  const twice = await joe.shareDocConversation({ idempotency_key: key("bb0003"), conversation_id: PRIVATE, grantee_slug: "dell", granted: false });
  assert.equal(twice.already, true);
  assert.equal(twice.granted, false);

  // The seeded revoked conversation proves the row is kept, never deleted: its
  // grant is gone from `effective_grants` and the conversation is still Joe's.
  const kept = await joe.readDocConversation({ conversation_id: REVOKED });
  assert.deepEqual(kept.effective_grants, []);
  assert.equal(kept.identity.visibility, "private");
  assert.equal(kept.identity.created_by, "joe");

  // REVOKED, NEVER DELETED. The projection cannot show a revoked row — that is
  // the point of the projection — so the assertion is on the adapter that
  // stands in for the store: it stamps `revoked_at` and removes nothing. A
  // fixture that spliced the row out would answer every question above the same
  // way while losing the audit the record layer keeps.
  assert.match(fixtureJs, /if \(!live\) return[\s\S]*?live\.revoked_at = nowIso\(\);/,
    "the revoke path no longer stamps revoked_at on the grant row");
  assert.equal(/row\.grants\.splice|row\.grants = row\.grants\.filter|delete row\.grants/.test(fixtureJs), false,
    "a grant row is removed rather than stamped; the store revokes and never deletes");

  assert.equal(SHARING_CAVEAT, "Turning sharing off ends future access. It cannot unsee what a partner already read.");
  assert.match(pageJs, /\$\("sharingCaveat"\)\.textContent = SHARING_CAVEAT/);
  assert.match(html, /<p class="headline" id="sharingCaveat">/);
});

/* ------------------------------------------------------------------ clause 5 */

test("clause 5: sharing and revoking move the grant list and the header visibility, and nothing else", async () => {
  const joe = await fixture();
  const before = await joe.readDocConversation({ conversation_id: PRIVATE });
  const otherBefore = await joe.readDocConversation({ conversation_id: SHARED });

  await joe.shareDocConversation({ idempotency_key: key("cc0001"), conversation_id: PRIVATE, grantee_slug: "dell", granted: true });
  const shared = await joe.readDocConversation({ conversation_id: PRIVATE });

  // Everything except the grants and the header's visibility is deep-equal.
  const strip = ({ effective_grants, identity, ...rest }) => {
    const { visibility, ...identityRest } = identity;
    return { ...rest, identity: identityRest };
  };
  assert.deepEqual(strip(shared), strip(before), "sharing moved a second field");
  assert.equal(shared.identity.version, before.identity.version, "sharing bumped the version");

  await joe.shareDocConversation({ idempotency_key: key("cc0002"), conversation_id: PRIVATE, grantee_slug: "dell", granted: false });
  const back = await joe.readDocConversation({ conversation_id: PRIVATE });
  assert.deepEqual(back, before, "a share and a revoke did not return the payload to where it started");

  // And no other conversation moved at all.
  assert.deepEqual(await joe.readDocConversation({ conversation_id: SHARED }), otherBefore, "a second conversation moved");
});

/* ------------------------------------------------------------------ clause 6 */

test("clause 6: a rename moves the title and the version and retains every original message", async () => {
  const joe = await fixture();
  const before = await joe.readDocConversation({ conversation_id: PRIVATE });
  assert.equal(before.turns.length, 7);

  const built = renameArgs(before, { title: "Demo — Gulf Breeze LOI, renamed" });
  assert.equal(built.ok, true);
  assert.deepEqual(built.args, { conversation_id: PRIVATE, base_version: before.identity.version, title: "Demo — Gulf Breeze LOI, renamed" });

  const result = await joe.renameDocConversation({ idempotency_key: key("dd0001"), ...built.args });
  assert.equal(result.version, before.identity.version + 1);

  const after = await joe.readDocConversation({ conversation_id: PRIVATE });
  assert.equal(after.identity.title, "Demo — Gulf Breeze LOI, renamed");
  assert.equal(after.identity.version, before.identity.version + 1);
  // Every turn byte-identical: sequence, msg_id and body, in the server's order.
  assert.equal(after.turns.length, before.turns.length, "a rename dropped or added a turn");
  for (const [index, turn] of after.turns.entries()) {
    assert.equal(turn.sequence, before.turns[index].sequence, `turn ${index} moved its sequence`);
    assert.equal(turn.msg_id, before.turns[index].msg_id, `turn ${index} moved its msg_id`);
    assert.equal(turn.body, before.turns[index].body, `turn ${index} moved its body`);
  }
  assert.deepEqual(turnRows(after).map((row) => row.body), turnRows(before).map((row) => row.body));

  // The prior titles exist and no door reads them back, and the page says so.
  assert.match(TITLE_HISTORY_UNREADABLE, /no door reads them back yet/);
  assert.match(pageJs, /\$\("titleHistoryLine"\)\.textContent = TITLE_HISTORY_UNREADABLE/);
});

/* ------------------------------------------------------------------ clause 7 */

test("clause 7: pin and archive ride the same door, and a non-creator is refused before the swap", async () => {
  const joe = await fixture();
  const start = await joe.readDocConversation({ conversation_id: PRIVATE });

  const pinned = await joe.renameDocConversation({ idempotency_key: key("ee0001"), ...renameArgs(start, { pinned: true }).args });
  assert.ok(pinned.pinned_at, "pinning recorded no pinned_at");
  assert.equal(pinned.version, start.identity.version + 1);

  const held = await joe.readDocConversation({ conversation_id: PRIVATE });
  const archived = await joe.renameDocConversation({ idempotency_key: key("ee0002"), ...renameArgs(held, { archived: true }).args });
  assert.ok(archived.archived_at, "archiving recorded no archived_at");
  assert.equal(archived.version, held.identity.version + 1);

  // Both landed in the store, and the list door is where the page learns it:
  // the now-archived conversation leaves the default page and comes back under
  // `include_archived`, carrying its archived flag.
  const closed = listRows(await joe.listDocConversations(listArgs({})));
  assert.equal(closed.some((row) => row.id === PRIVATE), false, "an archived conversation is still in the default page");
  const opened = listRows(await joe.listDocConversations(listArgs({ includeArchived: true })));
  const back = opened.find((row) => row.id === PRIVATE);
  assert.equal(back.archived, true);
  assert.equal(back.pinned, true, "the pin did not survive the archive");

  // A grantee may READ the shared conversation and may not rename it, and the
  // refusal is raised BEFORE the comparison, so the version does not move.
  const dell = await fixture({ selfActor: "dell" });
  const seen = await dell.readDocConversation({ conversation_id: SHARED });
  assert.equal(seen.identity.title, "Demo — Crestview derm site search");
  assert.equal(await codeOf(() => dell.renameDocConversation({ idempotency_key: key("ee0003"), conversation_id: SHARED, base_version: seen.identity.version, title: "Demo — taken over" })), "doc_conversation_creator_only");
  const unmoved = await dell.readDocConversation({ conversation_id: SHARED });
  assert.equal(unmoved.identity.version, seen.identity.version, "a refused rename moved the version");
  assert.equal(unmoved.identity.title, seen.identity.title, "a refused rename moved the title");

  // No change requested is the store's own refusal, and the page's own too.
  assert.equal(await codeOf(() => joe.renameDocConversation({ idempotency_key: key("ee0004"), conversation_id: SHARED, base_version: 2 })), "doc_conversation_no_change_requested");
  assert.equal(renameArgs(start, {}).ok, false);
  assert.match(renameArgs(start, {}).message, /Nothing was sent\./);
  assert.equal(renameArgs(start, { title: "   " }).ok, false);
  assert.equal(renameArgs(null, { title: "x" }).ok, false);
  assert.notEqual(pinOperationKey(PRIVATE), archiveOperationKey(PRIVATE));
  assert.notEqual(renameOperationKey(PRIVATE), renameOperationKey(SHARED));
  assert.equal(shareOperationKey(PRIVATE, "dell"), `conversations:share:${PRIVATE}:dell`);
  assert.equal(createOperationKey(), "conversations:create");
});

/* ------------------------------------------------------------------ clause 8 */

test("clause 8: a stale base version is a conflict, is settled, and is recovered by re-reading rather than by arithmetic", async () => {
  const joe = await fixture();
  const first = await joe.readDocConversation({ conversation_id: PRIVATE });
  const stale = first.identity.version;

  await joe.renameDocConversation({ idempotency_key: key("ff0001"), conversation_id: PRIVATE, base_version: stale, title: "Demo — moved once" });

  let conflict = null;
  try {
    await joe.renameDocConversation({ idempotency_key: key("ff0002"), conversation_id: PRIVATE, base_version: stale, title: "Demo — moved twice" });
  } catch (error) {
    conflict = error;
  }
  assert.ok(conflict, "a stale base version was accepted");
  assert.equal(conflict.payload.error, "version_conflict");
  assert.equal(conflict.payload.current_version, stale + 1);

  const outcome = classifyCommandOutcome({ error: conflict });
  assert.equal(outcome.status, "conflict");
  assert.equal(outcome.reason, "version_conflict");
  // A conflict is SETTLED: the kernel drops the entry, so the next attempt is a
  // fresh intent built on a fresh read rather than a replay of a dead one.
  const opened = { ...createCommandState(), "conversations:rename:x": { operationKey: "conversations:rename:x", status: "pending" } };
  assert.equal(Object.prototype.hasOwnProperty.call(settleCommand(opened, "conversations:rename:x", outcome), "conversations:rename:x"), false);

  // The recovery is a RE-READ, and the retry carries the version the re-read
  // returned — never the one the refusal named, and never one plus anything.
  const reread = await joe.readDocConversation({ conversation_id: PRIVATE });
  assert.equal(reread.identity.version, stale + 1);
  const retry = renameArgs(reread, { title: "Demo — moved twice" });
  assert.equal(retry.args.base_version, reread.identity.version);
  const settled = await joe.renameDocConversation({ idempotency_key: key("ff0003"), ...retry.args });
  assert.equal(settled.version, stale + 2);

  assert.equal(/current_version/.test(pageJs), false, "the page can read the version the refusal carried");
  assert.equal(/base_version:\s*\w+\s*\+/.test(pageJs), false, "the page does arithmetic on a version");
  assert.match(pageJs, /if \(result\.status === "ok" \|\| result\.status === "conflict"\)/);
  assert.equal(/idempotency_key/.test(pageJs), false, "the page mints its own key instead of the kernel's");
  assert.match(pageJs, /newKey: uuidv4/);
  assert.match(pageJs, /await performCommand\(\{/);
  assert.match(pageJs, /onReconcile: \(operationKey\) => \{/);
});

/* ------------------------------------------------------------------ clause 9 */

test("clause 9: paging is honest, a late read is ignored, and the route round-trips through ?id=", async () => {
  const joe = await fixture();
  const head = await joe.readDocConversation({ conversation_id: PRIVATE, limit: 3 });
  assert.equal(head.turns.length, 3);
  assert.equal(head.more, true);
  assert.equal(head.latest_sequence, 6, "latest_sequence is the conversation's last sequence, not this page's");
  // `after_sequence` is INCLUSIVE (0520:198), so the next page starts at the
  // sequence AFTER the last one rendered. Naming the last rendered sequence
  // would ask for it a second time.
  assert.deepEqual(pagingState(head), { more: true, after: 3 });

  const tail = await joe.readDocConversation({ conversation_id: PRIVATE, after_sequence: 3, limit: 50 });
  assert.deepEqual(tail.turns.map((turn) => turn.sequence), [3, 4, 5, 6]);
  assert.equal(tail.more, false);
  assert.deepEqual(pagingState(tail), { more: false, after: null });
  assert.equal(pagingState(null).more, false);

  // The control exists only when the server said more.
  assert.match(pageJs, /\$\("pagingBlock"\)\.hidden = !paging\.more/);
  assert.match(html, /<section class="card glass" data-section="paging" id="pagingBlock"[^>]*hidden>/);

  // UX09 "stale response ignored": the guard is a sequence compared BEFORE the
  // answer is stored, on BOTH reads and on both of each read's outcomes — four
  // in all — and it is what makes Back safe.
  assert.equal([...pageJs.matchAll(/if \(view\.sequence !== sequence\) return;/g)].length, 4);
  assert.match(pageJs, /view\.sequence \+= 1;/);
  assert.match(pageJs, /globalThis\.history\?\.pushState\?\.\(\{ id \}, "", `\/conversations\?id=\$\{id\}`\)/);
  assert.match(pageJs, /globalThis\.addEventListener\?\.\("popstate"/);

  // The route itself: three answers, and the two failures differ on purpose.
  assert.deepEqual(idFromSearch(""), { state: "missing", id: null, given: null });
  assert.deepEqual(idFromSearch(`?id=${PRIVATE}`), { state: "ok", id: PRIVATE, given: PRIVATE });
  assert.equal(idFromSearch("?id=nope").state, "malformed");
  // The verb's OWN uuid shape: a nil uuid is not one, and the looser shape used
  // elsewhere in this app would have let it through.
  assert.equal(CONVERSATION_ID.test("00000000-0000-0000-0000-000000000000"), false);
  assert.equal(idFromSearch("?id=00000000-0000-0000-0000-000000000000").state, "malformed");
  assert.equal(conversationState({ state: "read", payload: null }, { state: "malformed" }).state, "malformed");

  // The eight states, each with its own evidence.
  const payload = await joe.readDocConversation({ conversation_id: PRIVATE });
  const full = { state: "read", payload, observed_at: "2026-01-15T10:00:00Z" };
  assert.equal(conversationState({ state: "pending" }).state, "loading");
  assert.equal(conversationState(full).state, "ready");
  assert.equal(conversationState({ ...full, refreshing: true }).state, "stale");
  assert.equal(conversationState({ state: "read", payload: { ...payload, turns: [], latest_sequence: -1 } }).state, "empty");
  assert.equal(conversationState({ state: "not_found" }).state, "not_found");
  assert.equal(conversationState({ state: "refused" }).state, "refused");
  assert.equal(conversationState({ state: "unavailable" }).state, "unavailable");
  assert.equal(classifyReadFailure(Object.assign(new Error("x"), { status: 403 })).state, "refused");
  assert.equal(classifyReadFailure(Object.assign(new Error("x"), { status: 401 })).state, "refused");
  assert.equal(classifyReadFailure(Object.assign(new Error("x"), { status: 503 })).state, "unavailable");
  for (const name of ["loading", "empty", "not_found", "malformed", "stale", "unavailable", "refused"]) {
    assert.ok(CONVERSATION_STATES[name].length > 0, `${name} has no sentence`);
  }
  // A refusal outranks an empty transcript: "we were not told" is not "nothing was said".
  assert.equal(conversationState({ state: "refused", payload }).state, "refused");
  const down = await fixture({ outage: "conversations" });
  await assert.rejects(() => down.readDocConversation({ conversation_id: PRIVATE }), /fixture outage/);
  // The server's own words never reach the page: only a status and a code do.
  assert.equal(/error\.message|await response\.text\(\)|error\.body/.test(pageJs), false, "the page can paint the server's words");
});

/* ----------------------------------------------------------------- clause 10 */

test("clause 10: the route, the versions, the producer pin and the five verbs are in the contracts", () => {
  assert.equal(routes.version, "1.12.0");
  assert.equal(contract.version, "1.23.0");
  assert.equal(contract.producer.source_commit, "35009e9dedab3a603836c662d0f7f12dfeb1a284");
  assert.equal(routes.routes["/conversations"], "conversations.html");
  for (const verb of ["read-doc-conversation", "list-doc-conversations", "create-doc-conversation", "rename-doc-conversation", "share-doc-conversation"]) {
    assert.ok(contract.mcp_operations.includes(verb), `${verb} is not pinned`);
  }
  // The turn verb is authorityOnly and the app holds no authority binding, so
  // pinning it would be a false contract.
  assert.equal(contract.mcp_operations.includes("add-doc-conversation-turn"), false);
  assert.equal(contract.mcp_operations.length, 60);
  assert.deepEqual(contract.mcp_operations, [...contract.mcp_operations].sort(), "the operation list is sorted");
  assert.deepEqual([...APP_ROUTE_PATHS], Object.keys(routes.routes), "the model's route list has drifted from the contract");
});

/* ------------------------------------- the list door, one test per behaviour */

test("the list is read from list-doc-conversations and rendered in the verb's order, never re-sorted", async () => {
  const joe = await fixture();
  const listed = await joe.listDocConversations(listArgs({}));
  const rows = listRows(listed);
  // Pinned first, then most recently updated — the store's order. SHARED is the
  // pinned one; REVOKED is archived and therefore absent from the default page.
  assert.deepEqual(rows.map((row) => row.id), [SHARED, SHARED_NO_GRANT, PRIVATE]);
  assert.equal(rows[0].pinned, true);
  assert.deepEqual(rows.map((row) => row.id), listed.conversations.map((row) => row.id),
    "the model re-ordered what the verb returned");
  assert.deepEqual(rows[0], {
    id: SHARED, title: "Demo — Crestview derm site search", visibility: "shared",
    pinned: true, archived: false, version: 2, latestSequence: 3,
    latestClock: rows[0].latestClock,
  });
  assert.ok(rows[0].latestClock, "the row carries no latest-turn clock");
  // The model sorts nothing: its only array operations are filter and map.
  assert.equal(/\.sort\(/.test(await read("js/conversations-model.js")), false,
    "the model sorts the list the record layer already ordered");
  assert.match(pageJs, /view\.list = \{ state: "read", payload, rows: \[\.\.\.held, \.\.\.listRows\(payload\)\] \}/);
  assert.equal(/\.sort\(/.test(pageJs), false, "the page sorts the list the record layer already ordered");
  // Nothing on this device: the roster and its storage are gone.
  assert.equal(/localStorage|sessionStorage|roster/i.test(pageJs), false, "the page still keeps a device roster");
  assert.equal(/localStorage|ROSTER_KEY/.test(await read("js/conversations-model.js")), false);
});

test("Show more passes the cursor the verb handed back, and appends the next page", async () => {
  const joe = await fixture();
  const head = await joe.listDocConversations({ limit: 2 });
  assert.equal(head.conversations.length, 2);
  assert.equal(head.more, true);
  assert.equal(typeof head.next_cursor, "string");
  assert.deepEqual(listPagingState(head), { more: true, cursor: head.next_cursor });

  const tail = await joe.listDocConversations({ limit: 2, cursor: head.next_cursor });
  assert.deepEqual(listRows(tail).map((row) => row.id), [PRIVATE]);
  assert.equal(tail.more, false);
  assert.deepEqual(listPagingState(tail), { more: false, cursor: null });
  // A `more` with no cursor is not a page this client can ask for: there is no
  // offset and no page number to fall back on.
  assert.deepEqual(listPagingState({ conversations: [], more: true, next_cursor: null }), { more: false, cursor: null });
  assert.deepEqual(listPagingState(null), { more: false, cursor: null });

  // The cursor is OPAQUE: it is passed back unread, never parsed or built here.
  assert.deepEqual(listArgs({ cursor: head.next_cursor }), { limit: LIST_PAGE_SIZE, cursor: head.next_cursor });
  assert.equal(/next_cursor.*(?:split|slice|JSON\.parse|atob)/.test(pageJs), false, "the page reads inside the cursor");
  assert.match(pageJs, /if \(paging\.more\) takeList\(\{ cursor: paging\.cursor \}\)/);
  assert.match(pageJs, /\$\("listPagingBlock"\)\.hidden = !listPagingState\(payload\)\.more/);
  assert.match(html, /<div class="note-act" id="listPagingBlock" hidden><button class="btn" type="button" id="showMoreConversations">/);
  // Paging APPENDS, in one sequence across pages.
  assert.match(pageJs, /const held = cursor \? view\.list\.rows : \[\];/);
});

test("Show archived is the verb's include_archived, and pressing it costs a fresh read", async () => {
  const joe = await fixture();
  const plain = await joe.listDocConversations(listArgs({}));
  assert.equal(listRows(plain).some((row) => row.id === REVOKED), false, "the archived conversation is in the default page");

  const withArchived = await joe.listDocConversations(listArgs({ includeArchived: true }));
  const rows = listRows(withArchived);
  assert.ok(rows.some((row) => row.id === REVOKED && row.archived === true), "include_archived did not bring the archived one back");
  assert.equal(rows.length, 4);

  assert.deepEqual(listArgs({ includeArchived: true }), { limit: LIST_PAGE_SIZE, include_archived: true });
  // False is OMITTED rather than sent: the verb's default is the exclusion, and
  // naming it would be this page restating a rule it does not own.
  assert.deepEqual(listArgs({ includeArchived: false }), { limit: LIST_PAGE_SIZE });
  // The toggle is not a filter over rows already held: it re-reads.
  assert.match(pageJs, /view\.includeArchived = !view\.includeArchived;\s*\n\s*view\.sequence \+= 1;\s*\n\s*takeList\(\);/);
  assert.match(pageJs, /listArgs\(\{ cursor, includeArchived: view\.includeArchived \}\)/);
  assert.match(html, /<button class="btn" type="button" id="archivedToggle" aria-pressed="false">Show archived<\/button>/);
});

test("after a create the list is read again, and so it is after rename, pin, archive and share", async () => {
  const joe = await fixture();
  const before = listRows(await joe.listDocConversations(listArgs({})));
  assert.equal(before.length, 3);

  const made = await joe.createDocConversation({ idempotency_key: key(1), title: "Demo — a brand new one" });
  const after = listRows(await joe.listDocConversations(listArgs({})));
  assert.equal(after.length, 4);
  assert.ok(after.some((row) => row.id === made.conversation_id), "a fresh list read does not carry the new conversation");

  // A pin moves it to the front of the SAME read, which is why the page re-reads
  // rather than patching the row it is holding.
  await joe.renameDocConversation({ idempotency_key: key(2), conversation_id: made.conversation_id, base_version: 1, pinned: true });
  const pinned = listRows(await joe.listDocConversations(listArgs({})));
  const at = pinned.findIndex((row) => row.id === made.conversation_id);
  assert.equal(pinned[at].pinned, true);
  assert.ok(pinned.slice(at + 1).every((row) => row.pinned === false), "a pinned conversation sits behind an unpinned one");
  await joe.renameDocConversation({ idempotency_key: key(3), conversation_id: made.conversation_id, base_version: 2, archived: true });
  assert.equal(listRows(await joe.listDocConversations(listArgs({}))).some((row) => row.id === made.conversation_id), false,
    "an archived conversation is still in the default page");

  // The page's own wiring: every settled write re-reads, and load() reads BOTH
  // (plus V5-UX-B09's independently-sequenced outcome cards read).
  assert.match(pageJs, /await Promise\.all\(\[takeConversation\(\), takeList\(\), takeOutcomeCards\(\)\]\)/);
  assert.match(pageJs, /if \(result\.status === "ok" \|\| result\.status === "conflict"\) \{/);
  assert.match(pageJs, /await load\(\);/);
  // Create opens the new conversation, and open() runs the same load().
  assert.match(pageJs, /open\(result\.response\.conversation_id\);/);
  assert.match(pageJs, /function open\(id\) \{[\s\S]*?load\(\);\n\}/);
});

test("the list request carries exactly cursor, limit and include_archived — and never an actor", async () => {
  const allowed = new Set(["cursor", "limit", "include_archived"]);
  for (const built of [listArgs({}), listArgs({ cursor: "c" }), listArgs({ includeArchived: true }), listArgs({ cursor: "c", includeArchived: true })]) {
    for (const name of Object.keys(built)) assert.ok(allowed.has(name), `the request carries ${name}`);
    assert.equal(built.limit, LIST_PAGE_SIZE);
    for (const name of ["actor", "actor_slug", "acting_actor", "partner", "created_by", "offset", "sort"]) {
      assert.equal(name in built, false, `the request names ${name}`);
    }
  }
  // The verb derives the acting actor itself, so an actor field would be a
  // schema error rather than a refusal the page could explain. Nothing in the
  // model or the page offers one.
  const modelJs = await read("js/conversations-model.js");
  const liveJs = await read("js/live-client.js");
  assert.equal(/actor/.test(JSON.stringify(listArgs({ cursor: "c", includeArchived: true }))), false);
  assert.equal(/listArgs\([^)]*actor/.test(modelJs + pageJs), false, "an actor reaches the list request");
  assert.match(liveJs, /async listDocConversations\(args = \{\}\) \{ return rpc\('list-doc-conversations', args\); \}/);
  assert.equal(/list-doc-conversations'[^)]*actor/.test(liveJs), false);
  // And the live answer is the same for both partners' own lists: each sees its
  // own, because neither one asked.
  const dell = await fixture({ selfActor: "dell" });
  assert.deepEqual(listRows(await dell.listDocConversations(listArgs({}))).map((row) => row.id), [SHARED]);
});

test("an empty list says so, and says nothing about this device", async () => {
  // An actor who created nothing and holds no grant gets an EMPTY list, not a
  // refusal: "you may see none" is an answer, and the page renders it as one.
  const stranger = await fixture({ selfActor: "someone-else" });
  const empty = await stranger.listDocConversations(listArgs({}));
  assert.deepEqual(empty.conversations, []);
  assert.equal(empty.more, false);
  assert.equal(empty.next_cursor, null);
  assert.deepEqual(listRows(empty), []);
  assert.equal(visibleCountLine(empty), "You can see 0 conversations.");

  assert.equal(LIST_EMPTY, "You have no conversation yet. Create one below.");
  assert.equal(/device|remember|roster/i.test(LIST_EMPTY), false, "the empty state still talks about this device");
  assert.equal(/device remembers|opened on this device|no door that lists/i.test(LIST_SCOPE + EXPOSURE_STATEMENT + html), false,
    "the page still claims the record layer cannot list conversations");
  assert.match(pageJs, /const bare = view\.list\.state === "read" && rows\.length === 0;/);
  assert.match(pageJs, /\$\("listStateTitle"\)\.textContent = view\.list\.state === "unavailable"/);
  assert.match(html, /<div class="state-block" id="listState" data-state="loading" hidden><h3 id="listStateTitle"><\/h3><\/div>/);
});

/* ---------------------------------------- the shell, the missing composer, 360px */

test("the page is the shared shell, carries no composer in the transcript, and holds 44px at 360px", async () => {
  assert.match(html, /<title>Conversations · DoctorCRE<\/title>/);
  assert.match(html, /<a href="\/conversations" aria-current="page">Conversations<\/a>/);
  assert.match(html, /data-theme="dark" data-density="comfortable" data-motion="full"/);
  assert.match(html, /<meta name="theme-color" content="#07111f">/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/system\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/conversations\.css">/);
  assert.match(html, /<button class="doc-fab" type="button" id="docFab"/);
  assert.equal([...html.matchAll(/class="doc-chat glass" id="docChat"/g)].length, 1, "Doc appears once");
  assert.match(html, /<div id="receiptDock" class="receipt-dock"/, "the dock is not mounted");
  assert.match(html, /<p id="prefsLive" class="sr-only" aria-live="polite">/);
  assert.doesNotMatch(html, /<p class="(?:intro|lede|description)"/);
  assert.doesNotMatch(html, /\bTODO\b/);
  for (const match of html.replace(/\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/g, "<iso>").matchAll(/\b\d{1,2}:\d{2}\b(.{0,4})/g)) {
    assert.match(match[1], /^\s*(AM|PM)/, `"${match[0]}" prints without AM or PM`);
  }

  // No composer, and not a disabled one either: a dead widget looks like a
  // capability, and there is no door behind it until B08.
  const region = /<section class="card glass" data-section="turns"[\s\S]*?<\/section>/.exec(html);
  assert.ok(region, "the transcript region is missing");
  for (const tag of ["input", "select", "button", "textarea", "form"]) {
    assert.equal(new RegExp(`<${tag}[\\s>]`).test(region[0]), false, `the transcript region draws a <${tag}>`);
  }
  assert.match(COMPOSER_ABSENT, /reserved for an authority session/);
  assert.match(DOC_REPLY_PENDING, /arrive in the next slice/);
  assert.match(pageJs, /\$\("composerAbsent"\)\.textContent = COMPOSER_ABSENT/);
  assert.equal(/add-doc-conversation-turn|addDocConversationTurn/.test(pageJs), false, "the page reaches for the authority-only verb");
  assert.equal(/add-doc-conversation-turn/.test(html), false);

  // Private versus shared carries a word and a glyph, never a hue alone.
  const shared = identityHeader({ identity: { id: SHARED, title: "t", visibility: "shared", pinned_at: null, archived_at: null, version: 1, created_by: "joe" }, turns: [], effective_grants: [{ grantee_actor: "dell", granted_at: "2026-09-11T08:46:00.000Z", granted_by_actor: "joe" }], visible_conversation_count: 1 });
  assert.equal(shared.word, "Shared — dell");
  assert.equal(shared.glyph, "🔓");
  const joe = await fixture();
  const priv = identityHeader(await joe.readDocConversation({ conversation_id: PRIVATE }));
  assert.equal(priv.word, "Private — only you");
  assert.equal(priv.glyph, "🔒");
  assert.match(css, /\.visibility-badge\[data-visibility="private"\]/);
  assert.match(css, /\.visibility-badge\[data-visibility="shared"\]/);

  // Mobile first: one column, full-width targets, the 44px floor, no scrollbar.
  assert.match(css, /\.btn \{ min-height: var\(--touch\); \}/);
  assert.match(css, /\.field input, \.field select \{ min-height: var\(--touch\); \}/);
  assert.match(css, /\.visibility-badge \{[^}]*min-height: var\(--touch\);/);
  assert.match(css, /\.action-row \.btn \{ width: 100%; \}/);
  assert.match(css, /\.turn-list \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /\.turn-body \{[^}]*overflow-wrap: anywhere;/);
  assert.equal(/[^-]width:\s*\d{3,}px/.test(css), false, "a fixed pixel width can force a horizontal scroll");
  assert.match(EXPOSURE_STATEMENT, /on a shared or unlocked phone/);
  assert.match(EXPOSURE_STATEMENT, /Nothing is kept on this device/);
  assert.match(EXPOSURE_STATEMENT, /the list above names every conversation you can see/);
  assert.match(html, /<p class="caption" id="exposureStatement">/);
});

/* ------------------------------------------------------------------- escaping */

test("a hostile turn body renders as text, and create refuses what the verb refuses", async () => {
  const joe = await fixture();
  const payload = await joe.readDocConversation({ conversation_id: PRIVATE });
  const bodies = turnRows(payload).map((row) => row.body);
  assert.ok(bodies.some((body) => body.includes("<script>alert(1)</script>")), "the fixture holds no script body");
  assert.ok(bodies.some((body) => body.includes('"><img onerror=')), "the fixture holds no attribute-breaking body");
  // The model hands the body over verbatim; the page is the only place that
  // may put it into markup, and it never does so without escaping it.
  assert.match(pageJs, /<p class="turn-body">\$\{escapeHtml\(turn\.body\)\}<\/p>/);
  assert.equal(/innerHTML = [^;]*turn\.body(?!\))/.test(pageJs), false, "a turn body reaches innerHTML unescaped");
  assert.match(pageJs, /const escapeHtml = \(value\) =>/);

  // Create: the key is the kernel's and becomes the id, and the title rules are
  // the verb's own.
  assert.equal(createArgs({ title: "  Demo — a new one  " }).args.title, "Demo — a new one");
  assert.equal(createArgs({ title: "Demo", visibility: "shared" }).args.visibility, "shared");
  assert.equal(createArgs({ title: "Demo", visibility: "everyone" }).args.visibility, "private");
  assert.equal(createArgs({ title: "   " }).ok, false);
  assert.equal(createArgs({ title: "x".repeat(201) }).ok, false);
  assert.equal(createArgs({ title: "x".repeat(200) }).ok, true);

  const made = await joe.createDocConversation({ idempotency_key: key("120001"), title: "Demo — minted here", visibility: "private" });
  assert.equal(made.conversation_id, key("120001"), "the key did not become the conversation id");
  assert.equal((await joe.readDocConversation({ conversation_id: made.conversation_id })).identity.title, "Demo — minted here");
  // A replay under the same key returns the stored answer; a DIFFERENT payload
  // under that key is `key_reuse`, which is what the envelope answers.
  assert.deepEqual(await joe.createDocConversation({ idempotency_key: key("120001"), title: "Demo — minted here", visibility: "private" }), made);
  assert.equal(await codeOf(() => joe.createDocConversation({ idempotency_key: key("120001"), title: "Demo — something else", visibility: "private" })), "key_reuse");
  assert.equal(await codeOf(() => joe.createDocConversation({ title: "Demo — no key" })), "missing_idempotency_key");
  assert.equal(await codeOf(() => joe.createDocConversation({ idempotency_key: "not-a-uuid", title: "Demo — bad key" })), "doc_conversation_idempotency_key_invalid");
  assert.equal(await codeOf(() => joe.createDocConversation({ idempotency_key: key("120002"), title: "   " })), "doc_conversation_title_invalid");
  assert.equal(validDocConversationPayload(payload), true);
  assert.equal(validDocConversationPayload({ identity: { id: PRIVATE, title: "t", version: 0 } }), false);
  assert.equal(shareArgs("not-a-uuid", "dell", true).ok, false);
  assert.deepEqual(shareArgs(PRIVATE, " dell ", true).args, { conversation_id: PRIVATE, grantee_slug: "dell", granted: true });
});

/* ------------------------------------------- B1: the store's paging predicate */

test("clause 9b: after_sequence is INCLUSIVE, so the next page starts at last+1 and the boundary turn renders exactly once", async () => {
  const joe = await fixture();

  // The store's own predicate, pinned directly: asking AT a sequence returns
  // that sequence. This is the assertion the first build got backwards, and it
  // is what makes the `+ 1` in `pagingState` load-bearing rather than cosmetic.
  const atBoundary = await joe.readDocConversation({ conversation_id: PRIVATE, after_sequence: 2, limit: 50 });
  assert.deepEqual(atBoundary.turns.map((turn) => turn.sequence), [2, 3, 4, 5, 6],
    "after_sequence is being treated as exclusive; the record layer selects `sequence >= v_after` (0520:198)");
  assert.equal(atBoundary.turns[0].sequence, 2, "the boundary turn was not returned");

  // 0520:182: the argument is clamped at zero, and a missing one is zero — so a
  // first page and an explicit 0 are the same page, and neither drops turn 0.
  const first = await joe.readDocConversation({ conversation_id: PRIVATE, limit: 50 });
  assert.equal(first.turns[0].sequence, 0, "the first page dropped turn 0");
  assert.deepEqual((await joe.readDocConversation({ conversation_id: PRIVATE, after_sequence: 0, limit: 50 })).turns.map((t) => t.sequence), first.turns.map((t) => t.sequence));
  assert.deepEqual((await joe.readDocConversation({ conversation_id: PRIVATE, after_sequence: -5, limit: 50 })).turns.map((t) => t.sequence), first.turns.map((t) => t.sequence));

  // Now the page's own arithmetic, end to end: read a page, take the offset the
  // model hands the page, read the next page, merge the way the page merges —
  // and assert EVERY sequence appears exactly once. A page whose whole job is
  // "original messages retained" must not show a message that was said once twice.
  const head = await joe.readDocConversation({ conversation_id: PRIVATE, limit: 3 });
  const offset = pagingState(head);
  assert.equal(offset.more, true);
  assert.equal(offset.after, head.turns[head.turns.length - 1].sequence + 1);
  const next = await joe.readDocConversation({ conversation_id: PRIVATE, after_sequence: offset.after, limit: 50 });
  const merged = [...head.turns, ...next.turns].map((turn) => turn.sequence);
  assert.deepEqual(merged, [0, 1, 2, 3, 4, 5, 6], "the merged transcript is not the conversation");
  assert.equal(new Set(merged).size, merged.length, "a turn was rendered twice across the page boundary");
  const boundary = merged.filter((sequence) => sequence === 2);
  assert.equal(boundary.length, 1, "the boundary turn was rendered twice");

  // And the merge in the page is the plain append this test just modelled: no
  // de-duplication layer hides a wrong offset.
  assert.match(pageJs, /\{ \.\.\.payload, turns: \[\.\.\.held\.turns, \.\.\.payload\.turns\] \}/);
  assert.match(pageJs, /if \(Number\.isInteger\(after\)\) args\.after_sequence = after;/);
});

/* ------------------------------ B2: a shared create writes a header, no grant */

test("clause 3b: a shared create writes one header row and NO grant, so the partner is refused until an explicit share", async () => {
  const joe = await fixture();
  const dell = await fixture({ selfActor: "dell" });

  // The seeded twin of what every shared create produces: header `shared`,
  // grant table empty. It is seeded because a conversation created inside one
  // fixture client exists only in that client's store, so the cross-actor half
  // of this proof needs a row both clients hold.
  const mine = await joe.readDocConversation({ conversation_id: SHARED_NO_GRANT });
  assert.equal(mine.identity.visibility, "shared", "the stored visibility column was not carried");
  assert.deepEqual(mine.effective_grants, [], "a grant exists that the record layer never writes");
  assert.deepEqual(accessRows(mine), []);

  // The partner is REFUSED. The read door gates on creator-or-unrevoked-grant
  // (0520:186-189); a header that says shared is not a grant. This is the
  // assertion that a fabricated create-grant made impossible: in demo mode the
  // page would have shown him holding a read production refuses him.
  assert.equal(await codeOf(() => dell.readDocConversation({ conversation_id: SHARED_NO_GRANT })),
    "doc_conversation_not_found", "a shared-at-birth conversation was readable without a grant");
  assert.equal((await dell.readDocConversation({ conversation_id: SHARED })).visible_conversation_count, 1,
    "the shared-at-birth conversation leaked into the partner's authorized count");

  // The page renders that state honestly rather than naming somebody.
  const header = identityHeader(mine);
  assert.equal(header.visibility, "shared");
  assert.equal(header.word, "Shared — no one right now");
  assert.equal(header.glyph, "🔓");
  assert.deepEqual(shareCandidates(mine, PARTNER_SLUGS), [{ slug: "dell", granted: false }]);

  // An explicit share is what actually lets him in, and it is the only thing that does.
  await joe.shareDocConversation({ idempotency_key: key("5ba7ee"), conversation_id: SHARED_NO_GRANT, grantee_slug: "dell", granted: true });
  assert.deepEqual(accessRows(await joe.readDocConversation({ conversation_id: SHARED_NO_GRANT })).map((row) => row.grantee), ["dell"]);

  // And the create path itself reaches exactly that shape: header shared, no grant.
  const made = await joe.createDocConversation({ idempotency_key: key("5ba7ed"), title: "Demo — shared at birth", visibility: "shared" });
  assert.equal(made.visibility, "shared");
  const born = await joe.readDocConversation({ conversation_id: made.conversation_id });
  assert.equal(born.identity.visibility, "shared");
  assert.deepEqual(born.effective_grants, [], "the create fabricated a grant the record layer never writes");
  assert.equal(identityHeader(born).word, "Shared — no one right now");

  // Visibility is a STORED column, not a derivation: a private create is private
  // with no grants, and a revoke recomputes it back from what is left unrevoked.
  const priv = await joe.createDocConversation({ idempotency_key: key("5ba7ef"), title: "Demo — private at birth", visibility: "private" });
  const privRead = await joe.readDocConversation({ conversation_id: priv.conversation_id });
  assert.equal(privRead.identity.visibility, "private");
  assert.deepEqual(privRead.effective_grants, []);
  await joe.shareDocConversation({ idempotency_key: key("5ba7f0"), conversation_id: SHARED_NO_GRANT, grantee_slug: "dell", granted: false });
  assert.equal((await joe.readDocConversation({ conversation_id: SHARED_NO_GRANT })).identity.visibility, "private",
    "a revoke did not recompute the stored column");
  assert.equal(await codeOf(() => joe.createDocConversation({ idempotency_key: key("5ba7f1"), title: "Demo — bad visibility", visibility: "everyone" })), "doc_conversation_visibility_invalid");

  // The fixture must CARRY the column, never derive it from the grant list.
  assert.equal(/visibility: docLiveGrants\(row\)|const docVisibility =/.test(fixtureJs), false,
    "visibility is derived from the grants again; the shared-with-zero-grants state becomes unrepresentable");
});
