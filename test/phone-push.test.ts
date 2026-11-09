import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPhonePush } from "../src/ui/phone-push-model.ts";

const receipts = JSON.parse(await readFile(new URL("./fixtures/phone-push/receipts.json", import.meta.url), "utf8"));

function fixture(permission: NotificationPermission = "granted") {
  const calls: string[] = [];
  let failRegister = false,
    failRevoke = false,
    failUnsubscribe = false;
  const states: string[] = [];
  const options: Parameters<typeof createPhonePush>[0] = {
    supported: () => true,
    permission: () => permission,
    requestPermission: async () => {
      calls.push("prompt");
      return permission;
    },
    subscribe: async () => {
      calls.push("subscribe");
      return { endpoint: "https://web.push.apple.com/synthetic", p256dh: "B" + "a".repeat(86), auth: "a".repeat(22) };
    },
    unsubscribe: async () => {
      calls.push("unsubscribe");
      return !failUnsubscribe;
    },
    call: async (verb, args) => {
      calls.push(`${verb}:${String(args.idempotency_key)}`);
      if ((verb.startsWith("register") && failRegister) || (verb.startsWith("revoke") && failRevoke))
        throw Error("lost");
      return verb.startsWith("register") ? receipts.register : receipts.revoke;
    },
    installation: "11111111-1111-4111-8111-111111111111",
    changed: (state) => states.push(state.kind),
  };
  const model = createPhonePush(options);
  return {
    options,
    model,
    calls,
    states,
    fail(register = false, revoke = false, unsubscribe = false) {
      failRegister = register;
      failRevoke = revoke;
      failUnsubscribe = unsubscribe;
    },
  };
}
for (const permission of ["granted", "denied", "default"] as const) {
  test(`explicit tap permission ${permission}`, async () => {
    const f = fixture(permission);
    assert.equal(f.calls.length, 0);
    await f.model.enable();
    assert.equal(
      f.model.state().kind,
      permission === "granted" ? "enabled" : permission === "denied" ? "denied" : "off",
    );
    assert.equal(f.calls.includes("subscribe"), permission === "granted");
  });
}
test("lost receipt remains unconfirmed and explicit check replays the same key", async () => {
  const f = fixture();
  f.fail(true);
  await f.model.enable();
  assert.equal(f.model.state().kind, "unknown");
  f.fail();
  await f.model.enable();
  const writes = f.calls.filter((c) => c.startsWith("register"));
  assert.equal(writes[0], writes[1]);
  assert.equal(f.model.state().kind, "enabled");
});
test("revocation precedes unsubscribe; lost revocation never unsubscribes", async () => {
  const f = fixture();
  await f.model.enable();
  f.fail(false, true);
  await f.model.disable();
  assert.equal(f.model.state().kind, "revoke-unknown");
  assert.equal(f.calls.includes("unsubscribe"), false);
  f.fail();
  await f.model.disable();
  assert.equal(f.model.state().kind, "off");
  const writes = f.calls.filter((c) => c.startsWith("revoke"));
  assert.equal(writes[0], writes[1]);
  assert.equal(f.calls.at(-1), "unsubscribe");
});
test("unsubscribe failure remains server revoked and never reports enabled", async () => {
  const f = fixture();
  await f.model.enable();
  f.fail(false, false, true);
  await f.model.disable();
  assert.equal(f.model.state().kind, "local-cleanup");
});
test("session invalidation fences late registration", async () => {
  const f = fixture();
  const pending = f.model.enable();
  f.model.retire();
  await pending;
  assert.equal(f.model.state().kind, "retired");
  assert.equal(f.states.at(-1), "retired");
});

test("unsupported installation never asks permission or registers", async () => {
  const f = fixture();
  const model = createPhonePush({ ...f.options, supported: () => false });
  await model.enable();
  assert.equal(model.state().kind, "unsupported");
  assert.deepEqual(f.calls, []);
});
test("inspection enables only the confirmed matching browser generation", async () => {
  const f = fixture();
  const model = createPhonePush({
    ...f.options,
    inspect: async () => ({ generation: 4, active: true, matching: true }),
  });
  await model.refresh();
  assert.equal(model.state().kind, "enabled");
  const uncertain = createPhonePush({
    ...f.options,
    inspect: async () => ({ generation: 4, active: true, matching: false }),
  });
  await uncertain.refresh();
  assert.equal(uncertain.state().kind, "unknown");
  const denied = createPhonePush({
    ...f.options,
    permission: () => "denied",
    inspect: async () => ({ generation: 4, active: true, matching: true }),
  });
  await denied.refresh();
  assert.notEqual(denied.state().kind, "enabled");
});
for (const change of [
  { generation: 0 },
  { state: "revoked" },
  { installation_id: "foreign" },
  { replayed: "true" },
  { schema_version: "wrong" },
]) {
  test(`malformed registration receipt stays unknown ${JSON.stringify(change)}`, async () => {
    const f = fixture();
    const model = createPhonePush({ ...f.options, call: async () => ({ ...receipts.register, ...change }) });
    await model.enable();
    assert.equal(model.state().kind, "unknown");
  });
}
test("duplicate taps cannot overlap and retiring an actual in-flight write fences its receipt", async () => {
  const f = fixture();
  let settle: ((value: unknown) => void) | undefined;
  const answer = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
  let writes = 0;
  const model = createPhonePush({
    ...f.options,
    call: async () => {
      writes++;
      return answer;
    },
  });
  const enabling = model.enable();
  await Promise.resolve();
  await Promise.resolve();
  await model.enable();
  assert.equal(writes, 1);
  model.retire();
  assert.ok(settle);
  settle(receipts.register);
  await enabling;
  assert.equal(model.state().kind, "retired");
});
test("browser cleanup can be retried without another revocation", async () => {
  const f = fixture();
  await f.model.enable();
  f.fail(false, false, true);
  await f.model.disable();
  f.fail();
  await f.model.disable();
  assert.equal(f.model.state().kind, "off");
  assert.equal(f.calls.filter((c) => c.startsWith("revoke")).length, 1);
});

for (const phase of [
  "off",
  "denied",
  "pending",
  "unknown",
  "enabled",
  "revoking",
  "revoke-unknown",
  "local-cleanup",
] as const) {
  test(`session ends during ${phase}`, async () => {
    const f = fixture(phase === "denied" ? "denied" : "granted");
    if (phase === "pending" || phase === "revoking")
      f.options.changed = (state) => {
        if (state.kind === phase) f.model.retire();
      };
    if (phase === "unknown") f.fail(true);
    if (phase !== "off") await f.model.enable();
    if (phase === "revoke-unknown") f.fail(false, true);
    if (phase === "local-cleanup") f.fail(false, false, true);
    if (["revoking", "revoke-unknown", "local-cleanup"].includes(phase)) await f.model.disable();
    f.model.retire();
    const count = f.calls.length;
    await f.model.enable();
    await f.model.disable();
    await f.model.refresh();
    assert.equal(f.calls.length, count);
    assert.equal(f.model.state().kind, "retired");
  });
}
test("denied permission may be changed before another explicit enable", async () => {
  const f = fixture("denied");
  await f.model.enable();
  f.options.requestPermission = async () => "granted";
  f.options.permission = () => "granted";
  await f.model.enable();
  assert.equal(f.model.state().kind, "enabled");
});
