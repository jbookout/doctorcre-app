import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { proposalHttpTransport } from "../src/ui/portal/proposal-http.ts";
import { proposalSelectionPorts } from "../src/ui/portal/proposal-ports.ts";
import { createTourList } from "../src/ui/portal/tour-list-state.ts";

const receipt = JSON.parse(readFileSync("contracts/fixtures/portal-proposals.v1.json", "utf8"));
const id: string = receipt.selection.selected[0];
const scope = { publication_id: receipt.publication_id, publication_version: 1 };
const properties = [{ id, number: 1, address: "Synthetic", summary: "Synthetic", role: "candidate" as const }];
const tick = () => new Promise((resolve) => setImmediate(resolve));
for (const [code, status, state] of [
  ["unauthenticated", 401, "expired"],
  ["csrf", 403, "uncertain"],
  ["origin", 403, "uncertain"],
  ["rate_limited", 429, "uncertain"],
  ["stale_version", 409, "conflict"],
  ["retired", 409, "conflict"],
  ["idempotency_conflict", 409, "uncertain"],
  ["portal_unavailable", 503, "uncertain"],
] as const) {
  test(`HTTP ${code} maps to ${state} and preserves retry identity`, async () => {
    const bodies: string[] = [];
    let refused = true;
    const transport = proposalHttpTransport({
      slug: "example-health",
      publicationId: scope.publication_id,
      fetch: async (url, init) => {
        assert.equal(init?.credentials, "same-origin");
        assert.equal(init?.mode, "same-origin");
        assert.equal(init?.redirect, "error");
        assert.equal(init?.cache, "no-store");
        if (String(url).endsWith("/status")) return Response.json({ authenticated: true, csrf: "token" });
        if (init?.method !== "POST") return Response.json(receipt);
        assert.equal(new Headers(init.headers).get("X-Portal-CSRF"), "token");
        assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
        bodies.push(String(init.body));
        if (refused) return Response.json({ error: code }, { status });
        const body = JSON.parse(String(init.body));
        assert.deepEqual(Object.keys(body).sort(), ["publication_version", "request"]);
        assert.deepEqual(Object.keys(body.request).sort(), ["idempotency_key", "notes", "selected", "version"]);
        assert.equal(body.publication_version, 1);
        return Response.json({
          ...receipt,
          selection: { version: body.request.version + 1, selected: body.request.selected, notes: body.request.notes },
        });
      },
    });
    const model = createTourList(
      properties,
      proposalSelectionPorts({
        scope,
        properties,
        transport,
        signOut: async () => {},
        clearPrivateState() {},
        returnToGate() {},
      }),
    );
    await tick();
    model.note(id, "Exact HTTP note");
    await model.save();
    assert.equal(model.state.kind, state);
    if (state === "uncertain") {
      const frozen = "request" in model.state ? model.state.request : undefined;
      model.note(id, "Must not change");
      refused = false;
      await model.save();
      assert.equal(model.state.kind, "ready");
      assert.equal(bodies[0], bodies[1]);
      assert.equal(frozen?.notes[id], "Exact HTTP note");
    }
    model.dispose();
  });
}
test("HTTP deadline bounds status, fetch and response body; cancellation never starts POST", async (t) => {
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  for (const phase of ["status", "save", "body"] as const) {
    let posts = 0;
    const transport = proposalHttpTransport({
      slug: "example-health",
      publicationId: scope.publication_id,
      deadlineMs: 20,
      fetch: async (url) => {
        if (String(url).endsWith("/status")) {
          if (phase === "status") return new Promise<Response>(() => {});
          return Response.json({ authenticated: true, csrf: "token" });
        }
        posts++;
        if (phase === "save") return new Promise<Response>(() => {});
        return new Response(new ReadableStream({ start() {} }));
      },
    });
    await assert.rejects(
      transport.save(
        1,
        { version: 0, selected: [], notes: {}, idempotency_key: "frozen" },
        { signal: new AbortController().signal },
      ),
    );
    assert.equal(posts, phase === "status" ? 0 : 1);
  }
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    proposalHttpTransport({
      slug: "example-health",
      publicationId: scope.publication_id,
      fetch: async () => {
        throw Error("must not call");
      },
    }).read({ signal: abort.signal }),
  );
});
test("invalid portal selectors refuse before fetch", () => {
  for (const slug of ["../escape", "//foreign.test", "a?x", "a/b", ""])
    assert.throws(() => proposalHttpTransport({ slug, publicationId: scope.publication_id }));
});
