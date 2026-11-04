import test from "node:test";

import assert from "node:assert/strict";

import { readFile } from "node:fs/promises";

import { createPlannerClient } from "../tours/planner-client.js";

const clientA = "11111111-1111-4111-8111-111111111111", clientB = "22222222-2222-4222-8222-222222222222";

const record = id => ({ id, name: id === clientA ? "Demo Practice A" : "Demo Practice B", city: "Demo City", state: "FL", vertical: "Demo specialty", notes: "Synthetic original entry" });

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test("client lookup reads one producer page with an encoded search and verifies identity", async () => {
  const calls = []; const api = createPlannerClient({ fetchImpl: async path => {
    calls.push(path); return { ok: true, json: async () => path.includes(clientA) ? { record: record(clientB) } : { page: Number(new URL(path, "https://example.test").searchParams.get("page")), page_count: 2, rows: [record(clientA)] } };
  } });
  assert.equal((await api.clients({ query: "Demo & Harbor" })).length, 1); assert.equal(calls.length, 1);
  assert.match(calls[0], /scope=team&sort=name&page=1/); assert.equal(new URL(calls[0], "https://example.test").searchParams.get("q"), "Demo & Harbor");
  await assert.rejects(api.client(clientA), /mismatch/);
  await assert.rejects(api.client("-".repeat(36)), /Invalid/);
  assert.deepEqual(api.capabilities, { compile: false, mls: false });
});

test("known-scope client answers cannot cross an account transition", async () => {
  const pendingClients = deferred(); let token = "synthetic-A", clientReads = 0;
  const api = createPlannerClient({ fetchImpl: async path => ({
    ok: true, json: () => {
      if (path.includes("library")) return { csrf_token: token, data: { tours: [] } };
      clientReads++; return pendingClients.promise;
    },
  }) });
  await api.library();
  const clients = api.clients();
  token = "synthetic-B"; await api.library();
  const scopeB = api.scope;
  pendingClients.resolve({ page: 1, page_count: 1, rows: [record(clientA)] });
  await assert.rejects(clients, /Session superseded/);
  assert.equal(api.scope, scopeB); assert.equal(clientReads, 1);
});

test("the initial client re-read still refuses a later account transition", async () => {
  const unscoped = deferred(), scoped = deferred(), rereadStarted = deferred();
  let token = "synthetic-A", clientReads = 0;
  const api = createPlannerClient({ fetchImpl: async path => ({
    ok: true, json: () => {
      if (path.includes("library")) return { csrf_token: token, data: { tours: [] } };
      if (++clientReads === 1) return unscoped.promise;
      rereadStarted.resolve(); return scoped.promise;
    },
  }) });
  const clients = api.clients(); await api.library();
  unscoped.resolve({ page: 1, page_count: 1, rows: [record(clientA)] });
  await rereadStarted.promise;
  token = "synthetic-B"; await api.library(); const scopeB = api.scope;
  scoped.resolve({ page: 1, page_count: 1, rows: [record(clientA)] });
  await assert.rejects(clients, /Session superseded/);
  assert.equal(api.scope, scopeB); assert.equal(clientReads, 2);
});

test("late transport response cannot roll the adapter back to an earlier session", async () => {
  const old = deferred(); let body = { csrf_token: "synthetic-A", data: { tours: [] } };
  const api = createPlannerClient({ fetchImpl: async () => ({ ok: true, json: () => body }) });
  await api.library(); body = old.promise; const pending = api.library(); await settle();
  body = { csrf_token: "synthetic-B", data: { tours: [] } }; await api.library(); const scopeB = api.scope;
  old.resolve({ csrf_token: "synthetic-A", data: { tours: [] } }); await assert.rejects(pending, /session|superseded/i);
  assert.equal(api.scope, scopeB);
});

test("timed-out decoding cannot later change the adapter session", async () => {
  const late = deferred(); const api = createPlannerClient({ timeoutMs: 5, fetchImpl: async () => ({ ok: true, json: () => late.promise }) });
  await assert.rejects(api.library(), error => error.code === "read_timeout");
  late.resolve({ csrf_token: "late-session", data: { tours: [] } }); await settle(); await settle();
  assert.equal(api.scope, null);
});

test("adapter rejects malformed list members and consumed detail shapes", async () => {
  let body = { tours: [null] }; const api = createPlannerClient({ fetchImpl: async () => ({ ok: true, json: async () => body }) });
  await assert.rejects(api.library(), /Invalid/);
  body = { id: clientA, stops: [null] }; await assert.rejects(api.tour(clientA), /Invalid/);
  body = { id: clientA, stops: [], routes: [null] }; await assert.rejects(api.tour(clientA), /Invalid/);
  body = { tours: [{ id: clientA, status: {} }] }; await assert.rejects(api.library(), /Invalid/);
  body = { rows: [null], page: 1, page_count: 1 }; await assert.rejects(api.clients(), /Invalid/);
});

test("caller cancellation prevents late decoding from changing the authenticated session", async () => {
  const late = deferred(); let body = { csrf_token: "synthetic-A", data: { tours: [] } };
  const api = createPlannerClient({ fetchImpl: async () => ({ ok: true, json: () => body }) });
  await api.library(); const original = api.scope, controller = new AbortController(); body = late.promise;
  const pending = api.library({ signal: controller.signal }); await settle(); controller.abort();
  late.resolve({ csrf_token: "synthetic-B", data: { tours: [] } });
  await assert.rejects(pending, error => error.code === "read_timeout"); await settle(); assert.equal(api.scope, original);
});
