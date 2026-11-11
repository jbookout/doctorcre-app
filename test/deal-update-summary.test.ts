import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createDealUpdateSummary, parseDealUpdateSummary } from "../src/ui/deal-update-summary-model.ts";

const recorded = JSON.parse(
  await readFile(new URL("../contracts/deal-update-summary.v1/fixture.json", import.meta.url), "utf8"),
);
const deal = recorded.deal_id;
const response = (revision = "a", cursor: string | null = null) => ({
  ...structuredClone(recorded),
  source_revision: revision,
  history: { ...structuredClone(recorded.history), revision, next_cursor: cursor },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("producer recording passes parser; unknown enums, wrong deal and revision refuse", () => {
  assert.equal(parseDealUpdateSummary(recorded, deal).summary.text, recorded.summary.text);
  for (const value of [
    { ...recorded, deal_id: "other" },
    { ...recorded, coverage: { ...recorded.coverage, complete: true } },
    {
      ...recorded,
      coverage: { ...recorded.coverage, complete: true, unsupported_events_present: false, read_count_lower_bound: 9 },
    },
    { ...recorded, summary: { ...recorded.summary, method: "invented" } },
    { ...recorded, history: { ...recorded.history, revision: "different" } },
    { ...recorded, history: { ...recorded.history, entries: [{ ...recorded.history.entries[0], source: "future" }] } },
  ])
    assert.throws(() => parseDealUpdateSummary(value, deal));
});
test("summary and history load independently; ordinary continuation failure keeps rows and retries", async () => {
  let fail = false;
  let calls = 0;
  const view = createDealUpdateSummary({
    dealId: deal,
    read: async (args) => {
      calls++;
      if (fail) throw Error("offline");
      const v = response("a", args.cursor ? null : "older");
      if (args.cursor) v.history.entries = [];
      return v;
    },
    changed() {},
  });
  await view.refresh();
  assert.equal(view.state().summary.kind, "ready");
  assert.equal(view.state().history.kind, "idle");
  await view.expand();
  const before = view.state().rows;
  fail = true;
  await view.more();
  assert.deepEqual(view.state().rows, before);
  assert.equal(view.state().history.kind, "error");
  fail = false;
  await view.more();
  assert.equal(view.state().cursor, null);
  assert.equal(calls, 4);
  view.dispose();
});
test("stale cursor replaces pages with fresh revision; refresh keeps expanded", async () => {
  let revision = "a";
  let stale = false;
  const view = createDealUpdateSummary({
    dealId: deal,
    read: async (args) =>
      args.cursor && stale ? { error: "stale_history_cursor", refresh_required: true } : response(revision, "older"),
    changed() {},
  });
  await view.refresh();
  await view.expand();
  stale = true;
  revision = "b";
  await view.more();
  assert.equal(view.state().revision, "b");
  assert.equal(view.state().rows.length, 3);
  assert.equal(view.state().expanded, true);
  revision = "c";
  await view.refresh();
  assert.equal(view.state().revision, "c");
  assert.equal(view.state().rows.length, 3);
  view.dispose();
});
test("retirement and cross-deal identity fence late success and failure; authorization clears rows", async () => {
  let release: (v: unknown) => void = () => {};
  const view = createDealUpdateSummary({
    dealId: deal,
    read: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    changed() {},
  });
  const pending = view.refresh();
  view.dispose();
  release(response());
  await pending;
  assert.equal(view.state().rows.length, 0);
  assert.equal(view.state().summary.kind, "idle");
  const other = createDealUpdateSummary({ dealId: "different", read: async () => response(), changed() {} });
  await other.refresh();
  assert.equal(other.state().summary.kind, "error");
  other.dispose();
  let denied = false;
  const auth = createDealUpdateSummary({
    dealId: deal,
    read: async () => {
      if (denied) throw Object.assign(Error(), { status: 403 });
      return response();
    },
    changed() {},
  });
  await auth.refresh();
  await auth.expand();
  denied = true;
  await auth.refresh();
  assert.equal(auth.state().rows.length, 0);
  assert.equal(auth.state().retired, true);
  await tick();
});
test("initial read error retries and old summary never accompanies newer history", async () => {
  let fail = true;
  let revision = "a";
  const view = createDealUpdateSummary({
    dealId: deal,
    read: async () => {
      if (fail) throw Error();
      return response(revision);
    },
    changed() {},
  });
  await view.refresh();
  assert.equal(view.state().summary.kind, "error");
  fail = false;
  await view.refresh();
  revision = "b";
  await view.expand();
  assert.equal(view.state().summary.kind, "ready");
  const summary = view.state().summary;
  if (summary.kind === "ready") assert.equal(summary.value.source_revision, "b");
  view.collapse();
  assert.equal(view.state().expanded, false);
  view.dispose();
});
test("history first-page failure retries independently of ready summary", async () => {
  let calls = 0;
  const view = createDealUpdateSummary({
    dealId: deal,
    read: async () => {
      if (++calls === 2) throw Error();
      return response();
    },
    changed() {},
  });
  await view.refresh();
  await view.expand();
  assert.equal(view.state().summary.kind, "ready");
  assert.equal(view.state().history.kind, "error");
  await view.more();
  assert.equal(view.state().history.kind, "ready");
  view.dispose();
});
test("late older summary cannot replace newer history during independent refresh", async () => {
  let pending: (v: unknown) => void = () => {};
  let calls = 0;
  const view = createDealUpdateSummary({
    dealId: deal,
    read: async () =>
      ++calls === 1
        ? new Promise((resolve) => {
            pending = resolve;
          })
        : response("b"),
    changed() {},
  });
  const summary = view.refresh();
  await view.expand();
  pending(response("a"));
  await summary;
  const current = view.state().summary;
  assert.equal(current.kind, "ready");
  if (current.kind === "ready") assert.equal(current.value.source_revision, "b");
  assert.equal(view.state().revision, "b");
  view.dispose();
});
test("pending continuation success and failure cannot survive retirement or a new refresh", async () => {
  for (const rejectLate of [false, true]) {
    let finish: (v: unknown) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const view = createDealUpdateSummary({
      dealId: deal,
      read: async (args) =>
        args.cursor
          ? new Promise((resolve, refuse) => {
              finish = resolve;
              reject = refuse;
            })
          : response("a", "older"),
      changed() {},
    });
    await view.refresh();
    await view.expand();
    const pending = view.more();
    view.dispose();
    if (rejectLate) reject(Error());
    else finish(response("a"));
    await pending;
    assert.equal(view.state().rows.length, 0);
    assert.equal(view.state().retired, true);
  }
  let complete: (v: unknown) => void = () => {};
  let first = true;
  const view = createDealUpdateSummary({
    dealId: deal,
    read: async () => {
      if (first) {
        first = false;
        return new Promise((resolve) => {
          complete = resolve;
        });
      }
      return response("new");
    },
    changed() {},
  });
  const old = view.refresh();
  await view.refresh();
  complete(response("old"));
  await old;
  const current = view.state().summary;
  assert.equal(current.kind, "ready");
  if (current.kind === "ready") assert.equal(current.value.source_revision, "new");
  view.dispose();
});
test("contract and registered recording match exact producer pin digests", async () => {
  const { createHash } = await import("node:crypto");
  const pin = JSON.parse(
    await readFile(new URL("../contracts/deal-update-summary.v1/provenance.json", import.meta.url), "utf8"),
  );
  assert.equal(pin.source_commit, "b04d48ac427b11f50b2d60a53d83733b9cee0d98");
  for (const name of ["contract.json", "fixture.json"])
    assert.equal(
      createHash("sha256")
        .update(await readFile(new URL(`../contracts/deal-update-summary.v1/${name}`, import.meta.url)))
        .digest("hex"),
      pin.files[name],
    );
});
test("empty and wholly omitted summary sources use null citation window without fabricated history", () => {
  const empty = {
    ...response(),
    summary: { method: "extractive", text: "No recorded updates.", citations: [] },
    coverage: {
      ...recorded.coverage,
      complete: true,
      unsupported_events_present: false,
      covered_count: 0,
      read_count_lower_bound: 0,
      window: null,
    },
    history: { ...recorded.history, entries: [], revision: "a" },
  };
  assert.equal(parseDealUpdateSummary(empty, deal).coverage.window, null);
  const omitted = {
    ...empty,
    summary: { ...empty.summary, text: "Updates exceed the extract budget. Open source history." },
    coverage: { ...empty.coverage, complete: false, read_count_lower_bound: 3 },
    history: response().history,
  };
  assert.equal(parseDealUpdateSummary(omitted, deal).history.entries.length, 3);
  assert.throws(() => parseDealUpdateSummary({ ...recorded, coverage: { ...recorded.coverage, window: null } }, deal));
});
test("failed fresh read after stale cursor exposes retry and no stale rows", async () => {
  let fail = false;
  const view = createDealUpdateSummary({
    dealId: deal,
    read: async (args) => {
      if (args.cursor) return { error: "stale_history_cursor", refresh_required: true };
      if (fail) throw Error();
      return response("a", "older");
    },
    changed() {},
  });
  await view.refresh();
  await view.expand();
  fail = true;
  await view.more();
  assert.equal(view.state().rows.length, 0);
  assert.equal(view.state().summary.kind, "error");
  assert.equal(view.state().history.kind, "error");
  fail = false;
  await view.more();
  assert.equal(view.state().rows.length, 3);
  view.dispose();
});
test("late summary failure preserves the source-matched summary supplied by history", async () => {
  let refuse: (reason: unknown) => void = () => {};
  let first = true;
  const view = createDealUpdateSummary({
    dealId: deal,
    read: async () => {
      if (first) {
        first = false;
        return new Promise((_resolve, reject) => {
          refuse = reject;
        });
      }
      return response("b");
    },
    changed() {},
  });
  const initial = view.refresh();
  await view.expand();
  refuse(Error());
  await initial;
  assert.equal(view.state().summary.kind, "ready");
  assert.equal(view.state().revision, "b");
  view.dispose();
});
