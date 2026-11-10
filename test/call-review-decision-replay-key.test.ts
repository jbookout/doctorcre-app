import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import test from "node:test";
import { JSDOM } from "jsdom";
import { resolverFixture } from "../scripts/prove-call-review-decision-replay-key.ts";

type Client = ReturnType<Parameters<typeof import("../src/ui/call-review.tsx").mountCallReview>[1]["client"]>;
type Args = { candidate_id?: string; proposal_id?: string; accept: boolean; idempotency_key: string };
type Row = {
  session_id: string;
  call_date: string;
  applied: unknown[];
  open_cards: { candidate_id: string; resolver: string; kind: string; payload: { action: string } }[];
};
const createLiveClient: (options: {
  fetchImpl: (path: string, init: { body: string }) => Promise<Response>;
}) => Client = (await import("../js/" + "live-client.js")).createLiveClient;

import { unlink, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const bundled = await build({
  entryPoints: ["src/ui/call-review.tsx"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  external: ["react", "react-dom", "react-dom/client"],
  jsx: "automatic",
});
const path = new URL("../.call-review-replay-test.mjs", import.meta.url);
await writeFile(path, bundled.outputFiles.map((file) => file.text).join(""));
const { mountCallReview } = await import(path.href);
await unlink(path);
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
async function setup(
  t: TestContext,
  resolve: (args: Args, rows: [Row], count: number) => unknown,
  resolver = "resolve-post-call-candidate",
  failInitialRead = false,
  transport = false,
) {
  const dom = new JSDOM("<main></main>", { url: "http://localhost" });
  Reflect.set(globalThis, "window", dom.window);
  Reflect.set(globalThis, "document", dom.window.document);
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const node = document.querySelector("main");
  assert.ok(node);
  const writes: Args[] = [];
  const rows: [Row] = [
    {
      session_id: "s",
      call_date: "2026-10-01",
      applied: [],
      open_cards: [
        {
          candidate_id: "c",
          resolver,
          kind: resolver === "resolve-candidate" ? "next_step" : "assigned_action",
          payload: { action: "Synthetic task" },
        },
      ],
    },
  ];
  const client = {
    undoCallChange: async () => {
      throw Error("Unexpected undo");
    },
    reviewCallOutcome: async () => {
      throw Error("Unexpected completion");
    },
    readCallOutcomes: async () => {
      if (failInitialRead) {
        failInitialRead = false;
        throw new Error("offline");
      }
      return { calls: structuredClone(rows) };
    },
    resolvePostCallCandidate: async (args: Args) => {
      writes.push(args);
      return resolve(args, rows, writes.length);
    },
  };
  const baseClient: Client = client;
  baseClient.resolveConfirm = async (args) => {
    writes.push(args);
    return resolve(args, rows, writes.length);
  };
  let activeClient: Client = baseClient;
  if (transport)
    activeClient = createLiveClient({
      fetchImpl: async (path: string, init: { body: string }) => {
        if (path === "/auth/session") return Response.json({ actor: { slug: "joe" }, csrf_token: "synthetic" });
        const { name, arguments: args } = JSON.parse(init.body).params;
        if (name === "read-call-outcomes")
          return Response.json({ result: { content: [{ type: "text", text: JSON.stringify({ calls: rows }) }] } });
        assert.ok(["resolve-candidate", "resolve-post-call-candidate"].includes(name), name);
        writes.push(args);
        const response = await resolve(args, rows, writes.length);
        assert.ok(response instanceof Response);
        return response;
      },
    });
  const view = mountCallReview(node, {
    sessionId: "s",
    client: () => activeClient,
    describe: () => "Task",
    undoRefusal: () => "",
  });
  t.after(() => {
    view.dispose();
    dom.window.close();
  });
  const initiallyUnavailable = failInitialRead;
  await view.refresh();
  if (initiallyUnavailable) {
    assert.match(node.textContent, /Could not check/);
    await view.refresh();
  }
  const click = async (name: string) => {
    const button = [...node.querySelectorAll("button")].find((b) => b.textContent === name);
    assert.ok(button, name);
    assert.equal(button.disabled, false, name);
    button.click();
    await settle();
  };
  await click("Approve or fix this item");
  return { node, rows, writes, view, click, client: activeClient, dom };
}
for (const resolver of ["resolve-post-call-candidate", "resolve-candidate"])
  test(`lost reply retains exact request for explicit check via ${resolver}`, async (t) => {
    const s = await setup(
      t,
      (args, rows, count) => {
        if (count === 1) throw new Error("lost");
        rows[0].open_cards = [];
        return resolverFixture(args.candidate_id || args.proposal_id || assert.fail("Missing candidate"), args.accept);
      },
      resolver,
    );
    await s.click("Approve item");
    assert.equal(s.writes.length, 1);
    assert.equal([...s.node.querySelectorAll("button")].find((b) => b.textContent === "Skip item")?.disabled, true);
    await s.click("Check outcome");
    assert.deepEqual(s.writes[1], s.writes[0]);
    assert.match(s.node.textContent, /No longer pending/);
  });
test("lost response after commit reconciles without replay", async (t) => {
  const s = await setup(t, (_args, rows) => {
    rows[0].open_cards = [];
    throw new Error("lost");
  });
  await s.click("Approve item");
  assert.match(s.node.textContent, /No longer pending/);
  assert.equal(s.writes.length, 1);
});
test("changed candidate refuses replay until authoritative resolution", async (t) => {
  const s = await setup(t, () => {
    throw new Error("offline");
  });
  await s.click("Approve item");
  (s.rows[0].open_cards[0] ?? assert.fail("Missing candidate")).payload.action = "Changed";
  await s.click("Check outcome");
  assert.equal(s.writes.length, 1);
  assert.match(s.node.textContent, /changed/);
  s.rows[0].open_cards = [];
  await s.view.refresh();
  assert.match(s.node.textContent, /No longer pending/);
});
test("definitive refusal permits a fresh decision but missing receipt stays unknown", async (t) => {
  const s = await setup(t, () => ({ ok: false }));
  await s.click("Approve item");
  assert.equal([...s.node.querySelectorAll("button")].find((b) => b.textContent === "Skip item")?.disabled, false);
  s.client.resolvePostCallCandidate = async (args) => {
    s.writes.push(args);
    return {};
  };
  await s.click("Skip item");
  assert.match(s.node.textContent, /outcome.*unknown/i);
});
test("authentication failure retires controls", async (t) => {
  const s = await setup(t, () => {
    throw { status: 401 };
  });
  await s.click("Approve item");
  assert.match(s.node.textContent, /Sign in again/);
  assert.equal(s.node.querySelector(".call-review-decision"), null);
});
test("late completion after invalidation cannot restore controls", async (t) => {
  let finish: (value: unknown) => void = () => assert.fail("Write did not start");
  const s = await setup(
    t,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await s.click("Approve item");
  s.dom.window.dispatchEvent(new s.dom.window.Event("doctorcre-session-invalidated"));
  finish(resolverFixture("c", true));
  await settle();
  assert.match(s.node.textContent, /Sign in again/);
});
test("late completion after disposal stays empty", async (t) => {
  let finish: (value: unknown) => void = () => assert.fail("Write did not start");
  const s = await setup(
    t,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await s.click("Approve item");
  s.view.dispose();
  finish(resolverFixture("c", true));
  await settle();
  assert.equal(s.node.innerHTML, "");
  assert.equal(s.node.hidden, true);
});
test("failed authoritative read never replays and refresh restores recovery", async (t) => {
  const s = await setup(t, () => {
    throw new Error("lost");
  });
  await s.click("Skip item");
  s.client.readCallOutcomes = async () => {
    throw new Error("offline");
  };
  await s.click("Check outcome");
  assert.equal(s.writes.length, 1);
  assert.match(s.node.textContent, /Could not check/);
  s.client.readCallOutcomes = async () => ({ calls: structuredClone(s.rows) });
  await s.view.refresh();
  assert.equal([...s.node.querySelectorAll("button")].find((b) => b.textContent === "Check outcome")?.disabled, false);
  s.client.resolvePostCallCandidate = async (args) => {
    s.writes.push(args);
    s.rows[0].open_cards = [];
    return resolverFixture(args.candidate_id || assert.fail("Missing candidate"), args.accept);
  };
  await s.click("Check outcome");
  assert.deepEqual(s.writes[1], s.writes[0]);
  assert.equal(s.writes[1]?.accept, false);
});
test("authorization failure during recovery permanently retires the guide", async (t) => {
  const s = await setup(t, () => {
    throw new Error("lost");
  });
  await s.click("Approve item");
  s.client.readCallOutcomes = async () => {
    throw { status: 403 };
  };
  await s.click("Check outcome");
  assert.match(s.node.textContent, /Sign in again/);
  assert.equal(s.writes.length, 1);
  s.client.readCallOutcomes = async () => ({ calls: s.rows });
  await s.view.refresh();
  assert.match(s.node.textContent, /Sign in again/);
});
test("initial unavailable read recovers and ready disposal clears controls", async (t) => {
  const s = await setup(t, () => resolverFixture("c", true), "resolve-post-call-candidate", true);
  s.client.readCallOutcomes = async () => {
    throw new Error("offline");
  };
  await s.view.refresh();
  assert.match(s.node.textContent, /Could not check/);
  s.client.readCallOutcomes = async () => ({ calls: s.rows });
  await s.view.refresh();
  assert.match(s.node.textContent, /Needs your decision/);
  s.view.dispose();
  assert.equal(s.node.innerHTML, "");
});
test("ready authorization failure and recovery disposal retire controls", async (t) => {
  const s = await setup(t, () => resolverFixture("c", true));
  s.client.readCallOutcomes = async () => {
    throw { status: 401 };
  };
  await s.view.refresh();
  assert.match(s.node.textContent, /Sign in again/);
});
test("recovery disposal removes the held request", async (t) => {
  const s = await setup(t, () => {
    throw new Error("offline");
  });
  await s.click("Approve item");
  s.view.dispose();
  await s.view.refresh();
  assert.equal(s.node.innerHTML, "");
  assert.equal(s.writes.length, 1);
});

const mcp = (payload: unknown, isError = false) =>
  Response.json({ result: { isError, content: [{ type: "text", text: JSON.stringify(payload) }] } });
for (const resolver of ["resolve-post-call-candidate", "resolve-candidate"]) {
  for (const status of [400, 404, 409, 422, 429, 503])
    test(`live ${resolver} retains HTTP ${status} for exact replay`, async (t) => {
      const s = await setup(
        t,
        (args, _rows, count) =>
          count === 1
            ? new Response("Unconfirmed", { status })
            : mcp(resolverFixture(args.candidate_id || assert.fail("Missing candidate"), args.accept)),
        resolver,
        false,
        true,
      );
      await s.click("Approve item");
      assert.match(s.node.textContent, /outcome is unknown/);
      assert.equal([...s.node.querySelectorAll("button")].find((b) => b.textContent === "Skip item")?.disabled, true);
      assert.equal(s.writes.length, 1);
      if (status === 429) {
        const afterCooldown = Date.now() + 60_001;
        t.mock.method(Date, "now", () => afterCooldown);
        await new Promise((resolve) => setTimeout(resolve, 1100));
      }
      await s.click("Check outcome");
      assert.equal(s.writes.length, 2);
      assert.deepEqual(s.writes[1], s.writes[0]);
      assert.doesNotMatch(s.node.textContent, /outcome is unknown/);
    });
  test(`live ${resolver} semantic refusal releases approval so Skip reaches the wire`, async (t) => {
    const s = await setup(
      t,
      (args, _rows, count) =>
        count === 1
          ? mcp({ error: "assignee_not_provisioned" }, true)
          : mcp(resolverFixture(args.candidate_id || assert.fail("Missing candidate"), args.accept)),
      resolver,
      false,
      true,
    );
    await s.click("Approve item");
    assert.doesNotMatch(s.node.textContent, /outcome is unknown/);
    await s.click("Skip item");
    assert.equal(s.writes.length, 2);
    assert.equal(s.writes[1]?.accept, false);
    assert.notEqual(s.writes[1]?.idempotency_key, s.writes[0]?.idempotency_key);
  });
}
for (const code of ["internal_error", "unhandled_verb_failure", "carr_unavailable", "wire_unavailable", "offline"])
  test(`live ${code} fault retains the decision`, async (t) => {
    const s = await setup(t, () => mcp({ error: code }, true), "resolve-post-call-candidate", false, true);
    await s.click("Approve item");
    assert.match(s.node.textContent, /outcome is unknown/);
    assert.equal([...s.node.querySelectorAll("button")].find((b) => b.textContent === "Skip item")?.disabled, true);
    await s.click("Check outcome");
    assert.deepEqual(s.writes[1], s.writes[0]);
  });
for (const readbackFails of [false, true])
  test(`live resolveConfirm receipt clears uncertainty when readback ${readbackFails ? "fails" : "resolves"}`, async (t) => {
    const s = await setup(
      t,
      (args, rows) => {
        rows[0].open_cards = [];
        return mcp(resolverFixture(args.candidate_id || assert.fail("Missing candidate"), args.accept));
      },
      "resolve-candidate",
      false,
      true,
    );
    if (readbackFails)
      s.client.readCallOutcomes = async () => {
        throw new Error("read unavailable");
      };
    await s.click("Approve item");
    assert.equal(s.writes.length, 1);
    assert.doesNotMatch(s.node.textContent, /outcome is unknown/);
    assert.match(s.node.textContent, readbackFails ? /Could not check/ : /No longer pending/);
  });
for (const resolver of ["resolve-post-call-candidate", "resolve-candidate"])
  test(`live ${resolver} missing receipt stays unknown`, async (t) => {
    const s = await setup(t, () => mcp({}), resolver, false, true);
    await s.click("Approve item");
    assert.match(s.node.textContent, /outcome is unknown/);
    assert.equal([...s.node.querySelectorAll("button")].find((b) => b.textContent === "Skip item")?.disabled, true);
    await s.click("Check outcome");
    assert.equal(s.writes.length, 2);
    assert.deepEqual(s.writes[1], s.writes[0]);
  });
