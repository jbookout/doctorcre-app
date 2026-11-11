import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAttachment, parseReservation, validateSharedFile } from "../src/ui/share-contract.ts";

const fixture = JSON.parse(
  await readFile(new URL("../contracts/fixtures/deal-document-intake.v1.json", import.meta.url), "utf8"),
);
const recordings = JSON.parse(
  await readFile(new URL("./fixtures/share-intake/receipts.json", import.meta.url), "utf8"),
);
assert.equal(recordings.producer_commit, "926602dead49619842aa4e617dae08d96fed40c2");
const expected = fixture.finalize.attachment;
test("producer receipt is parsed exactly; near-match deal and hash refuse", () => {
  assert.deepEqual(parseAttachment(fixture.finalize, expected), expected);
  assert.throws(() => parseAttachment(fixture.finalize, { ...expected, deal_id: `${expected.deal_id}a` }));
  assert.throws(() => parseAttachment(fixture.finalize, { ...expected, sha256: "a".repeat(64) }));
  assert.throws(() => parseAttachment({ ...fixture.finalize, attachment: null }, expected));
});
test("reserve accepts only server-issued path tied to exact deal and reservation", () => {
  assert.equal(parseReservation(fixture.reserve, expected.deal_id).id, expected.attachment_id);
  assert.throws(() =>
    parseReservation({ ...fixture.reserve, upload_path: "https://elsewhere.test/bytes" }, expected.deal_id),
  );
  assert.throws(() => parseReservation(fixture.reserve, `${expected.deal_id}a`));
});
test("one bounded PDF or photo only", () => {
  validateSharedFile(new File(["%PDF-"], "Note.pdf", { type: "application/pdf" }));
  assert.throws(() => validateSharedFile(new File(["x"], "x.html", { type: "text/html" })));
  assert.throws(() =>
    validateSharedFile(new File([new Uint8Array(26214401)], "Large.pdf", { type: "application/pdf" })),
  );
});

