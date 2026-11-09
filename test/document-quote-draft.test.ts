import assert from "node:assert/strict";
import test from "node:test";
import { createAskOutbox } from "../src/ui/queued-asks.ts";

function setup(locks: Pick<LockManager, "request"> | null = navigator.locks) {
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
    locks,
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
test("insert saves once before success and refuses concurrent replacement", async () => {
  const state = setup();
  await state.box.saveDraft("existing");
  const other = state.other();
  const before = state.writes;
  assert.equal(await state.box.appendDraft("quote", "existing"), "existing\n\nquote");
  assert.equal(state.writes, before + 1);
  await assert.rejects(() => other.appendDraft("other", "existing"), /another tab/);
  assert.equal(state.box.draft(), "existing\n\nquote");
});
test("storage failure, retirement and final body overflow preserve draft", async () => {
  const state = setup();
  await state.box.saveDraft("existing");
  await assert.rejects(() => state.box.appendDraft("x".repeat(20000), "existing"), /20,000/);
  state.fail();
  await assert.rejects(() => state.box.appendDraft("quote", "existing"), /quota/);
  assert.equal(state.box.draft(), "existing");
  state.box.stop();
  await assert.rejects(() => state.box.appendDraft("quote", "existing"), /closed/);
});
test("queued quote body and key survive reload unchanged", async () => {
  const state = setup();
  await state.box.saveDraft("existing");
  await state.box.appendDraft("quote", "existing");
  const request = await state.box.enqueue();
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
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
  const options = {
    storage,
    actor: "race-test",
    conversation: "00000000-0000-4000-8000-000000000001",
    online: () => false,
    uuid: () => "00000000-0000-4000-8000-000000000002",
    submit: async () => ({}),
  };
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
  assert.equal(await a.appendDraft("quote", "original"), "original\n\nquote");
  await competing;
  assert.equal(a.draft(), "new draft from tab B");
});

test("missing cross-tab locks refuse all draft mutations", async () => {
  const { box, writes } = setup(null);
  await assert.rejects(() => box.saveDraft("keep on page"), /Safe device storage/);
  await assert.rejects(() => box.appendDraft("quote", ""), /Safe device storage/);
  await assert.rejects(() => box.enqueue("keep on page"), /Safe device storage/);
  assert.equal(box.draft(), "");
  assert.equal(writes, 0);
  assert.deepEqual(box.entries(), []);
});
test("retirement while waiting for the draft lock refuses insertion", async () => {
  const { box } = setup();
  await box.saveDraft("existing");
  const acquired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = navigator.locks.request(
    "doctorcre:asks:v1:quote-test:00000000-0000-4000-8000-000000000001:draft",
    async () => {
      acquired.resolve();
      await release.promise;
    },
  );
  await acquired.promise;
  const insertion = box.appendDraft("quote", "existing");
  box.stop();
  release.resolve();
  await holder;
  await assert.rejects(() => insertion, /closed/);
  assert.equal(box.draft(), "existing");
});
