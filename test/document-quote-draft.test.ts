import assert from "node:assert/strict";
import test from "node:test";
import { createAskOutbox } from "../src/ui/queued-asks.ts";

function setup() {
  const data = new Map<string, string>();
  let writes = 0;
  let fail = false;
  const storage: Storage = {
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (fail) throw Error("quota");
      writes++;
      data.set(key, value);
    },
    removeItem: (key: string) => data.delete(key),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  const options = {
    storage,
    actor: "quote-test",
    conversation: "00000000-0000-4000-8000-000000000001",
    online: () => false,
    uuid: () => "00000000-0000-4000-8000-000000000002",
    submit: async () => ({}),
  };
  return {
    box: createAskOutbox(options),
    other: () => createAskOutbox(options),
    get writes() {
      return writes;
    },
    fail: () => {
      fail = true;
    },
  };
}
test("insert saves once before success and refuses concurrent replacement", () => {
  const state = setup();
  state.box.saveDraft("existing");
  const other = state.other();
  const before = state.writes;
  assert.equal(state.box.appendDraft("quote", "existing"), "existing\n\nquote");
  assert.equal(state.writes, before + 1);
  assert.throws(() => other.appendDraft("other", "existing"), /another tab/);
  assert.equal(state.box.draft(), "existing\n\nquote");
});
test("storage failure, retirement and final body overflow preserve draft", () => {
  const state = setup();
  state.box.saveDraft("existing");
  assert.throws(() => state.box.appendDraft("x".repeat(20000), "existing"), /20,000/);
  state.fail();
  assert.throws(() => state.box.appendDraft("quote", "existing"), /quota/);
  assert.equal(state.box.draft(), "existing");
  state.box.stop();
  assert.throws(() => state.box.appendDraft("quote", "existing"), /closed/);
});
test("queued quote body and key survive reload unchanged", () => {
  const state = setup();
  state.box.saveDraft("existing");
  state.box.appendDraft("quote", "existing");
  const request = state.box.enqueue();
  const reloaded = state.other();
  assert.equal(request.body, "existing\n\nquote");
  assert.deepEqual(reloaded.entries()[0]?.request, request);
  assert.equal(Object.isFrozen(request), true);
});

test("a draft saved between insertion guard and write is never discarded", async () => {
  const data = new Map<string, string>();
  let interleave: (() => void) | undefined;
  const storage: Storage = {
    clear: () => data.clear(),
    getItem(key) {
      const value = data.get(key) ?? null;
      interleave?.();
      return value;
    },
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
    key: (index) => [...data.keys()][index] ?? null,
    get length() { return data.size; },
  };
  const options = { storage, actor: "race-test", conversation: "00000000-0000-4000-8000-000000000001",
    online: () => false, uuid: () => "00000000-0000-4000-8000-000000000002", submit: async () => ({}) };
  const a = createAskOutbox(options);
  await a.saveDraft("original");
  const b = createAskOutbox(options);
  let reads = 0;
  let competing: Promise<void> | undefined;
  interleave = () => {
    if (++reads === 2) {
      interleave = undefined;
      competing = Promise.resolve(b.saveDraft("new draft from tab B"));
    }
  };
  await a.appendDraft("quote", "original");
  await competing;
  assert.equal(a.draft(), "new draft from tab B");
});