const { createShareIntake } = await import("../src/ui/share-intake-model.ts");
function intake(
  t: { after(fn: () => void): void },
  mode = "",
  destination: "documents" | "deliverables" = "documents",
) {
  let server = "started",
    lost = false,
    token = "test-session-a";
  let operation: unknown = null,
    cleared = false,
    workerAlive = true,
    shareId = "original-share";
  const journal = new Map<string, string>();
  const storage = {
    getItem: (key: string) => journal.get(key) ?? null,
    setItem: (key: string, value: string) => {
      journal.set(key, value);
    },
    removeItem: (key: string) => {
      journal.delete(key);
    },
  };
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const states: { kind: string }[] = [];
  const file = new File([new Uint8Array([255, 216, 255, 0, 1, 2, 3])], "Photo.jpg", { type: "image/jpeg" });
  const keys = {
    reserve: "11111111-1111-4111-8111-111111111111",
    finalize: "22222222-2222-4222-8222-222222222222",
    abandon: "33333333-3333-4333-8333-333333333333",
  };
  const json = (value: unknown, status = 200) => {
    if (
      destination === "deliverables" &&
      value &&
      typeof value === "object" &&
      "schema_version" in value &&
      value.schema_version === "deal-document-intake.v1"
    )
      value = { ...value, schema_version: "deal-deliverables.v1" };
    return new Response(JSON.stringify(value), { status });
  };
  const options = {
    destination,
    changed(state: { kind: string }) {
      states.push(state);
    },
    storage,
    async handoff(csrf: string, action: string, next: unknown) {
      if (!workerAlive) return { ok: false, error: "Share expired. Share the file again." };
      assert.equal(csrf, token);
      if (action === "clear") {
        cleared = true;
        return { ok: true };
      }
      if (action === "operation") {
        operation = next;
        return { ok: true };
      }
      return { ok: true, share: { id: shareId, file, expires: Date.now() + 60000, keys, operation } };
    },
    async fetcher(input: Parameters<typeof fetch>[0], init?: RequestInit) {
      const path = String(input);
      if (mode === "offline") throw Error("offline");
      if (path === "/auth/session")
        return mode === "signed-out"
          ? json({}, 401)
          : json({ actor: { slug: "synthetic-partner" }, csrf_token: token });
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (path === "/mcp") {
        const result =
          body.params.name === "deal-room-board"
            ? { deals: [{ id: expected.deal_id, name: "Demo Harbor" }] }
            : fixture.list;
        return json({ result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
      }
      if (destination === "deliverables" && init?.method === "GET" && !path.endsWith("/receipt"))
        return json({ ok: true, schema_version: "deal-deliverables.v1", deliverables: [fixture.finalize.deliverable] });
      if (init?.method !== "GET") writes.push({ path, body });
      if (path.endsWith("/receipt") && mode === "wrong-receipt")
        return json({ ...recordings.read_started, schema_version: "deal-deliverables.v1" });
      if (mode === "worker-after-reserve" && !lost && path.endsWith("/receipt")) {
        lost = true;
        throw Error("lost receipt");
      }
      if (path.endsWith("/receipt"))
        return json(
          server === "finalized"
            ? fixture.finalize
            : server === "verified"
              ? recordings.read_verified
              : recordings.read_started,
        );
      if (path.endsWith("/bytes")) {
        server = "verified";
        return json(fixture.upload);
      }
      if (path.endsWith("/abandon")) {
        server = "expired";
        return json(
          mode === "wrong-abandon"
            ? {
                ...recordings.abandon,
                deliverable: { ...recordings.abandon.deliverable, deal_id: `${expected.deal_id}a` },
              }
            : recordings.abandon,
        );
      }
      if (path.endsWith("/finalize")) {
        server = "finalized";
        if (mode === "lost-finalize" && !lost) {
          lost = true;
          throw Error("lost finalize");
        }
        return json(fixture.finalize);
      }
      assert.equal(body.target_collection, destination);
      if (["lost-reserve", "wrong-abandon"].includes(mode) && !lost) {
        lost = true;
        throw Error("lost reserve");
      }
      return json(fixture.reserve);
    },
  };
  let model = createShareIntake(options);
  t.after(() => model.retire());
  return {
    get model() {
      return model;
    },
    freshShare() {
      workerAlive = true;
      operation = null;
      shareId = "new-share";
    },
    killWorker() {
      workerAlive = false;
    },
    reload() {
      model.close?.();
      model = createShareIntake(options);
      return model.start();
    },
    journal,
    states,
    writes,
    get cleared() {
      return cleared;
    },
    changeSession() {
      token = "test-session-b";
    },
  };
}
test("receiving choosing ready filing filed requires exact receipt and list readback", async (t) => {
  const x = intake(t);
  await x.model.start();
  x.model.choose(expected.deal_id);
  await x.model.file();
  assert.deepEqual(
    x.states.map((s) => s.kind),
    ["choosing", "ready", "filing", "filed"],
  );
  assert.equal(x.cleared, true);
});
for (const mode of ["lost-reserve", "lost-finalize"])
  test(`${mode} reconciles frozen target and reuses write keys`, async (t) => {
    const x = intake(t, mode);
    await x.model.start();
    x.model.choose(expected.deal_id);
    await x.model.file();
    assert.equal(x.states.at(-1)?.kind, "uncertain");
    x.model.choose(`${expected.deal_id}a`);
    assert.equal(x.states.at(-1)?.kind, "uncertain");
    await x.model.file();
    assert.equal(x.states.at(-1)?.kind, "filed");
    const starts = x.writes.filter((w) => !/\/(finalize|bytes)$/.test(w.path));
    assert.equal(new Set(starts.map((w) => w.body.idempotency_key)).size, 1);
    assert.equal(x.writes.filter((w) => w.path.endsWith("/finalize")).length, 1);
  });
for (const mode of ["offline", "signed-out"])
  test(`${mode} has no preview or writes`, async (t) => {
    const x = intake(t, mode);
    await x.model.start();
    assert.ok(["retired", "refused"].includes(x.states.at(-1)?.kind ?? ""));
    assert.equal(x.writes.length, 0);
    assert.equal(JSON.stringify(x.states).includes("Photo.jpg"), false);
  });
test("session change fences filing and late receipts", async (t) => {
  const x = intake(t);
  await x.model.start();
  x.model.choose(expected.deal_id);
  x.changeSession();
  await x.model.file();
  assert.equal(x.states.at(-1)?.kind, "retired");
  assert.equal(x.writes.length, 0);
});
test("near-match deal choice refuses before writes", async (t) => {
  const x = intake(t);
  await x.model.start();
  x.model.choose(`${expected.deal_id}a`);
  await x.model.file();
  assert.equal(x.states.at(-1)?.kind, "refused");
  assert.equal(x.writes.length, 0);
});
test("discard clears unreserved bytes without creating a reservation", async (t) => {
  const x = intake(t);
  await x.model.start();
  await x.model.discard();
  assert.equal(x.cleared, true);
  assert.equal(x.writes.length, 0);
});
test("discard after lost reserve reconciles then abandons with stable key", async (t) => {
  const x = intake(t, "lost-reserve");
  await x.model.start();
  x.model.choose(expected.deal_id);
  await x.model.file();
  await x.model.discard();
  assert.equal(x.states.at(-1)?.kind, "retired");
  assert.equal(x.cleared, true);
  assert.equal(x.writes.filter((w) => w.path.endsWith("/abandon")).length, 1);
});

for (const stage of ["receiving", "choosing", "ready", "filing", "uncertain", "filed", "refused"]) {
  test(`session retirement clears ${stage} and fences later completion`, async (t) => {
    const x = intake(t, stage === "uncertain" ? "lost-reserve" : "");
    if (stage !== "receiving") await x.model.start();
    if (["ready", "filing", "uncertain", "filed"].includes(stage)) x.model.choose(expected.deal_id);
    if (stage === "uncertain" || stage === "filed") await x.model.file();
    if (stage === "refused") x.model.choose(`${expected.deal_id}a`);
    const pending = stage === "filing" ? x.model.file() : Promise.resolve();
    x.model.retire();
    await pending;
    assert.equal(x.states.at(-1)?.kind, "retired");
    assert.equal("filename" in (x.states.at(-1) ?? {}), false);
    const count = x.writes.length;
    await x.model.file();
    assert.equal(x.writes.length, count);
  });
}

test("a legacy deliverable receipt cannot authorize an upload", async (t) => {
  const x = intake(t, "wrong-receipt");
  await x.model.start();
  x.model.choose(expected.deal_id);
  await x.model.file();
  assert.equal(x.states.at(-1)?.kind, "uncertain");
  assert.equal(
    x.writes.some((w) => w.path.endsWith("/bytes")),
    false,
  );
});
test("an abandon receipt for a near-match deal cannot clear custody", async (t) => {
  const x = intake(t, "wrong-abandon");
  await x.model.start();
  x.model.choose(expected.deal_id);
  await x.model.file();
  await x.model.discard();
  assert.equal(x.states.at(-1)?.kind, "uncertain");
  assert.equal(x.cleared, false);
});

for (const reload of [false, true]) {
  test(`worker loss before selection retires explicitly, reload=${reload}`, async (t) => {
    const x = intake(t);
    await x.model.start();
    x.killWorker();
    if (reload) await x.reload();
    else {
      x.model.choose(expected.deal_id);
      await x.model.file();
    }
    assert.equal(x.states.at(-1)?.kind, "retired");
    assert.match(JSON.stringify(x.states.at(-1)), /Share the file again/i);
    assert.equal(x.writes.length, 0);
  });
  for (const mode of ["worker-after-reserve", "lost-finalize"])
    test(`worker loss ${mode} preserves recovery, reload=${reload}`, async (t) => {
      const x = intake(t, mode);
      await x.model.start();
      x.model.choose(expected.deal_id);
      await x.model.file();
      assert.equal(x.states.at(-1)?.kind, "uncertain");
      x.killWorker();
      if (reload) await x.reload();
      assert.equal(x.states.at(-1)?.kind, "uncertain");
      x.model.choose(`${expected.deal_id}a`);
      await x.model.file();
      assert.equal(x.states.at(-1)?.kind, mode === "lost-finalize" || !reload ? "filed" : "uncertain");
      if (mode === "worker-after-reserve" && reload) {
        await x.model.discard();
        assert.equal(x.states.at(-1)?.kind, "retired");
        assert.equal(x.writes.filter((w) => w.path.endsWith("/bytes")).length, 0);
      }
      assert.equal(
        x.writes.filter((w) => w.path.endsWith("/finalize")).length,
        mode === "lost-finalize" || !reload ? 1 : 0,
      );
    });
}
test("reload prioritizes unresolved write over fresh worker share and changed session cannot decrypt it", async (t) => {
  const x = intake(t, "lost-finalize");
  await x.model.start();
  x.model.choose(expected.deal_id);
  await x.model.file();
  assert.ok(x.journal.size);
  assert.equal(JSON.stringify([...x.journal]).includes("test-session-a"), false);
  assert.equal(JSON.stringify([...x.journal]).includes("Photo.jpg"), false);
  x.freshShare();
  await x.reload();
  assert.equal(x.states.at(-1)?.kind, "uncertain");
  x.killWorker();
  x.changeSession();
  await x.reload();
  assert.notEqual(x.states.at(-1)?.kind, "uncertain");
});

test("expired bytes retain unresolved reservation for abandonment", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const x = intake(t, "worker-after-reserve");
  await x.model.start();
  x.model.choose(expected.deal_id);
  await x.model.file();
  t.mock.timers.tick(60001);
  assert.equal(x.states.at(-1)?.kind, "uncertain");
  await x.model.file();
  assert.equal(x.writes.filter((w) => w.path.endsWith("/bytes")).length, 0);
  await x.model.discard();
  assert.equal(x.states.at(-1)?.kind, "retired");
});

for (const elapsed of [false, true]) {
  test(`reloaded recovery expires bytes and retains abandonment, delayed timer=${elapsed}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const x = intake(t, "worker-after-reserve");
    await x.model.start();
    x.model.choose(expected.deal_id);
    await x.model.file();
    await x.reload();
    x.killWorker();
    if (elapsed) t.mock.timers.setTime(Date.now() + 60001);
    else t.mock.timers.tick(60001);
    await x.model.file();
    assert.equal(x.writes.filter((w) => w.path.endsWith("/bytes")).length, 0);
    assert.equal(x.states.at(-1)?.kind, "uncertain");
    assert.ok(x.journal.size);
    await x.model.discard();
    assert.equal(x.states.at(-1)?.kind, "retired");
    assert.equal(x.writes.filter((w) => w.path.endsWith("/abandon")).length, 1);
  });
}

for (const mode of ["lost-reserve", "lost-finalize"])
  test(`deliverables ${mode} reload reconciles one exact-deal file`, async (t) => {
    const x = intake(t, mode, "deliverables");
    await x.model.start();
    x.model.choose(expected.deal_id);
    await x.model.file();
    assert.equal(x.states.at(-1)?.kind, "uncertain");
    await x.reload();
    x.model.choose(crypto.randomUUID());
    await x.model.file();
    assert.equal(x.states.at(-1)?.kind, "filed");
    const starts = x.writes.filter((w) => w.body.target_collection);
    assert.equal(new Set(starts.map((w) => w.body.idempotency_key)).size, 1);
    assert.equal(x.writes.filter((w) => w.path.endsWith("/finalize")).length, 1);
  });
