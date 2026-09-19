import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFixtureClient } from "../js/fixture-client.js";
import { createLiveClient } from "../js/live-client.js";

const required = ["getBoard", "getDeal", "getChanges", "presenceLease", "patchDealField", "resolveConflict", "addDealNote", "setNextStep", "addCriticalDate", "createDeal", "loopBoard", "readLoop", "addLoop", "updateLoop", "closeLoop", "loopHeaders", "commandCenter", "engineeringPassport", "readPortfolio", "workRequestCard", "declineWorkRequest", "supersedeWorkRequest", "setWorkShapeDisposition", "incidentBoard", "currentWorkItem", "currentWorkRequests", "getIncident", "linkIncidentWorkRequest", "notificationFeed", "acknowledgeNotification", "notificationPreferences", "setNotificationPreference", "readDocConversation", "listDocConversations", "createDocConversation", "renameDocConversation", "shareDocConversation"];

test("synthetic and live adapters satisfy the same DealRoomClient interface", async () => {
  const fixtureText = await readFile(new URL("../data/board-seed.json", import.meta.url), "utf8");
  const fixture = await createFixtureClient({seedUrl:`data:application/json;base64,${Buffer.from(fixtureText).toString("base64")}`});
  const live = createLiveClient({fetchImpl: async () => new Response(JSON.stringify({result:{content:[{text:JSON.stringify({actor:"joe",deals:[]})}]}}), {status:200,headers:{"content-type":"application/json"}})});
  for (const adapter of [fixture, live]) for (const method of required) assert.equal(typeof adapter[method], "function", `${adapter.mode}.${method}`);
  assert.equal(fixture.mode, "fixture");
  assert.equal(live.mode, "live");
  assert.ok((await fixture.getBoard()).deals.every((deal) => deal.name.startsWith("Demo ")));
  assert.deepEqual((await live.getBoard()).deals, []);
});

test("the live adapter uses the pinned MCP seam rather than a database", async () => {
  const calls = [];
  const live = createLiveClient({fetchImpl: async (path, init) => {
    calls.push({path, init});
    return new Response(JSON.stringify({result:{content:[{text:JSON.stringify({actor:"joe",deals:[]})}]}}), {status:200});
  }});
  await live.getBoard();
  assert.equal(calls[0].path, "/mcp");
  assert.equal(JSON.parse(calls[0].init.body).params.name, "deal-room-board");
  assert.equal(calls[0].init.credentials, "same-origin");
});
