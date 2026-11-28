import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import phone from "../contracts/carr-interface.v1/phone_call_sessions.json" with { type: "json" };
import tourComposer from "../contracts/tour-composer.v1.json" with { type: "json" };
import worker from "../src/worker.js";

const origin = "https://app.example.test";
const dealsReadOn = new Map([["deals-from-engine", "on"]]);
const payload = '{ "amount": "100.00", "synthetic": true }';
function call(name = "deal-room-board", args: unknown = {}, extra = {}) {
  return { jsonrpc: "2.0", id: "synthetic-request", method: "tools/call", params: { name, arguments: args }, ...extra };
}
function fixture(value: unknown = "on", answer: () => Promise<Response> = async () => new Response(payload)) {
  const engine: Request[] = [];
  const carr: string[] = [];
  const kv: unknown[] = [];
  const env = {
    GIT_SHA: "0".repeat(40),
    APP_ENV: "staging",
    ENGINE_ROUTING: {
      get: async (...args: unknown[]) => {
        kv.push(args);
        if (value instanceof Error) throw value;
        return value instanceof Map ? (value.get(args[0]) ?? null) : value;
      },
    },
    ENGINE: {
      fetch: async (request: Request) => {
        engine.push(request);
        return answer();
      },
    },
    CARR: {
      fetch: async (request: Request) => {
        carr.push(await request.text());
        return new Response("old");
      },
    },
  };
  const send = (body = call(), headers: HeadersInit = { origin, cookie: "session=synthetic" }) =>
    worker.fetch(
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      env,
    );
  return { env, send, engine, carr, kv };
}

for (const verb of ["today-triage", "calendar-meeting-prep", "list-email-thread-filings"]) {
  for (const [shape, request] of [
    ["direct", call(verb)],
    ["wrapped", call("call-verb", { verb, args: {} })],
    ["wrapped with JSON arguments", call("call-verb", { verb, args: "{}" })],
  ] as const) {
    test(`refuses ${shape} ${verb} after Home cutover with CARR sign-in`, async () => {
      const { send, carr, engine } = fixture(new Map());
      const response = await send(request);
      assert.deepEqual(carr, []);
      assert.deepEqual(engine, []);
      const reply = await response.json();
      assert.equal(reply.id, request.id);
      assert.equal(reply.result.isError, true);
      assert.equal(JSON.parse(reply.result.content[0].text).error, "home_routing_changed");
    });
  }
}

for (const read of ["critical-dates", "meetings?from=2026-10-01&to=2026-10-31"])
  test(`Calendar ${read} uses the Deals switch and preserves the engine response`, async () => {
    const request = new Request(`${origin}/api/engine/calendar/${read}`, {
      headers: { cookie: "session=synthetic" },
    });
    for (const status of [200, 404, 503]) {
      const { env, engine, carr } = fixture(dealsReadOn, async () => new Response(payload, { status }));
      assert.equal((await worker.fetch(request, env)).status, status);
      assert.equal(engine.length, 1);
      assert.equal(engine[0]?.url, request.url);
      assert.equal(engine[0]?.headers.get("cookie"), "session=synthetic");
      assert.deepEqual(carr, []);
    }
    const { env, engine, carr } = fixture(new Map());
    assert.equal((await worker.fetch(request, env)).status, 404);
    assert.deepEqual(engine, []);
    assert.deepEqual(carr, []);
  });

test("Home's lead counts use the Leads switch and preserve the engine response", async () => {
  const request = new Request(`${origin}/api/engine/leads/counts`, { headers: { cookie: "session=synthetic" } });
  const on = fixture(new Map([["leads-from-engine", "on"]]), async () => new Response(payload));
  assert.equal((await worker.fetch(request, on.env)).status, 200);
  assert.equal(on.engine[0]?.url, request.url);
  const off = fixture(new Map());
  assert.equal((await worker.fetch(request, off.env)).status, 404);
  assert.deepEqual(off.engine, []);
});

test("Leads saves use the board UUID and preserve the legacy request before cutover", async () => {
  const leadId = "00000000-0000-4000-8000-000000000010";
  const clientId = "00000000-0000-4000-8000-000000000011";
  const key = "00000000-0000-4000-8000-000000000012";
  const base = { base_version: 42, expected_actor: "example-partner", idempotency_key: key };
  const lead = { lead: "L-1", lead_id: leadId };
  const headers = { origin, cookie: "session=synthetic", "x-carr-csrf": "synthetic" };
  const switches = new Map([
    ["leads-from-engine", "on"],
    ["deals-saves-from-engine", "on"],
  ]);
  const actions = [
    ["claim-lead", {}, { action: "claim" }],
    [
      "update-lead",
      { fields: { stage: "archived" }, stage_review: { reason: "Example ended", evidence_ids: [] } },
      { action: "stage", stage: "archived", reason: "Example ended" },
    ],
    [
      "link-lead-client",
      { client_id: clientId, confirmed: true },
      { action: "link", client_id: clientId, confirmed: true },
    ],
  ] as const;
  for (const [name, args, command] of actions) {
    const callBody = call(name, { ...base, ...lead, ...args });
    const enabled = fixture(switches, async () => Response.json({ ok: true, lead_id: leadId }));
    const reply = await (await enabled.send(callBody, headers)).json();
    assert.equal(JSON.parse(reply.result.content[0].text).ok, true);
    const request = enabled.engine[0];
    assert.ok(request);
    assert.equal(request.url, `${origin}/api/engine/leads/${leadId}/changes`);
    assert.equal(request.headers.get("x-carr-csrf"), "synthetic");
    assert.deepEqual(await request.json(), { ...base, ...command });
    assert.deepEqual(enabled.carr, []);

    const beforeCutover = fixture(new Map([["leads-from-engine", "on"]]));
    assert.equal(await (await beforeCutover.send(callBody)).text(), "old");
    assert.deepEqual(beforeCutover.engine, []);
    assert.deepEqual(
      beforeCutover.carr.map((body) => JSON.parse(body)),
      [call(name, { ...base, lead: "L-1", ...args })],
    );
  }

  const claim = call("claim-lead", { ...base, ...lead });
  const conflict = fixture(switches, async () => Response.json({ error: "version_conflict" }, { status: 409 }));
  const reply = await (await conflict.send(claim)).json();
  assert.equal(reply.result.isError, true);
  assert.equal(JSON.parse(reply.result.content[0].text).error, "version_conflict");
  assert.deepEqual(conflict.carr, []);

  const unavailable = fixture(switches, async () => new Response(null, { status: 503 }));
  assert.equal((await unavailable.send(claim)).status, 503);
  assert.deepEqual(unavailable.carr, []);
  const undo = call("update-lead", {
    ...base,
    ...lead,
    fields: { stage: "new" },
    stage_review: { undo_event_id: key, reason: "Example undo", evidence_ids: [] },
  });
  const frozen = fixture(switches);
  const refused = await (await frozen.send(undo)).json();
  assert.equal(JSON.parse(refused.result.content[0].text).error, "old_save_closed");
  assert.deepEqual(frozen.engine, []);
  assert.deepEqual(frozen.carr, []);
});

test("Lead email acknowledgement uses only the engine changes route", async () => {
  const lead_id = "00000000-0000-4000-8000-000000000010";
  const args = { lead_id, base_version: 42, expected_actor: "joe", idempotency_key: lead_id };
  const command = call("acknowledge-lead-email", args);
  const switches = new Map([
    ["leads-from-engine", "on"],
    ["deals-saves-from-engine", "on"],
  ]);
  const enabled = fixture(switches, async () => Response.json({ ok: true, lead_id }));
  const reply = await (await enabled.send(command)).json();
  assert.deepEqual(JSON.parse(reply.result.content[0].text), { ok: true, lead_id });
  const request = enabled.engine[0];
  assert.ok(request);
  assert.equal(request.url, `${origin}/api/engine/leads/${lead_id}/changes`);
  const { lead_id: _, ...body } = args;
  assert.deepEqual(await request.json(), { ...body, action: "acknowledge_email" });
  assert.deepEqual(enabled.carr, []);

  const unavailable = fixture(switches, async () => Response.json({ error: "database_unavailable" }, { status: 503 }));
  assert.equal((await unavailable.send(command)).status, 503);
  assert.deepEqual(unavailable.carr, []);

  for (const switchesOff of [
    new Map(),
    new Map([["leads-from-engine", "on"]]),
    new Map([["deals-saves-from-engine", "on"]]),
  ]) {
    const disabled = fixture(switchesOff);
    const response = await (await disabled.send(command)).json();
    assert.equal(response.result.isError, true);
    assert.deepEqual(disabled.engine, []);
    assert.deepEqual(disabled.carr, []);
  }
});

test("retiring the feed stops forwarding its cursor without changing the legacy response", async () => {
  const switches = new Map([["deals-from-engine", "off"]]);
  const { env, carr } = fixture(switches);
  const read = () => worker.fetch(new Request(`${origin}/pipeline/changes?cursor=synthetic`), env);
  assert.equal(await (await read()).text(), "old");
  assert.equal(carr.length, 1);
  switches.set("deals-from-engine", "on");
  const retired = await read();
  assert.equal(retired.status, 204);
  assert.equal(retired.headers.get("cache-control"), "no-store");
  assert.equal(await retired.text(), "");
  assert.equal(carr.length, 1);
});

test("old installed-app share URLs lead to Deals without forwarding the file", async () => {
  const files = new FormData();
  files.set("files", new File(["synthetic"], "Example.pdf", { type: "application/pdf" }));
  for (const signIn of ["carr", "engine"]) {
    const f = fixture(nextDealsOn);
    const env = { ...f.env, PARTNER_SIGN_IN: signIn };
    for (const [path, method] of [
      ["/share-target", "GET"],
      ["/share-target", "POST"],
      ["/share-intake.html", "GET"],
    ] as const) {
      const response = await worker.fetch(
        new Request(origin + path, { method, body: method === "POST" ? files : null }),
        env,
      );
      assert.equal(response.status, 303, `${signIn} ${method} ${path}`);
      assert.equal(response.headers.get("location"), "/deals");
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.deepEqual(f.carr, []);
    assert.deepEqual(f.engine, []);
  }
});

test("old deliverable HTTP routes are retired in both sign-in modes", async () => {
  for (const signIn of ["carr", "engine"]) {
    const f = fixture(nextDealsOn);
    const env = { ...f.env, PARTNER_SIGN_IN: signIn };
    for (const [path, method] of [
      ["", "POST"],
      ["/demo-deal", "GET"],
      ["/demo-deal/demo-file/download", "GET"],
      ["/demo-deal/demo-file/bytes", "PUT"],
    ] as const) {
      const response = await worker.fetch(new Request(origin + "/api/v1/deal-deliverables" + path, { method }), env);
      assert.equal(response.status, 404, `${signIn} ${method} ${path}`);
    }
    assert.deepEqual(f.carr, []);
    assert.deepEqual(f.engine, []);
  }
});

test("document writes require both Deals switches and preserve bytes and session headers", async () => {
  const bytes = "%PDF-1.7 synthetic";
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes))).toString("hex");
  const files = `/api/engine/files/${digest}`;
  const documents = "/api/engine/deals/00000000-0000-4000-8000-000000000001/documents";
  for (const [path, method, body] of [
    [files, "PUT", bytes],
    [documents, "POST", "{}"],
  ] as const) {
    for (const [reads, saves] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ]) {
      const f = fixture(
        new Map([
          ["deals-from-engine", reads ? "on" : "off"],
          ["deals-saves-from-engine", saves ? "on" : "off"],
        ]),
      );
      const response = await worker.fetch(
        new Request(origin + path, {
          method,
          body,
          headers: { cookie: "session=synthetic", "x-carr-csrf": "synthetic", "content-length": String(body.length) },
        }),
        f.env,
      );
      assert.equal(response.status, reads && saves ? 200 : 404);
      assert.deepEqual(f.carr, []);
      if (reads && saves) {
        const [forwarded] = f.engine;
        assert.ok(forwarded);
        assert.equal(forwarded.url, origin + path);
        assert.equal(forwarded.method, method);
        assert.equal(forwarded.headers.get("x-carr-csrf"), "synthetic");
        assert.equal(forwarded.headers.get("cookie"), "session=synthetic");
        assert.equal(forwarded.headers.get("content-length"), String(body.length));
        assert.equal(await forwarded.text(), body);
      } else assert.deepEqual(f.engine, []);
    }
  }
  assert.equal((await worker.fetch(new Request(origin + documents, { method: "PUT" }), fixture().env)).status, 405);
});

test("a filed deal document streams from the engine only with Deals reads on", async () => {
  const url = `${origin}/api/engine/documents/00000000-0000-4000-8000-000000000001`;
  const request = () => new Request(url, { headers: { cookie: "session=synthetic" } });
  const disabled = fixture(new Map([["deals-saves-from-engine", "on"]]));
  assert.equal((await worker.fetch(request(), disabled.env)).status, 404);
  assert.equal(disabled.engine.length, 0);
  assert.deepEqual(disabled.carr, []);

  const enabled = fixture(
    new Map([["deals-from-engine", "on"]]),
    async () =>
      new Response(new Uint8Array([0, 128, 255]), {
        headers: { "content-disposition": 'attachment; filename="Example.pdf"', "content-type": "application/pdf" },
      }),
  );
  const response = await worker.fetch(request(), enabled.env);
  assert.equal(enabled.engine[0]?.url, url);
  assert.equal(enabled.engine[0]?.headers.get("cookie"), "session=synthetic");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="Example.pdf"');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 128, 255]));
});

test("deal email decisions use the engine only with both Deals switches on", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const key = "00000000-0000-4000-8000-000000000002";
  const decision = call("decide-engine-deal-email", { proposal_id: id, decision: "accept", idempotency_key: key });
  for (const switchKey of ["deals-from-engine", "deals-saves-from-engine"]) {
    const disabled = fixture(new Map([[switchKey, "on"]]));
    const response = await disabled.send(decision);
    assert.equal(disabled.engine.length, 0);
    assert.equal(disabled.carr.length, 0);
    assert.equal((await response.json()).result.isError, true);
  }
  const enabled = fixture("on", async () => Response.json({ proposal_id: id, status: "accepted" }));
  const response = await enabled.send(decision, { origin, cookie: "session=synthetic", "x-carr-csrf": "synthetic" });
  const request = enabled.engine[0];
  assert.ok(request);
  assert.equal(request.url, `${origin}/api/engine/proposals/${id}/decision`);
  assert.equal(request.headers.get("x-carr-csrf"), "synthetic");
  assert.deepEqual(await request.json(), { decision: "accept", idempotency_key: key });
  assert.deepEqual(JSON.parse((await response.json()).result.content[0].text), {
    ok: true,
    proposal_id: id,
    status: "accepted",
  });
  assert.deepEqual(enabled.carr, []);

  const settled = fixture("on", async () => Response.json({ error: "already_decided" }, { status: 409 }));
  const conflict = await (await settled.send(decision)).json();
  assert.equal(conflict.result.isError, true);
  assert.equal(JSON.parse(conflict.result.content[0].text).error, "already_decided");
  assert.deepEqual(settled.carr, []);

  const openStep = fixture("on", async () => Response.json({ error: "open_step_exists" }, { status: 409 }));
  const refusal = await (await openStep.send(decision)).json();
  assert.equal(
    JSON.parse(refusal.result.content[0].text).hint,
    "You already have an open step on this deal. Finish or change it first, or dismiss this suggestion.",
  );

  const unconfirmed = fixture("on", async () => Response.json({ proposal_id: id, status: "dismissed" }));
  assert.equal((await unconfirmed.send(decision)).status, 503);
  assert.deepEqual(unconfirmed.carr, []);
});

for (const value of [null, "off", "ON", "", new Error("KV failed")]) {
  test(`off or unavailable switch preserves CARR request (${String(value)})`, async () => {
    const f = fixture(value);
    const body = call();
    assert.equal(await (await f.send(body)).text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(body)]);
    assert.equal(f.engine.length, 0);
  });
}

test("on routes declared board arguments on app host and wraps verbatim body", async () => {
  const f = fixture();
  const response = await f.send(call("deal-room-board", { workspace: "all deals", account_client_id: "demo&id" }));
  assert.equal(f.engine.length, 1);
  assert.equal(f.carr.length, 0);
  const request = f.engine[0];
  assert.ok(request);
  assert.equal(request.url, `${origin}/api/engine/deals?workspace=all+deals&account_client_id=demo%26id`);
  assert.equal(request.method, "GET");
  assert.equal(request.headers.get("cookie"), "session=synthetic");
  assert.equal(request.headers.get("origin"), origin);
  assert.deepEqual(f.kv, [["deals-from-engine", { cacheTtl: 30 }]]);
  assert.deepEqual(await response.json(), {
    jsonrpc: "2.0",
    id: "synthetic-request",
    result: { content: [{ type: "text", text: payload }] },
  });
});

test("one deal encodes its reference and optional board arguments are absent", async () => {
  const f = fixture();
  await f.send(call("get-deal-room", { deal: "demo/a?b#c" }));
  assert.equal(f.engine[0]?.url, `${origin}/api/engine/deals/demo%2Fa%3Fb%23c`);
  await f.send();
  assert.equal(f.engine[1]?.url, `${origin}/api/engine/deals`);
});

test("the Deal Room people picker searches engine people before the result limit", async () => {
  const args = { query: "Example & Co" };
  const body = call("search-parties-v1", args);
  const parties = JSON.stringify({
    ok: true,
    schema_version: "party-search.v1",
    parties: [{ id: "synthetic-person", display_name: "Example Person", kind: "person" }],
  });
  const enabled = fixture(new Map([["deals-from-engine", "on"]]), async () => new Response(parties));
  const response = await enabled.send(body);
  assert.equal(enabled.engine[0]?.url, `${origin}/api/engine/parties/search?kind=person&query=Example+%26+Co`);
  assert.equal((await response.json()).result.content[0].text, parties);
  assert.deepEqual(enabled.carr, []);

  const disabled = fixture(new Map([["deals-saves-from-engine", "on"]]));
  assert.equal(await (await disabled.send(body)).text(), "old");
  assert.deepEqual(disabled.carr, [JSON.stringify(body)]);
  assert.deepEqual(disabled.engine, []);
});

for (const deal of ["\ud800", "\udc00"]) {
  test(`unpaired surrogate ${JSON.stringify(deal)} falls back with original body`, async () => {
    const f = fixture(dealsReadOn);
    const body = call("get-deal-room", { deal });
    const response = await f.send(body);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(body)]);
    assert.equal(f.engine.length, 0);
    assert.deepEqual(f.kv, [
      ["deals-from-engine", { cacheTtl: 30 }],
      ["deals-saves-from-engine", { cacheTtl: 30 }],
    ]);
  });
}

for (const body of [
  call("other"),
  call("deal-room-board", { workspace: 5 }),
  call("deal-room-board", { extra: "x" }),
  call("get-deal-room", {}),
  call("get-deal-room", { deal: null }),
  call("get-deal-room", { deal: ".." }),
  call("deal-room-board", []),
  call("deal-room-board", null),
  call("deal-room-board", {}, { method: "initialize" }),
]) {
  test(`ineligible call stays on CARR ${JSON.stringify(body)}`, async () => {
    const f = fixture();
    assert.equal(await (await f.send(body)).text(), "old");
    assert.equal(f.engine.length, 0);
    assert.equal(f.kv.length, 0);
  });
}

for (const status of [400, 404, 409, 422]) {
  test(`domain refusal ${status} wraps raw text and renews cookies`, async () => {
    const f = fixture(
      "on",
      async () =>
        new Response('{"error":"synthetic_refusal"}', {
          status,
          headers: [
            ["set-cookie", "session=fresh"],
            ["set-cookie", "other=fresh"],
          ],
        }),
    );
    const response = await f.send();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      jsonrpc: "2.0",
      id: "synthetic-request",
      result: { content: [{ type: "text", text: '{"error":"synthetic_refusal"}' }], isError: true },
    });
    assert.deepEqual(response.headers.getSetCookie(), ["session=fresh", "other=fresh"]);
    assert.equal(f.carr.length, 0);
  });
}
for (const status of [401, 403, 429]) {
  test(`refusal ${status} passes through without fallback`, async () => {
    const f = fixture(
      "on",
      async () => new Response(payload, { status, headers: { "retry-after": "5", "set-cookie": "session=fresh" } }),
    );
    const response = await f.send();
    assert.equal(response.status, status);
    assert.equal(await response.text(), payload);
    assert.equal(response.headers.get("retry-after"), "5");
    assert.equal(response.headers.get("set-cookie"), "session=fresh");
    assert.equal(f.carr.length, 0);
  });
}
for (const status of [500, 502, 503]) {
  test(`engine ${status} falls back with original body`, async () => {
    const f = fixture(dealsReadOn, async () => new Response("down", { status }));
    assert.equal(await (await f.send()).text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(call())]);
  });
}
test("binding error falls back", async () => {
  const f = fixture(dealsReadOn, async () => {
    throw new Error("unavailable");
  });
  assert.equal(await (await f.send()).text(), "old");
});
test("engine deadline falls back even when binding ignores cancellation", async () => {
  const f = fixture(dealsReadOn, () => new Promise(() => {}));
  assert.equal(await (await f.send()).text(), "old");
  assert.equal(f.carr.length, 1);
});
test("engine body deadline falls back", async () => {
  const f = fixture(dealsReadOn, async () => new Response(new ReadableStream({ start() {} })));
  assert.equal(await (await f.send()).text(), "old");
});
test("foreign origin refuses before engine GET can bypass CSRF", async () => {
  const f = fixture();
  const response = await f.send(call(), { origin: "https://foreign.example.test", cookie: "session=synthetic" });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "origin_mismatch" });
  assert.equal(f.engine.length, 0);
  assert.equal(f.carr.length, 0);
});
test("switch is read for every request", async () => {
  const f = fixture("off");
  await f.send();
  f.env.ENGINE_ROUTING.get = async () => "on";
  await f.send();
  assert.equal(f.engine.length, 1);
  assert.equal(f.carr.length, 1);
});

test("successful engine answer renews all session cookies", async () => {
  const f = fixture(
    "on",
    async () =>
      new Response(payload, {
        headers: [
          ["set-cookie", "session=fresh"],
          ["set-cookie", "other=fresh"],
        ],
      }),
  );
  assert.deepEqual((await f.send()).headers.getSetCookie(), ["session=fresh", "other=fresh"]);
});
test("timed out response body is cancelled", async () => {
  let cancelled = false;
  const f = fixture(
    dealsReadOn,
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  assert.equal(await (await f.send()).text(), "old");
  assert.equal(cancelled, true);
});
test("binding response arriving after timeout is disposed without reading", async () => {
  let complete: (response: Response) => void = () => {};
  let cancelled = false;
  const f = fixture(
    dealsReadOn,
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  assert.equal(await (await f.send()).text(), "old");
  complete(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});
test("missing bindings and malformed JSON preserve original proxy behavior", async () => {
  const f = fixture();
  const response = await worker.fetch(new Request(`${origin}/mcp`, { method: "POST", body: "malformed" }), f.env);
  assert.equal(await response.text(), "old");
  const { ENGINE, ENGINE_ROUTING, ...withoutBindings } = f.env;
  assert.ok(ENGINE);
  assert.ok(ENGINE_ROUTING);
  const second = await worker.fetch(
    new Request(`${origin}/mcp`, { method: "POST", body: JSON.stringify(call()) }),
    withoutBindings,
  );
  assert.equal(await second.text(), "old");
  assert.equal(f.engine.length, 0);
});

test("engine failure followed by CARR failure returns server error without signing out", async () => {
  const f = fixture(dealsReadOn, async () => {
    throw new Error("synthetic engine failure");
  });
  f.env.CARR.fetch = async () => {
    throw new Error("synthetic CARR failure");
  };
  const response = await f.send();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "carr_unavailable" });
});
const leadsOn = new Map([["leads-from-engine", "on"]]);

const leadBoard = call("lead-board", { workspace: "leads" });
const afterCutover = new Map([...leadsOn, ["deals-saves-from-engine", "on"]]);
const beforeCutover = new Map([...leadsOn, ["deals-saves-from-engine", "off"]]);

test("Lead board engine 5xx falls back only before cutover", async () => {
  const answer = async () => new Response("down", { status: 502 });
  const after = fixture(afterCutover, answer);
  const before = fixture(beforeCutover, answer);
  const [afterResponse, beforeResponse] = await Promise.all([after.send(leadBoard), before.send(leadBoard)]);
  assert.equal(afterResponse.status, 503);
  assert.deepEqual(await afterResponse.json(), { error: "engine_unavailable" });
  assert.deepEqual(after.carr, []);
  assert.equal(await beforeResponse.text(), "old");
  assert.deepEqual(before.carr, [JSON.stringify(leadBoard)]);
  assert.equal(before.engine.length, 1);
  assert.equal(after.engine.length, 1);
});

// An engine answer that never comes; `asked` settles once the engine has the read.
function silentEngine() {
  let heard = () => {};
  const asked = new Promise<void>((resolve) => {
    heard = resolve;
  });
  let reply: (response: Response) => void = () => {};
  const answer = () => {
    heard();
    return new Promise<Response>((resolve) => {
      reply = resolve;
    });
  };
  return { asked, answer, reply: (response: Response) => reply(response) };
}

for (const [cutover, switches] of [
  ["Before", beforeCutover],
  ["After", afterCutover],
] as const)
  test(`${cutover} cutover on the old sign-in a lead board read the engine has not answered in two seconds ends there`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const engine = silentEngine();
    const f = fixture(switches, engine.answer);
    const response = f.send(leadBoard);
    await engine.asked;
    t.mock.timers.tick(2_000);
    const answered = await response;
    assert.equal(answered.status, cutover === "Before" ? 200 : 503);
    assert.deepEqual(f.carr, cutover === "Before" ? [JSON.stringify(leadBoard)] : []);
  });

// Production and staging: the old system answers nothing, so a read waits for the engine.
function engineSignInFixture(answer: () => Promise<Response>) {
  const f = fixture(leadsOn, answer);
  Object.assign(f.env, { PARTNER_SIGN_IN: "engine", PARTNER_APP: f.env.ENGINE });
  return f;
}

for (const [read, body] of [
  ["lead board", leadBoard],
  ["Deals board", call("deal-room-board", { workspace: "team" })],
] as const) {
  test(`On engine sign-in a ${read} answer slower than two seconds reaches the partner`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const engine = silentEngine();
    const f = engineSignInFixture(engine.answer);
    const response = f.send(body);
    await engine.asked;
    t.mock.timers.tick(9_999);
    engine.reply(new Response(payload));
    const reply = await (await response).json();
    assert.equal(reply.result.content[0].text, payload);
    assert.deepEqual(f.carr, []);
  });
}

test("On engine sign-in a read the engine never answers ends unavailable after ten seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const engine = silentEngine();
  const f = engineSignInFixture(engine.answer);
  const response = f.send(leadBoard);
  await engine.asked;
  t.mock.timers.tick(10_000);
  const answered = await response;
  assert.equal(answered.status, 503);
  assert.deepEqual(await answered.json(), { error: "engine_unavailable" });
  assert.deepEqual(f.carr, []);
});
const cursor = { occurred_at: "2026-01-02T03:04:05.123+00:00", id: "00000000-0000-4000-8000-000000000002" };
for (const [name, args, path] of [
  ["lead-board", { workspace: "leads" }, "/api/engine/leads?workspace=leads"],
  [
    "lead-board",
    {
      workspace: "leads",
      lead_id: "00000000-0000-4000-8000-000000000001",
      correspondence_cursor: cursor,
      stage_history_cursor: "12",
    },
    `/api/engine/leads?workspace=leads&lead_id=00000000-0000-4000-8000-000000000001&correspondence_cursor=${encodeURIComponent(JSON.stringify(cursor))}&stage_history_cursor=12`,
  ],
  ["quiet-follow-ups", {}, "/api/engine/quiet-follow-ups"],
  [
    "quiet-follow-ups",
    { lead_days: 45, vendor_days: 90, owner_slug: "example-partner" },
    "/api/engine/quiet-follow-ups?lead_days=45&vendor_days=90&owner_slug=example-partner",
  ],
  ["list-practice-origination", { limit: 25, before_id: "7" }, "/api/engine/reasons-to-reach-out?limit=25&before_id=7"],
] as const) {
  test(`leads switch routes ${name} ${JSON.stringify(args)} to its engine read`, async () => {
    const f = fixture(leadsOn);
    const response = await f.send(call(name, args));
    assert.equal(f.engine[0]?.url, `${origin}${path}`);
    assert.equal(f.engine[0]?.headers.get("cookie"), "session=synthetic");
    assert.deepEqual(f.kv, [["leads-from-engine", { cacheTtl: 30 }]]);
    assert.equal(f.carr.length, 0);
    assert.deepEqual((await response.json()).result, { content: [{ type: "text", text: payload }] });
  });
}

for (const [name, args] of [
  ["get-deal-room", { deal: "demo" }],
  ["deal-room-board", {}],
] as const) {
  test(`leads switch alone leaves ${name} on CARR`, async () => {
    const f = fixture(leadsOn);
    assert.equal(await (await f.send(call(name, args))).text(), "old");
    assert.deepEqual(f.kv, [["deals-from-engine", { cacheTtl: 30 }]]);
    assert.equal(f.engine.length, 0);
  });
}

for (const value of [null, "off", "ON", new Error("KV failed"), new Map([["deals-from-engine", "on"]])]) {
  test(`leads stay on CARR while their own switch is not on (${String(value)})`, async () => {
    const f = fixture(value);
    const body = call("lead-board", { workspace: "leads" });
    assert.equal(await (await f.send(body)).text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(body)]);
    assert.equal(f.engine.length, 0);
  });
}

for (const body of [
  call("lead-board", {}),
  call("lead-board", { workspace: "other" }),
  call("lead-board", { workspace: "leads", correspondence_cursor: "text" }),
  call("lead-board", { workspace: "leads", correspondence_cursor: [] }),
  call("lead-board", { workspace: "leads", correspondence_cursor: null }),
  call("list-practice-origination", { limit: "25" }),
  call("list-practice-origination", { limit: 25, extra: "x" }),
  call("quiet-follow-ups", { lead_days: "45" }),
  call("quiet-follow-ups", { constructor: "x" }),
  call("quiet-follow-ups", JSON.parse('{"__proto__": "x"}')),
]) {
  test(`ineligible leads call stays on CARR without reading the switch ${JSON.stringify(body.params)}`, async () => {
    const f = fixture(leadsOn);
    assert.equal(await (await f.send(body)).text(), "old");
    assert.equal(f.engine.length, 0);
    assert.equal(f.kv.length, 0);
  });
}

test("frame switch alone leaves the Deals board on CARR", async () => {
  const f = fixture(new Map());
  assert.equal(await (await f.send(call("deal-room-board", { workspace: "all" }))).text(), "old");
  assert.deepEqual(f.kv, [["deals-from-engine", { cacheTtl: 30 }]]);
  assert.equal(f.engine.length, 0);
});

test("numeric MCP request id survives engine wrapping", async () => {
  const f = fixture();
  const response = await f.send(call("deal-room-board", {}, { id: 0 }));
  assert.equal((await response.json()).id, 0);
});

for (const method of ["GET", "HEAD"]) {
  test(`direct engine ${method} preserves the request without reading KV`, async () => {
    const f = fixture(new Error("KV must not be read"), async () => new Response(method === "HEAD" ? null : payload));
    const url = `${origin}/api/engine/deals/demo%2Fa?workspace=all%20deals&workspace=mine`;
    const response = await worker.fetch(
      new Request(url, {
        method,
        headers: { cookie: "session=synthetic", origin, accept: "application/json" },
      }),
      f.env,
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), method === "HEAD" ? "" : payload);
    assert.equal(f.engine.length, 1);
    const request = f.engine[0];
    assert.ok(request);
    assert.equal(request.url, url);
    assert.equal(request.method, method);
    assert.equal(request.headers.get("cookie"), "session=synthetic");
    assert.equal(request.headers.get("origin"), origin);
    assert.equal(request.headers.get("accept"), "application/json");
    assert.equal(request.redirect, "manual");
    assert.deepEqual(f.kv, []);
    assert.deepEqual(f.carr, []);
  });
}

for (const status of [200, 302, 401, 403, 429, 503]) {
  test(`direct engine response ${status} preserves body, headers and separate cookies`, async () => {
    const upstream = new Response(payload, {
      status,
      statusText: "Synthetic",
      headers: [
        ["content-type", "application/json"],
        ["location", "/auth/login"],
        ["retry-after", "5"],
        ["set-cookie", "session=fresh; Expires=Wed, 21 Oct 2037 07:28:00 GMT; HttpOnly"],
        ["set-cookie", "other=fresh; Secure"],
      ],
    });
    const f = fixture("off", async () => upstream);
    const response = await worker.fetch(new Request(`${origin}/api/engine/deals?workspace=mine`), f.env);
    assert.equal(response.status, status);
    assert.equal(response.statusText, upstream.statusText);
    assert.deepEqual([...response.headers], [...upstream.headers]);
    assert.deepEqual(response.headers.getSetCookie(), upstream.headers.getSetCookie());
    assert.equal(await response.text(), payload);
    assert.deepEqual(f.kv, []);
    assert.deepEqual(f.carr, []);
  });
}

for (const appEnv of ["staging", "production"]) {
  test(`direct engine POST forwards unchanged bytes and security headers in ${appEnv}`, async () => {
    const upstream = new Response(payload, { status: 503, headers: { "retry-after": "5" } });
    const f = fixture(new Error("KV must not be read"), async () => upstream);
    const url = `${origin}/api/engine/presence?field=phase%20name&field=other`;
    const body = new Uint8Array([0, 255, 13, 10, 32, 123, 125]);
    const headers = {
      cookie: "session=synthetic",
      origin,
      "sec-fetch-site": "same-origin",
      "x-carr-csrf": "synthetic-csrf",
      "content-type": "application/octet-stream",
    };
    const response = await worker.fetch(new Request(url, { method: "POST", headers, body }), {
      ...f.env,
      APP_ENV: appEnv,
    });
    assert.equal(response, upstream);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "5");
    assert.equal(await response.text(), payload);
    assert.equal(f.engine.length, 1);
    const request = f.engine[0];
    assert.ok(request);
    assert.equal(request.method, "POST");
    assert.equal(request.url, url);
    assert.deepEqual(new Uint8Array(await request.arrayBuffer()), body);
    for (const [name, value] of Object.entries(headers)) assert.equal(request.headers.get(name), value);
    assert.equal(request.redirect, "manual");
    assert.deepEqual(f.kv, []);
    assert.deepEqual(f.carr, []);
  });
}

for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
  test(`direct engine ${method} refuses with Allow before accessing bindings`, async () => {
    const response = await worker.fetch(new Request(`${origin}/api/engine/deals`, { method }), {
      GIT_SHA: "0".repeat(40),
      APP_ENV: "staging",
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD, POST");
    assert.deepEqual(await response.json(), { error: "method_not_allowed" });
  });
}

test("direct engine missing binding returns fixed unavailable response", async () => {
  const f = fixture();
  const { ENGINE, ...env } = f.env;
  assert.ok(ENGINE);
  const response = await worker.fetch(new Request(`${origin}/api/engine/deals`), env);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '{"error":"engine_unavailable"}');
  assert.deepEqual(f.kv, []);
  assert.deepEqual(f.carr, []);
});

test("direct engine throwing binding returns fixed unavailable response without details", async () => {
  const f = fixture("on", async () => {
    throw new Error("sensitive synthetic details");
  });
  const response = await worker.fetch(new Request(`${origin}/api/engine/deals`), f.env);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '{"error":"engine_unavailable"}');
  assert.deepEqual(f.kv, []);
  assert.deepEqual(f.carr, []);
});

for (const path of ["/api/engine", "/api/engine-other/deals"]) {
  test(`direct engine prefix excludes ${path}`, async () => {
    const f = fixture();
    const response = await worker.fetch(new Request(`${origin}${path}`), f.env);
    assert.equal(response.status, 404);
    assert.deepEqual(f.engine, []);
    assert.deepEqual(f.kv, []);
  });
}

const remainingScreens = [
  ["invoices-from-engine", "read-invoice-tracker", "/api/engine/invoices"],
  ["charts-from-engine", "ideal-client-profile", "/api/engine/client-fit"],
  ["national-deals-from-engine", "capture-queue", "/api/engine/capture-queue"],
] as const;

test("Home inbox uses the engine without consulting KV", async () => {
  const f = fixture(new Map([["home-from-engine", "off"]]), async () => new Response(null, { status: 503 }));
  const response = await f.send(call("read-home-inbox-v5"));
  assert.equal(response.status, 503);
  assert.equal(f.engine[0]?.url, origin + "/api/engine/home/inbox");
  assert.deepEqual(f.kv, []);
  assert.deepEqual(f.carr, []);
});

test("Home keeps legacy completion and review calls on CARR for their other callers", async () => {
  const f = fixture(new Map());
  const bodies = [
    "read-home-inbox-v4",
    "read-home-review",
    "complete-one-action",
    "reopen-one-action",
    "edit-email-draft",
  ].map((name) => call(name));
  for (const body of bodies) assert.equal(await (await f.send(body)).text(), "old");
  assert.deepEqual(
    f.carr,
    bodies.map((body) => JSON.stringify(body)),
  );
  assert.deepEqual(f.engine, []);
});

test("Home refuses old mark writes from a snapshot loaded before the switch", async () => {
  const f = fixture(new Map());
  const response = await f.send(
    call("settle-home-inbox", {
      idempotency_key: "4c719df9-2168-4b5a-a26b-95b20376a75f",
      items: [{ item_id: "next_action:00000000-0000-0000-0000-000000000001", base_version: "legacy" }],
    }),
  );
  assert.equal(JSON.parse((await response.json()).result.content[0].text).error, "home_routing_changed");
  assert.equal(f.engine.length + f.carr.length, 0);
});

for (const [key, name, path] of remainingScreens) {
  test(`${key} routes ${name} to its engine read`, async () => {
    const f = fixture(new Map([[key, "on"]]));
    const response = await f.send(call(name));
    assert.equal(f.engine[0]?.url, `${origin}${path}`);
    assert.equal(f.engine[0]?.method, "GET");
    assert.equal(f.engine[0]?.headers.get("cookie"), "session=synthetic");
    assert.deepEqual(f.kv, [[key, { cacheTtl: 30 }]]);
    assert.equal(f.carr.length, 0);
    assert.deepEqual((await response.json()).result, { content: [{ type: "text", text: payload }] });
  });

  for (const value of [null, "off", "ON", "", new Error("KV failed")]) {
    test(`${name} keeps the original CARR body when its switch is ${String(value)}`, async () => {
      const f = fixture(value);
      const body = call(name);
      assert.equal(await (await f.send(body)).text(), "old");
      assert.deepEqual(f.carr, [JSON.stringify(body)]);
      assert.equal(f.engine.length, 0);
    });
  }

  for (const enabled of [
    "deals-from-engine",
    "leads-from-engine",
    "clients-vendors-from-engine",
    "relationships-from-engine",
    ...remainingScreens.map(([screenKey]) => screenKey).filter((screenKey) => screenKey !== key),
  ]) {
    test(`${enabled} alone leaves ${name} on CARR`, async () => {
      const f = fixture(new Map([[enabled, "on"]]));
      const body = call(name);
      assert.equal(await (await f.send(body)).text(), "old");
      assert.deepEqual(f.carr, [JSON.stringify(body)]);
      assert.equal(f.engine.length, 0);
      assert.deepEqual(f.kv, [[key, { cacheTtl: 30 }]]);
    });
  }

  for (const body of [call(name, { extra: "x" }), call(name, { workspace: "all" })]) {
    test(`${name} rejects unsupported arguments before KV ${JSON.stringify(body.params)}`, async () => {
      const f = fixture(new Map([[key, "on"]]));
      assert.equal(await (await f.send(body)).text(), "old");
      assert.deepEqual(f.carr, [JSON.stringify(body)]);
      assert.deepEqual(f.engine, []);
      assert.deepEqual(f.kv, []);
    });
  }

  test(`${key} alone leaves existing reads and writes on CARR`, async () => {
    const f = fixture(new Map([[key, "on"]]));
    for (const body of [
      call("deal-room-board"),
      call("lead-board", { workspace: "leads" }),
      call("read-vendor-meetings"),
      call("find", { query: "Example Clinic" }),
      ...(key === "invoices-from-engine" ? [] : [markPaid]),
      call("set-next-step", { deal: "example-deal", next_step: "Example step" }),
      call("create-national-account", { name: "Example account" }),
    ]) {
      assert.equal(await (await f.send(body)).text(), "old");
      assert.equal(f.carr.at(-1), JSON.stringify(body));
    }
    assert.equal(
      await (await getRead(f, "/api/v1/business/relationships?contract=relationship-network.v1")).text(),
      "old",
    );
    assert.equal(await (await getRead(f, "/pipeline/changes")).text(), "old");
    assert.equal(f.engine.length, 0);
  });
}

const markPaidArgs = {
  commission_id: "00000000-0000-4000-8000-000000000001",
  base_version: 0,
  received_on: "2026-10-02",
  idempotency_key: "00000000-0000-4000-8000-000000000002",
};
const markPaid = call("record-commission-receipt", markPaidArgs);
const invoicesOn = new Map([["invoices-from-engine", "on"]]);

test("Mark paid follows the invoice tracker switch", async () => {
  const receipt = { ok: true, id: markPaidArgs.commission_id, received_on: markPaidArgs.received_on, base_version: 1 };
  const f = fixture(invoicesOn, async () => Response.json(receipt));
  const response = await f.send(markPaid, {
    origin,
    cookie: "session=synthetic",
    "sec-fetch-site": "same-origin",
    "x-carr-csrf": "synthetic",
  });
  const request = f.engine[0];
  assert.ok(request, "Mark paid must reach the engine with the invoice switch on");
  assert.equal(request.url, `${origin}/api/engine/invoices/mark-paid`);
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("cookie"), "session=synthetic");
  assert.equal(request.headers.get("origin"), origin);
  assert.equal(request.headers.get("sec-fetch-site"), "same-origin");
  assert.equal(request.headers.get("x-carr-csrf"), "synthetic");
  assert.deepEqual(await request.json(), markPaidArgs);
  assert.deepEqual(f.kv, [["invoices-from-engine", { cacheTtl: 30 }]]);
  assert.deepEqual(f.carr, []);
  assert.deepEqual((await response.json()).result, {
    content: [{ type: "text", text: JSON.stringify({ ...receipt, engine_receipt: true }) }],
  });
});

test("Mark paid keeps the original CARR call with the invoice switch off", async () => {
  const f = fixture(new Map([["invoices-from-engine", "off"]]));
  assert.equal(await (await f.send(markPaid)).text(), "old");
  assert.deepEqual(f.carr, [JSON.stringify(markPaid)]);
  assert.deepEqual(f.engine, []);
});

test("Mark paid strips the engine receipt marker from the legacy reply", async () => {
  const f = fixture(new Map([["invoices-from-engine", "off"]]));
  const receipt = { ok: true, id: markPaidArgs.commission_id, received_on: markPaidArgs.received_on, base_version: 1 };
  f.env.CARR.fetch = async () =>
    Response.json(
      {
        jsonrpc: "2.0",
        id: markPaid.id,
        result: { content: [{ type: "text", text: JSON.stringify({ ...receipt, engine_receipt: true }) }] },
      },
      { headers: { "set-cookie": "session=synthetic; HttpOnly" } },
    );
  const response = await f.send(markPaid);
  assert.equal(response.headers.get("set-cookie"), "session=synthetic; HttpOnly");
  assert.deepEqual((await response.json()).result.content, [{ type: "text", text: JSON.stringify(receipt) }]);
  assert.deepEqual(f.engine, []);
});

for (const [status, error] of [
  [400, "invalid_field_value"],
  [409, "version_conflict"],
  [409, "key_reuse"],
  [422, "invoice_not_unpaid"],
  [422, "payment_date_out_of_range"],
  [501, "old_system_required"],
  [503, "database_unavailable"],
] as const) {
  test(`Mark paid returns the engine's ${error} without trying CARR`, async () => {
    const refusal = { error };
    const f = fixture(invoicesOn, async () => Response.json(refusal, { status }));
    const response = await f.send(markPaid);
    assert.deepEqual(f.carr, []);
    assert.deepEqual((await response.json()).result, {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(refusal) }],
    });
  });
}

test("charts switch encodes every client fit filter as query text", async () => {
  const f = fixture(new Map([["charts-from-engine", "on"]]));
  await f.send(call("ideal-client-profile", { vertical: "example & practice", city: "Example City", state: "EX" }));
  assert.equal(
    f.engine[0]?.url,
    `${origin}/api/engine/client-fit?vertical=example+%26+practice&city=Example+City&state=EX`,
  );
  assert.equal(f.carr.length, 0);
});

for (const args of [{ vertical: 1 }, { city: null }, { state: ["EX"] }]) {
  test(`invalid client fit filter stays on CARR without KV ${JSON.stringify(args)}`, async () => {
    const f = fixture(new Map([["charts-from-engine", "on"]]));
    const body = call("ideal-client-profile", args);
    assert.equal(await (await f.send(body)).text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(body)]);
    assert.deepEqual(f.kv, []);
    assert.deepEqual(f.engine, []);
  });
}

const searchOn = new Map([["search-from-engine", "on"]]);
const find = call("find", { query: " Example & Clinic " });

test("search switch routes find with its untrimmed query as query text", async () => {
  const f = fixture(searchOn);
  const response = await f.send(find);
  assert.equal(f.engine[0]?.url, `${origin}/api/engine/find?query=+Example+%26+Clinic+`);
  assert.equal(f.engine[0]?.method, "GET");
  assert.equal(f.engine[0]?.headers.get("cookie"), "session=synthetic");
  assert.deepEqual(f.kv, [["search-from-engine", { cacheTtl: 30 }]]);
  assert.equal(f.carr.length, 0);
  assert.deepEqual((await response.json()).result, { content: [{ type: "text", text: payload }] });
});

test("Global Search forwards its version without changing the find arguments", async () => {
  const f = fixture(searchOn);
  await f.send(find, { origin, "x-doctorcre-search": "search.v1" });
  const forwarded = f.engine[0];
  assert.ok(forwarded);
  assert.equal(forwarded.headers.get("x-doctorcre-search"), "search.v1");
  assert.deepEqual(Object.fromEntries(new URL(forwarded.url).searchParams), { query: " Example & Clinic " });
});

for (const value of [
  null,
  "off",
  "ON",
  "",
  new Error("KV failed"),
  ...[
    "deals-from-engine",
    "leads-from-engine",
    "invoices-from-engine",
    "charts-from-engine",
    "national-deals-from-engine",
    "clients-vendors-from-engine",
    "relationships-from-engine",
    "frame-from-engine",
  ].map((key) => new Map([[key, "on"]])),
]) {
  test(`find keeps the original CARR body unless its own switch is on (${value instanceof Map ? [...value.keys()] : String(value)})`, async () => {
    const f = fixture(value);
    assert.equal(await (await f.send(find)).text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(find)]);
    assert.equal(f.engine.length, 0);
    assert.deepEqual(f.kv, [["search-from-engine", { cacheTtl: 30 }]]);
  });
}

// Search's second read, find-and-catch-up, follows the Clients and Vendors switch.
for (const [keys, engineReads] of [
  [["search-from-engine"], ["find"]],
  [["clients-vendors-from-engine"], ["find-and-catch-up"]],
  [
    ["search-from-engine", "clients-vendors-from-engine"],
    ["find", "find-and-catch-up"],
  ],
] as const) {
  test(`with ${keys.join(" and ")} on, Search reads ${engineReads.join(" and ")} from the engine`, async () => {
    const f = fixture(new Map(keys.map((key) => [key, "on"])));
    await f.send(find);
    await f.send(call("find-and-catch-up", { query: " Example & Clinic ", limit: 20 }));
    assert.deepEqual(
      f.engine.map((request) => new URL(request.url).pathname),
      engineReads.map((name) => (name === "find" ? "/api/engine/find" : "/api/engine/recent-activity")),
    );
    assert.equal(f.carr.length, 2 - engineReads.length);
  });
}

for (const args of [{}, { query: "" }, { query: 5 }, { query: null }, { query: "x", limit: 20 }]) {
  test(`ineligible find stays on CARR without reading the switch ${JSON.stringify(args)}`, async () => {
    const f = fixture(searchOn);
    const body = call("find", args);
    assert.equal(await (await f.send(body)).text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(body)]);
    assert.deepEqual(f.engine, []);
    assert.deepEqual(f.kv, []);
  });
}

const directoryOn = new Map([["clients-vendors-from-engine", "on"]]);
test("recent activity routes ref to engine and omits it from the old tool", async () => {
  const args = { query: "Example Clinic", limit: 10, ref: "C-901" };
  const on = fixture(directoryOn);
  await on.send(call("find-and-catch-up", args));
  assert.ok(on.engine[0]);
  assert.equal(new URL(on.engine[0].url).searchParams.get("ref"), "C-901");
  const off = fixture(new Map());
  await off.send(call("find-and-catch-up", args));
  assert.deepEqual(off.carr, [JSON.stringify(call("find-and-catch-up", { query: "Example Clinic", limit: 10 }))]);
});

const recordId = "00000000-0000-4000-8000-0000000000aB";
const getRead = (f: ReturnType<typeof fixture>, path: string, method = "GET") =>
  worker.fetch(new Request(`${origin}${path}`, { method, headers: { cookie: "session=synthetic" } }), f.env);

for (const [name, args, path] of [
  [
    "find-and-catch-up",
    { query: "Example Clinic", limit: 10 },
    "/api/engine/recent-activity?query=Example+Clinic&limit=10",
  ],
  [
    "read-vendor-meetings",
    { view: "suggested", q: "", limit: 5 },
    "/api/engine/vendor-meetings?view=suggested&q=&limit=5",
  ],
  [
    "read-vendor-meetings",
    { view: "research", q: "lender", limit: 5, cursor: "c3ludGhldGlj" },
    "/api/engine/vendor-meetings?view=research&q=lender&limit=5&cursor=c3ludGhldGlj",
  ],
] as const) {
  test(`clients and vendors switch routes ${name} ${JSON.stringify(args)} to its engine read`, async () => {
    const f = fixture(directoryOn);
    const response = await f.send(call(name, args));
    assert.equal(f.engine[0]?.url, `${origin}${path}`);
    assert.deepEqual(f.kv, [["clients-vendors-from-engine", { cacheTtl: 30 }]]);
    assert.equal(f.carr.length, 0);
    assert.deepEqual((await response.json()).result, { content: [{ type: "text", text: payload }] });
  });
}

for (const [path, engine] of [
  ["/api/v1/business/clients", "/api/engine/clients"],
  [
    "/api/v1/business/clients?contract=vendor-directory.v1&q=a%20b&page=2",
    "/api/engine/clients?contract=vendor-directory.v1&q=a%20b&page=2",
  ],
  [`/api/v1/business/clients/${recordId}`, `/api/engine/clients/${recordId}`],
  [
    "/api/v1/business/vendors?contract=vendor-directory.v1&sort=territory",
    "/api/engine/vendors?contract=vendor-directory.v1&sort=territory",
  ],
  [
    `/api/v1/business/vendors/${recordId}?contract=vendor-directory.v2`,
    `/api/engine/vendors/${recordId}?contract=vendor-directory.v2`,
  ],
  ["/api/v1/business/vendors/summary?owner=dell", "/api/engine/vendors/summary?owner=dell"],
] as const) {
  test(`clients and vendors switch routes GET ${path} to the engine unchanged`, async () => {
    const f = fixture(directoryOn, async () => new Response(payload, { headers: { "set-cookie": "session=fresh" } }));
    const response = await getRead(f, path);
    assert.equal(f.engine[0]?.url, `${origin}${engine}`);
    assert.equal(f.engine[0]?.method, "GET");
    assert.equal(f.engine[0]?.headers.get("cookie"), "session=synthetic");
    assert.deepEqual(f.kv, [["clients-vendors-from-engine", { cacheTtl: 30 }]]);
    assert.equal(f.carr.length, 0);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), "session=fresh");
    assert.equal(await response.text(), payload);
  });
}

for (const status of [400, 401, 403, 404, 409, 422, 429]) {
  test(`business GET refusal ${status} comes back as the engine answered it`, async () => {
    const f = fixture(directoryOn, async () => new Response('{"error":"QUERY_INVALID"}', { status }));
    const response = await getRead(f, "/api/v1/business/vendors?page=0");
    assert.equal(response.status, status);
    assert.equal(await response.text(), '{"error":"QUERY_INVALID"}');
    assert.equal(f.carr.length, 0);
  });
}

for (const answer of [
  async () => new Response("down", { status: 503 }),
  async () => {
    throw new Error("unavailable");
  },
  () => new Promise<Response>(() => {}),
]) {
  test(`business GET falls back to CARR when the engine fails (${String(answer)})`, async () => {
    const f = fixture(directoryOn, answer);
    const response = await getRead(f, `/api/v1/business/clients/${recordId}`);
    assert.equal(await response.text(), "old");
    assert.equal(f.carr.length, 1);
  });
}

for (const value of [null, "off", "ON", new Error("KV failed"), leadsOn, new Map([["deals-from-engine", "on"]])]) {
  test(`clients and vendors stay on CARR while their own switch is not on (${String(value)})`, async () => {
    const f = fixture(value);
    assert.equal(await (await getRead(f, "/api/v1/business/clients")).text(), "old");
    assert.equal(await (await getRead(f, "/api/v1/business/vendors")).text(), "old");
    assert.deepEqual(f.carr, ["", ""]);
    assert.equal(f.engine.length, 0);
  });
}

for (const [name, args] of [
  ["deal-room-board", {}],
  ["lead-board", { workspace: "leads" }],
  ["quiet-follow-ups", {}],
] as const) {
  test(`clients and vendors switch alone leaves ${name} on CARR`, async () => {
    const f = fixture(directoryOn);
    assert.equal(await (await f.send(call(name, args))).text(), "old");
    assert.equal(f.engine.length, 0);
  });
}

for (const [method, path] of [
  ["HEAD", "/api/v1/business/clients"],
  ["POST", "/api/v1/business/clients"],
  ["GET", "/api/v1/business/clients/"],
  ["GET", "/api/v1/business/clients/not-a-record-id"],
  ["GET", `/api/v1/business/clients/${recordId}/extra`],
  ["GET", "/api/v1/business/clientsx"],
] as const) {
  test(`${method} ${path} stays on CARR without reading the switch`, async () => {
    const f = fixture(directoryOn);
    assert.equal(await (await getRead(f, path, method)).text(), "old");
    assert.equal(f.engine.length, 0);
    assert.equal(f.kv.length, 0);
  });
}

for (const body of [
  call("find-and-catch-up", { query: 5, limit: 10 }),
  call("find-and-catch-up", { query: "x", limit: "10" }),
  call("find-and-catch-up", { query: "x", extra: "y" }),
  call("read-vendor-meetings", { cursor: {} }),
  call("/api/v1/business/clients", {}),
]) {
  test(`ineligible clients and vendors call stays on CARR without reading the switch ${JSON.stringify(body.params)}`, async () => {
    const f = fixture(directoryOn);
    assert.equal(await (await f.send(body)).text(), "old");
    assert.equal(f.engine.length, 0);
    assert.equal(f.kv.length, 0);
  });
}

for (const path of ["/api/post-call", "/api/v1/business/clients"]) {
  test(`a tool call posted to ${path} stays on CARR without reading the switch`, async () => {
    const f = fixture("on");
    const body = JSON.stringify(call("deal-room-board", {}));
    const response = await worker.fetch(new Request(`${origin}${path}`, { method: "POST", body }), f.env);
    assert.equal(await response.text(), "old");
    assert.deepEqual(f.carr, [body]);
    assert.equal(f.kv.length, 0);
  });
}

const relationshipsOn = new Map([["relationships-from-engine", "on"]]);
const relationshipRead = "/api/v1/business/relationships?contract=relationship-network.v1";

test("relationships switch routes the network GET with unchanged query and response", async () => {
  const f = fixture(relationshipsOn);
  const response = await getRead(f, relationshipRead);
  assert.equal(f.engine[0]?.url, `${origin}/api/engine/relationships?contract=relationship-network.v1`);
  assert.equal(f.engine[0]?.method, "GET");
  assert.equal(f.engine[0]?.headers.get("cookie"), "session=synthetic");
  assert.deepEqual(f.kv, [["relationships-from-engine", { cacheTtl: 30 }]]);
  assert.equal(f.carr.length, 0);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), payload);
});

for (const value of [
  null,
  "off",
  "ON",
  new Error("KV failed"),
  directoryOn,
  leadsOn,
  new Map([["deals-from-engine", "on"]]),
]) {
  test(`relationships stay on CARR unless their own switch is on (${String(value)})`, async () => {
    const f = fixture(value);
    assert.equal(await (await getRead(f, relationshipRead)).text(), "old");
    assert.deepEqual(f.carr, [""]);
    assert.equal(f.engine.length, 0);
  });
}

for (const path of ["/api/v1/business/clients", "/api/v1/business/vendors"]) {
  test(`relationships switch alone leaves GET ${path} on CARR`, async () => {
    const f = fixture(relationshipsOn);
    assert.equal(await (await getRead(f, path)).text(), "old");
    assert.equal(f.engine.length, 0);
  });
}

for (const [name, args] of [
  ["deal-room-board", {}],
  ["lead-board", { workspace: "leads" }],
] as const) {
  test(`relationships switch alone leaves ${name} on CARR`, async () => {
    const f = fixture(relationshipsOn);
    const body = call(name, args);
    assert.equal(await (await f.send(body)).text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(body)]);
    assert.equal(f.engine.length, 0);
  });
}

for (const [method, path] of [
  ["GET", `/api/v1/business/relationships/${recordId}?contract=relationship-network.v1`],
  ["HEAD", relationshipRead],
] as const) {
  test(`relationships ${method} ${path} stays on CARR without reading KV`, async () => {
    const f = fixture(relationshipsOn);
    assert.equal(await (await getRead(f, path, method)).text(), "old");
    assert.equal(f.engine.length, 0);
    assert.deepEqual(f.kv, []);
  });
}

const saveKey = "deal-saves-to-engine";
const savesOn = new Map([[saveKey, "on"]]);
const phaseMove = call("patch-deal-field", {
  deal: "synthetic-deal",
  field: "phase",
  value: "negotiation",
  base_event_id: null,
  idempotency_key: "00000000-0000-4000-8000-000000000001",
});
const saveHeaders = {
  origin,
  cookie: "session=synthetic",
  "sec-fetch-site": "same-origin",
  "x-carr-csrf": "synthetic-token",
};
const answered =
  (text: string, status = 200) =>
  async () =>
    new Response(text, { status });

// The board's closing save, as runOutcomeWrite sends it.
const closing = call("update-deal", {
  deal: "synthetic-deal",
  fields: { outcome: "won", closed_on: "2026-09-30", won_value: 125000 },
  base_version: 7,
  idempotency_key: "00000000-0000-4000-8000-000000000002",
});

for (const save of [phaseMove, closing]) {
  const verb = save.params.name;
  for (const value of [null, "off", new Error("KV failed"), new Map([["deals-from-engine", "on"]])]) {
    test(`save switch off sends ${verb} to the old system (${String(value)})`, async () => {
      const f = fixture(value);
      assert.equal(await (await f.send(save, saveHeaders)).text(), "old");
      assert.deepEqual(f.carr, [JSON.stringify(save)]);
      assert.deepEqual(f.kv, [
        ["deals-saves-from-engine", { cacheTtl: 30 }],
        [saveKey, { cacheTtl: 30 }],
      ]);
      assert.equal(f.engine.length, 0);
    });
  }

  test(`save switch on sends ${verb} with the same arguments and key to the engine with the session headers`, async () => {
    const f = fixture(savesOn, answered('{"ok":true,"updated":["outcome"]}'));
    const response = await f.send(save, saveHeaders);
    assert.equal(f.carr.length, 0);
    const request = f.engine[0];
    assert.ok(request);
    assert.equal(request.url, `${origin}/api/engine/${verb}`);
    assert.equal(request.method, "POST");
    assert.equal(await request.text(), JSON.stringify(save.params.arguments));
    assert.equal(request.headers.get("content-type"), "application/json");
    for (const [key, value] of Object.entries(saveHeaders)) assert.equal(request.headers.get(key), value);
    assert.deepEqual(await response.json(), {
      jsonrpc: "2.0",
      id: "synthetic-request",
      result: { content: [{ type: "text", text: '{"ok":true,"updated":["outcome"]}' }] },
    });
  });

  test(`engine 501 old_system_required sends the original ${verb} to the old system`, async () => {
    const f = fixture(savesOn, answered('{"error":"old_system_required","correlation_id":"c"}', 501));
    assert.equal(await (await f.send(save, saveHeaders)).text(), "old");
    assert.equal(f.engine.length, 1);
    assert.deepEqual(f.carr, [JSON.stringify(save)]);
  });
}

for (const [status, text] of [
  [500, '{"error":"unhandled_verb_failure","verb":"patch-deal-field"}'],
  [503, '{"error":"internal_error"}'],
  [501, '{"error":"not_implemented"}'],
  [409, '{"error":"version_conflict"}'],
  [422, '{"error":"actor_not_provisioned"}'],
  [202, "{}"],
] as const) {
  test(`engine ${status} save answer is surfaced as an old-system refusal and never resent`, async () => {
    const f = fixture(savesOn, answered(text, status));
    const response = await f.send(phaseMove, saveHeaders);
    assert.equal(response.status, 200);
    assert.equal(
      await response.text(),
      JSON.stringify({
        jsonrpc: "2.0",
        id: "synthetic-request",
        result: { isError: true, content: [{ type: "text", text }] },
      }),
    );
    assert.equal(f.carr.length, 0);
  });
}

test("a lost engine save answers like a lost old-system save and is not resent", async () => {
  const lost = fixture(savesOn, async () => {
    throw new Error("connection reset");
  });
  const engineAnswer = await lost.send(phaseMove, saveHeaders);
  assert.equal(lost.carr.length, 0);
  const old = fixture("off");
  old.env.CARR.fetch = async () => {
    throw new Error("connection reset");
  };
  const oldAnswer = await old.send(phaseMove, saveHeaders);
  assert.equal(engineAnswer.status, 503);
  assert.deepEqual([engineAnswer.status, await engineAnswer.text()], [oldAnswer.status, await oldAnswer.text()]);
});

test("a retried save sends the same key to the engine again", async () => {
  const f = fixture(savesOn, answered('{"replayed":true,"ok":true}'));
  await f.send(phaseMove, saveHeaders);
  await f.send(phaseMove, saveHeaders);
  assert.deepEqual(await Promise.all(f.engine.map((request) => request.text())), [
    JSON.stringify(phaseMove.params.arguments),
    JSON.stringify(phaseMove.params.arguments),
  ]);
});

for (const status of [401, 403, 429]) {
  test(`engine ${status} save answer passes through without resending`, async () => {
    const f = fixture(
      savesOn,
      async () => new Response(payload, { status, headers: { "set-cookie": "session=fresh" } }),
    );
    const response = await f.send(phaseMove, saveHeaders);
    assert.equal(response.status, status);
    assert.equal(await response.text(), payload);
    assert.equal(response.headers.get("set-cookie"), "session=fresh");
    assert.equal(f.carr.length, 0);
  });
}

for (const [text, status] of [
  ['{"ok":true,"deal_id":"synthetic-deal","event_id":"e1"}', 200],
  ['{"error":"unhandled_verb_failure","verb":"patch-deal-field"}', 500],
] as const) {
  test(`the screen gets the old system's envelope for the same answer (${status})`, async () => {
    const f = fixture(savesOn, answered(text, status));
    const engineAnswer = await (await f.send(phaseMove, saveHeaders)).text();
    const old = fixture("off");
    // The old system's tools/call reply, as its record layer writes it.
    const result =
      status === 200 ? { content: [{ type: "text", text }] } : { isError: true, content: [{ type: "text", text }] };
    old.env.CARR.fetch = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "synthetic-request", result }));
    assert.equal(engineAnswer, await (await old.send(phaseMove, saveHeaders)).text());
  });
}

test("the engine save sets renewed session cookies on the wrapped answer", async () => {
  const f = fixture(savesOn, async () => new Response("{}", { headers: [["set-cookie", "session=fresh"]] }));
  assert.deepEqual((await f.send(phaseMove, saveHeaders)).headers.getSetCookie(), ["session=fresh"]);
});

for (const body of [call("patch-deal-field", {}, { method: "initialize" })]) {
  test(`save the engine does not take stays on the old system ${JSON.stringify(body)}`, async () => {
    const f = fixture(savesOn);
    assert.equal(await (await f.send(body, saveHeaders)).text(), "old");
    assert.equal(f.engine.length, 0);
    assert.equal(f.kv.length, 0);
  });
}

const oldReply = (text: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: "synthetic-request",
    result: { isError: true, content: [{ type: "text", text }] },
  });
const oldKeyReuse = oldReply('{"error":"key_reuse","hint":"Use a fresh idempotency_key for changed arguments."}');

test("switch off: an old-system key_reuse goes to the engine, whose replay answers it", async () => {
  const f = fixture("off", answered('{"replayed":true,"ok":true}'));
  f.env.CARR.fetch = async () => new Response(oldKeyReuse);
  const response = await f.send(phaseMove, saveHeaders);
  assert.equal(await f.engine[0]?.text(), JSON.stringify(phaseMove.params.arguments));
  assert.deepEqual(await response.json(), {
    jsonrpc: "2.0",
    id: "synthetic-request",
    result: { content: [{ type: "text", text: '{"replayed":true,"ok":true}' }] },
  });
});

test("switch off: when the engine refuses the key too, the screen gets the old system's refusal", async () => {
  const f = fixture("off", answered('{"error":"key_reuse"}', 409));
  f.env.CARR.fetch = async () => new Response(oldKeyReuse);
  assert.equal(await (await f.send(phaseMove, saveHeaders)).text(), oldKeyReuse);
  assert.equal(f.engine.length, 1);
});

test("switch off: an old-system key_reuse the engine can't answer stays uncertain", async () => {
  const f = fixture("off", async () => {
    throw new Error("connection reset");
  });
  f.env.CARR.fetch = async () => new Response(oldKeyReuse);
  const response = await f.send(phaseMove, saveHeaders);
  assert.deepEqual([response.status, await response.json()], [503, { error: "carr_unavailable" }]);
});

test("switch off: any other old-system refusal never reaches the engine", async () => {
  const refusal = oldReply('{"error":"version_conflict"}');
  const f = fixture("off");
  f.env.CARR.fetch = async () => new Response(refusal);
  assert.equal(await (await f.send(phaseMove, saveHeaders)).text(), refusal);
  assert.equal(f.engine.length, 0);
});

const nextDealsOn = new Map([
  ["deals-from-engine", "on"],
  ["deals-saves-from-engine", "on"],
]);
const dealId = "00000000-0000-4000-8000-000000000030";
const stepId = "00000000-0000-4000-8000-000000000031";
const operationId = "00000000-0000-4000-8000-000000000032";
const marketId = "00000000-0000-4000-8000-000000000033";
const invoiceId = "00000000-0000-4000-8000-000000000034";

test("a hand-set attention patch is refused and never reaches the engine", async () => {
  const f = fixture(nextDealsOn);
  const attention = call("patch-deal-field", {
    deal: dealId,
    field: "attention",
    value: true,
    seen_change_id: 23,
    idempotency_key: operationId,
  });
  const response = await f.send(attention, saveHeaders);
  assert.equal(JSON.parse((await response.json()).result.content[0].text).error, "deal_save_unavailable");
  assert.equal(f.engine.length, 0);
  assert.equal(f.carr.length, 0);
});

test("switching Deals saves on keeps failed board and detail reads away from the old database", async () => {
  const f = fixture(nextDealsOn, async () => new Response("down", { status: 503 }));
  for (const body of [call("deal-room-board"), call("get-deal-room", { deal: dealId })]) {
    const response = await f.send(body);
    assert.equal(response.status, 503);
  }
  assert.equal(f.engine.length, 2);
  assert.equal(f.carr.length, 0);
});

test("invoice Undo sends the reviewed receipt to the signed-in engine", async () => {
  const args = { deal: dealId, invoice_id: invoiceId, seen_change_id: 24, idempotency_key: operationId };
  const f = fixture(nextDealsOn, async () => Response.json({ invoice_id: invoiceId, status: "undone" }));
  const response = await f.send(call("undo-invoice-close", args), saveHeaders);
  assert.equal(f.carr.length, 0);
  assert.equal(f.engine[0]?.url, `${origin}/api/engine/invoice-emails/${invoiceId}/undo`);
  assert.equal(f.engine[0]?.headers.get("x-carr-csrf"), new Headers(saveHeaders).get("x-carr-csrf"));
  assert.deepEqual(await f.engine[0]?.json(), { idempotency_key: operationId });
  assert.equal(JSON.parse((await response.json()).result.content[0].text).ok, true);

  const off = fixture("off");
  const stale = await off.send(call("undo-invoice-close", args), saveHeaders);
  assert.equal(JSON.parse((await stale.json()).result.content[0].text).error, "version_conflict");
  assert.equal(off.engine.length + off.carr.length, 0);

  const moved = fixture(nextDealsOn, async () =>
    Response.json({ error: "database_refused_the_statement", rule: "invoice_email_undo_current" }, { status: 422 }),
  );
  const refusal = await moved.send(call("undo-invoice-close", args), saveHeaders);
  assert.equal(JSON.parse((await refusal.json()).result.content[0].text).error, "version_conflict");
});

test("automatic phase Undo never leaves the app when either Deals switch is off", async () => {
  const args = { deal: dealId, event_id: invoiceId, idempotency_key: operationId };
  for (const switches of [new Map(), dealsReadOn, new Map([["deals-saves-from-engine", "on"]])]) {
    const f = fixture(switches);
    for (const undoArgs of [args, { ...args, seen_change_id: 0 }]) {
      const response = await f.send(call("undo-automatic-phase-move", undoArgs), saveHeaders);
      assert.equal(f.engine.length + f.carr.length, 0);
      const { result } = await response.json();
      assert.equal(result.isError, true);
    }
    const read = await f.send(call());
    if (switches.has("deals-from-engine")) {
      assert.equal((await read.json()).result.content[0].text, payload);
      assert.equal(f.engine.length, 1);
      assert.equal(f.carr.length, 0);
    } else {
      assert.equal(await read.text(), "old");
      assert.equal(f.carr.length, 1);
      assert.equal(f.engine.length, 0);
    }
  }
});

const changesPath = `/deals/${dealId}/changes`;
const creation = {
  next_deal_save: true,
  idempotency_key: operationId,
  name: "Example Lease",
  client_id: stepId,
  owner: "dell",
  phase: "research",
  kind: "lease",
  market_id: marketId,
};

test("Add deal keeps its key, owner and client when the engine replays it", async () => {
  const receipt = { deal_id: dealId, change_id: 24, phase_changed_at: "2026-11-18T12:00:00Z" };
  const switches = new Map(nextDealsOn);
  const f = fixture(switches, answered(JSON.stringify(receipt), 201));
  for (let attempt = 0; attempt < 2; attempt++) {
    const { result } = await (await f.send(call("new-deal", creation), saveHeaders)).json();
    assert.deepEqual(JSON.parse(result.content[0].text), { ...receipt, ok: true });
  }
  const { next_deal_save, ...expected } = creation;
  assert.equal(next_deal_save, true);
  assert.equal(f.engine.length, 2);
  for (const request of f.engine) {
    assert.equal(request.url, `${origin}/api/engine/deals`);
    assert.deepEqual(await request.json(), expected);
  }
  switches.delete("deals-saves-from-engine");
  const { result } = await (await f.send(call("new-deal", creation), saveHeaders)).json();
  assert.equal(result.isError, true);
  assert.deepEqual(f.carr, []);
});

for (const [error, rule, hint] of [
  ["database_refused_the_statement", "deal_party_party_id_fkey", "Choose an existing client."],
  ["database_refused_the_statement", "deal_market_id_fkey", "Choose an existing market."],
  ["deal_name_exists", null, "A deal with this name already exists."],
]) {
  test(`Add deal explains ${rule || error} and leaves the save in the engine`, async () => {
    const f = fixture(nextDealsOn, answered(JSON.stringify({ error, rule }), 422));
    const { result } = await (await f.send(call("new-deal", creation), saveHeaders)).json();
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), { error, rule, hint });
    assert.equal(f.engine.length, 1);
    assert.deepEqual(f.carr, []);
  });
}

const movedToEngine = [
  [
    "set-market-agent",
    { agent_party_id: marketId },
    `/deals/${dealId}/parties`,
    { party_id: marketId, role: "market_agent" },
    { deal_id: dealId, party_id: marketId, role: "market_agent" },
    201,
  ],
  [
    "remove-deal-participant",
    { party_id: marketId, role: "market_agent" },
    `/deals/${dealId}/parties/remove`,
    { party_id: marketId, role: "market_agent" },
    { deal_id: dealId, party_id: marketId, role: "market_agent" },
    200,
  ],
  [
    "add-critical-date",
    { kind: "phase_effective_date", due_on: "2027-01-02", source: "Sample agreement", note: "Signed" },
    `/deals/${dealId}/critical-dates`,
    { kind: "phase_effective_date", due_on: "2027-01-02", source: "Sample agreement", note: "Signed" },
    { critical_date_id: stepId, status: "open" },
    201,
  ],
  [
    "confirm-critical-date",
    { critical_date_id: stepId },
    `/critical-dates/${stepId}/confirm`,
    {},
    { critical_date_id: stepId, status: "open" },
    200,
  ],
  ...["done", "dropped", "passed"].map(
    (resolution) =>
      [
        "resolve-critical-date",
        { critical_date_id: stepId, resolution, reason: "Sample decision" },
        `/critical-dates/${stepId}/resolve`,
        { resolution, reason: "Sample decision" },
        { critical_date_id: stepId, status: resolution },
        200,
      ] as const,
  ),
  ...[
    [
      { outcome: "won", closed_on: "2026-11-18", won_value: 125000 },
      { phase: { from: "closing", to: "closed", on: "2026-11-18" }, fields: { closed_value: 125000 } },
    ],
    [{ outcome: "won", closed_on: "2026-11-18" }, { phase: { from: "closing", to: "closed", on: "2026-11-18" } }],
    [
      { outcome: "lost", closed_on: "2026-11-18", lost_reason: "The client chose another site" },
      { phase: { from: "closing", to: "dead", on: "2026-11-18", reason: "The client chose another site" } },
    ],
  ].map(
    ([fields, expected]) =>
      [
        "update-deal",
        { fields, phase_from: "closing" },
        changesPath,
        { seen_change_id: 23, ...expected },
        { deal_id: dealId, change_id: 24 },
        200,
      ] as const,
  ),
  [
    "patch-deal-field",
    { field: "phase", value: "negotiation", phase_from: "research" },
    changesPath,
    { seen_change_id: 23, phase: { from: "research", to: "negotiation" } },
    { deal_id: dealId, change_id: 23 },
    200,
  ],
  [
    "patch-deal-field",
    {
      field: "phase",
      value: "negotiation",
      phase_from: "research",
      change_reason: "Synthetic reason",
      human_quote: "Synthetic quote",
    },
    changesPath,
    { seen_change_id: 23, phase: { from: "research", to: "negotiation", reason: "Synthetic reason" } },
    { deal_id: dealId, change_id: 23 },
    200,
  ],
  [
    "patch-deal-field",
    { field: "owner", value: "dell" },
    changesPath,
    { seen_change_id: 23, fields: { owner: "dell" } },
    { deal_id: dealId, change_id: 24 },
    200,
  ],
  ...[marketId, null].map(
    (value) =>
      [
        "patch-deal-field",
        { field: "market", value },
        changesPath,
        { seen_change_id: 23, fields: { market_id: value } },
        { deal_id: dealId, change_id: 24 },
        200,
      ] as const,
  ),
  [
    "set-next-step",
    { text: "Review sample plan", next_date: "2027-01-02" },
    "/next-steps",
    { deal_id: dealId, what: "Review sample plan", due_on: "2027-01-02", replaces: "current" },
    { next_step_id: stepId, change_id: 25 },
    201,
  ],
  [
    "complete-deal-item",
    { item_id: stepId, base_version: 0 },
    `/next-steps/${stepId}/end`,
    { resolution: "done", base_version: 0 },
    { next_step_id: stepId, status: "done" },
    200,
  ],
  [
    "patch-deal-field",
    { field: "operating_state", value: { state: "parked", reason: "other", note: "Sample pause" } },
    changesPath,
    { seen_change_id: 23, fields: { parking_reason: "other", parking_note: "Sample pause" } },
    { deal_id: dealId, change_id: 24 },
    200,
  ],
  [
    "patch-deal-field",
    { field: "operating_state", value: { state: "parked", reason: "client_paused", note: null } },
    changesPath,
    { seen_change_id: 23, fields: { parking_reason: "client_paused", parking_note: null } },
    { deal_id: dealId, change_id: 24 },
    200,
  ],
  [
    "patch-deal-field",
    { field: "operating_state", value: { state: "active" } },
    changesPath,
    { seen_change_id: 23, fields: { parking_reason: null, parking_note: null } },
    { deal_id: dealId, change_id: 24 },
    200,
  ],
  [
    "add-deal-note",
    { text: "A sample update", happened_at: "2026-11-18T12:00:00Z" },
    "/activities",
    { kind: "note", summary: "A sample update", happened_at: "2026-11-18T12:00:00Z", about: [{ deal_id: dealId }] },
    { activity_id: stepId },
    201,
  ],
  [
    "record-deal-item",
    { title: "Review plan", bullets: [], source_ref: "app:example" },
    "/next-steps",
    { deal_id: dealId, what: "Review plan", item: { title: "Review plan", bullets: [], source_ref: "app:example" } },
    { next_step_id: stepId, change_id: 25 },
    201,
  ],
] as const;

for (const [verb, args, path, expected, receipt, status] of movedToEngine) {
  test(`Deals cutover routes ${verb} ${path} once per attempt and keeps its key on retry`, async () => {
    const { phase_from, base_version, ...legacy } = { phase_from: undefined, base_version: undefined, ...args };
    const base = { deal: dealId, idempotency_key: operationId, ...legacy };
    const before = call(verb, base);
    const off = fixture(null);
    await off.send(before, saveHeaders);
    assert.deepEqual(off.carr, [JSON.stringify(before)]);
    assert.equal(off.engine.length, 0);
    const on = fixture(nextDealsOn, answered(JSON.stringify(receipt), status));
    const save = call(verb, { ...base, seen_change_id: 23, ...(phase_from && { phase_from }), base_version });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = (await (await on.send(save, saveHeaders)).json()).result;
      assert.deepEqual(JSON.parse(result.content[0].text), { ...receipt, ok: true });
    }
    assert.deepEqual(on.carr, []);
    assert.equal(on.engine.length, 2);
    for (const request of on.engine) {
      assert.equal(request.url, `${origin}/api/engine${path}`);
      assert.equal(request.method, "POST");
      assert.deepEqual(await request.json(), { idempotency_key: operationId, ...expected });
      for (const [key, value] of Object.entries(saveHeaders)) assert.equal(request.headers.get(key), value);
    }
  });
}

test("Deals cutover refuses to complete an item without a valid step version", async () => {
  const f = fixture(nextDealsOn);
  for (const base_version of [undefined, null, -1, 3.5, "7", Number.MAX_SAFE_INTEGER + 1]) {
    const save = call("complete-deal-item", {
      deal: dealId,
      item_id: stepId,
      seen_change_id: 23,
      idempotency_key: operationId,
      base_version,
    });
    const { result } = await (await f.send(save, saveHeaders)).json();
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error, "version_conflict");
  }
  assert.deepEqual(f.engine, []);
  assert.deepEqual(f.carr, []);
});

test("Deals cutover refuses a bare market agent name before sending a write", async () => {
  const f = fixture(nextDealsOn);
  const save = call("set-market-agent", {
    deal: dealId,
    seen_change_id: 23,
    idempotency_key: operationId,
    agent_name: "Sample Agent",
  });
  const { result } = await (await f.send(save, saveHeaders)).json();
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).hint, "Choose an existing person as the market agent.");
  assert.deepEqual(f.engine, []);
  assert.deepEqual(f.carr, []);
});

test("a successful HTTP response with the wrong date status leaves the outcome unknown", async () => {
  const f = fixture(nextDealsOn, answered(JSON.stringify({ critical_date_id: stepId, status: "open" })));
  const save = call("resolve-critical-date", {
    deal: dealId,
    seen_change_id: 23,
    idempotency_key: operationId,
    critical_date_id: stepId,
    resolution: "done",
    reason: "Sample decision",
  });
  const response = await f.send(save, saveHeaders);
  assert.deepEqual([response.status, await response.json()], [503, { error: "carr_unavailable" }]);
  assert.deepEqual(f.carr, []);
});

for (const [verb, args] of [
  ["set-lead", { new_lead: "dell" }],
  ["add-deal-participant", { party_id: marketId, role: "listing_side" }],
] as const) {
  test(`Deals cutover refuses the old ${verb} save`, async () => {
    const f = fixture(nextDealsOn);
    const save = call(verb, { ...args, deal: dealId, seen_change_id: 23, idempotency_key: operationId });
    const reply = await (await f.send(save, saveHeaders)).json();
    assert.equal(reply.result.isError, true);
    assert.match(JSON.parse(reply.result.content[0].text).hint, /deal page/);
    assert.deepEqual(f.carr, []);
    assert.deepEqual(f.engine, []);
  });
}

test("Deals cutover explains a refused critical date decision", async () => {
  const f = fixture(
    nextDealsOn,
    answered('{"error":"database_refused_the_statement","rule":"critical_date_status_moves"}', 422),
  );
  const save = call("resolve-critical-date", {
    deal: dealId,
    seen_change_id: 23,
    idempotency_key: operationId,
    critical_date_id: stepId,
    resolution: "passed",
    reason: "Sample decision",
  });
  const { result } = await (await f.send(save, saveHeaders)).json();
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).hint, "This date cannot be marked that way.");
  assert.deepEqual(f.carr, []);
});

test("Deals cutover forwards a stale phase refusal and never tries CARR", async () => {
  const f = fixture(nextDealsOn, answered('{"error":"version_conflict","current_phase":"legal"}', 409));
  const save = call("patch-deal-field", {
    deal: dealId,
    field: "phase",
    value: "negotiation",
    phase_from: "research",
    seen_change_id: 23,
    idempotency_key: operationId,
  });
  const { result } = await (await f.send(save, saveHeaders)).json();
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    error: "version_conflict",
    current_phase: "legal",
    hint: "This deal changed. Reload the deal before saving.",
  });
  assert.equal(f.engine.length, 1);
  assert.deepEqual(f.carr, []);
});

for (const verb of ["new-deal", "set-market-agent", "update-deal"]) {
  test(`Deals cutover refuses ${verb} while the signed-in save is unavailable`, async () => {
    const f = fixture(nextDealsOn);
    const { result } = await (
      await f.send(call(verb, { deal: dealId, idempotency_key: operationId }), saveHeaders)
    ).json();
    assert.equal(result.isError, true);
    assert.deepEqual(f.carr, []);
    assert.deepEqual(f.engine, []);
  });
}

test("an unanswered next-schema save never retries in CARR after the switch turns off", async () => {
  const switches = new Map(nextDealsOn);
  const f = fixture(switches, answered('{"error":"database_unavailable"}', 503));
  const save = call("set-next-step", {
    deal: dealId,
    seen_change_id: 23,
    idempotency_key: operationId,
    text: "Review sample plan",
  });
  assert.equal((await f.send(save, saveHeaders)).status, 503);
  switches.delete("deals-saves-from-engine");
  const { result } = await (await f.send(save, saveHeaders)).json();
  assert.equal(result.isError, true);
  assert.equal(f.engine.length, 1);
  assert.deepEqual(f.carr, []);
});

test("the new save switch refuses saves loaded before the read cutover", async () => {
  const f = fixture(nextDealsOn);
  const save = call("set-next-step", {
    deal: dealId,
    base_version: 2,
    idempotency_key: operationId,
    text: "Review sample plan",
  });
  const { result } = await (await f.send(save, saveHeaders)).json();
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error, "version_conflict");
  assert.deepEqual(f.engine, []);
  assert.deepEqual(f.carr, []);
});

test("Home forwards the single-card mark and preserves the engine refusal", async () => {
  const args = {
    idempotency_key: "4c719df9-2168-4b5a-a26b-95b20376a75f",
    item_id: "next_action:00000000-0000-0000-0000-000000000001",
    base_version: "2147483648:0:inbox",
    action: "snooze",
    until: "2099-01-01T00:00:00Z",
  };
  const refused = { error: "version_conflict", current_version: "2147483649:0:inbox" };
  const f = fixture(new Map(), async () => Response.json(refused, { status: 409 }));
  const response = await f.send(call("save-engine-home-mark", args));
  assert.equal(f.carr.length, 0);
  const [request] = f.engine;
  assert.ok(request);
  assert.equal(new URL(request.url).pathname, "/api/engine/home/marks");
  assert.deepEqual(await request.json(), args);
  assert.equal(request.headers.get("cookie"), "session=synthetic");
  assert.deepEqual((await response.json()).result, {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(refused) }],
  });
});

test("Home identifies a successful engine snapshot for the app's save routing", async () => {
  const f = fixture(new Map(), async () => Response.json({ ok: true, schema_version: "home-inbox.v5", items: [] }));
  const reply = await (await f.send(call("read-home-inbox-v5"))).json();
  assert.equal(JSON.parse(reply.result.content[0].text).engine_marks, true);
});

test("the Deals step end HTTP route requires both switches and a versioned request", async () => {
  const id = "00000000-0000-0000-0000-000000000001";
  const path = `/api/engine/next-steps/${id}/end`;
  const command = { resolution: "done", base_version: 0, idempotency_key: id };
  const headers = {
    origin,
    cookie: "session=synthetic",
    "x-carr-csrf": "synthetic",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  const request = (body: Partial<typeof command>) =>
    new Request(origin + path, { method: "POST", headers, body: JSON.stringify(body) });
  for (const [reads, saves] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ]) {
    const f = fixture(
      new Map([
        ["deals-from-engine", reads ? "on" : "off"],
        ["deals-saves-from-engine", saves ? "on" : "off"],
      ]),
    );
    const response = await worker.fetch(request(command), f.env);
    assert.equal(response.status, reads && saves ? 200 : 409);
    assert.deepEqual(f.carr, []);
    if (reads && saves) {
      assert.equal(f.engine.length, 1);
      assert.equal(f.engine[0]?.url, origin + path);
      assert.equal(f.engine[0]?.method, "POST");
      assert.equal(f.engine[0]?.headers.get("cookie"), headers.cookie);
      assert.equal(f.engine[0]?.headers.get("origin"), headers.origin);
      assert.equal(f.engine[0]?.headers.get("x-carr-csrf"), headers["x-carr-csrf"]);
      assert.equal(f.engine[0]?.headers.get("sec-fetch-site"), headers["sec-fetch-site"]);
      assert.deepEqual(await f.engine[0]?.json(), command);
      for (const invalid of [
        { resolution: "done", idempotency_key: id },
        { resolution: "done", base_version: 0 },
      ]) {
        assert.equal((await worker.fetch(request(invalid), f.env)).status, 400);
      }
      assert.equal(f.engine.length, 1);
    } else {
      assert.deepEqual(await response.json(), { error: "reload_deals" });
      assert.deepEqual(f.engine, []);
    }
  }
});

test("Home routes guarded step and review actions through signed-in engine doors", async () => {
  const id = "00000000-0000-0000-0000-000000000001";
  const f = fixture(new Map(), async () => Response.json({ success: true }));
  const step = { idempotency_key: id, base_version: 2147483648, resolution: "done" };
  await f.send(call("end-engine-home-step", { id, ...step }));
  await f.send(call("read-engine-home-proposal", { id }));
  await f.send(call("decide-engine-home-proposal", { id, idempotency_key: id, decision: "accept" }));
  await f.send(call("read-engine-home-draft", { id }));
  await f.send(
    call("edit-engine-home-draft", { id, idempotency_key: id, version: 2, subject: "Example", body: "Example reply" }),
  );
  assert.deepEqual(
    f.engine.map((request) => [request.method, new URL(request.url).pathname]),
    [
      ["POST", `/api/engine/next-steps/${id}/end`],
      ["GET", `/api/engine/proposals/${id}`],
      ["POST", `/api/engine/proposals/${id}/decision`],
      ["GET", `/api/engine/reply-drafts/${id}`],
      ["POST", `/api/engine/reply-drafts/${id}/edit`],
    ],
  );
  assert.deepEqual(await f.engine[0]?.json(), step);
  assert.deepEqual(f.carr, []);
});

test("Home forwards the selected deal when previewing a filing", async () => {
  const id = "00000000-0000-0000-0000-000000000001";
  const deal_id = "00000000-0000-0000-0000-000000000002";
  const f = fixture(new Map(), async () => Response.json({ reason_required: false, hint: null }));
  await f.send(call("read-engine-home-proposal", { id, deal_id }));
  assert.equal(f.engine[0]?.url, `${origin}/api/engine/proposals/${id}?deal_id=${deal_id}`);
  assert.deepEqual(f.carr, []);
});

test("the retired Mail priorities read no longer reaches the engine", async () => {
  const f = fixture(new Map(), async () => Response.json({ ok: true, items: [] }));
  const request = new Request(`${origin}/api/v1/intelligence/mail-needs-partner?limit=25`, {
    headers: { cookie: "session=synthetic" },
  });
  await worker.fetch(request, f.env);
  assert.deepEqual(f.engine, []);
});

test("client website setup and opening use their Deals switches without changing the legacy save", async () => {
  const deal = "00000000-0000-4000-8000-000000000001";
  const path = `/api/engine/deals/${deal}/client-website`;
  const args = { slug: "example-website", password: "synthetic-password", idempotency_key: deal };
  for (const [reads, saves] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ]) {
    const f = fixture(
      new Map([
        ["deals-from-engine", reads ? "on" : "off"],
        ["deals-saves-from-engine", saves ? "on" : "off"],
      ]),
    );
    const headers = {
      origin,
      cookie: "session=synthetic",
      "x-carr-csrf": "synthetic",
      "content-type": "application/json",
    };
    const setup = await worker.fetch(
      new Request(origin + path, { method: "POST", headers, body: JSON.stringify(args) }),
      f.env,
    );
    const configured = { ...f.env, CLIENT_WEBSITE_ORIGIN: "https://share.example.test" };
    const open = await worker.fetch(
      new Request(origin + path + "/open", { method: "POST", headers, body: "{}" }),
      configured,
    );
    assert.equal(setup.status, reads && saves ? 200 : 404);
    assert.equal(open.status, reads ? 200 : 404);
    assert.deepEqual(
      f.engine.map((request) => new URL(request.url).pathname),
      [...(reads && saves ? [path] : []), ...(reads ? [path + "/open"] : [])],
    );
    if (reads && saves) assert.deepEqual(await f.engine[0]?.json(), args);
    if (reads) {
      assert.deepEqual(await f.engine.at(-1)?.json(), {});
      assert.equal(f.engine.at(-1)?.headers.get("x-carr-csrf"), "synthetic");
    }
    assert.deepEqual(f.carr, []);
    if (!reads && !saves) {
      const legacy = call("register-client-portal", { deal, ...args });
      assert.equal(await (await f.send(legacy, headers)).text(), "old");
      assert.deepEqual(f.carr, [JSON.stringify(legacy)]);
    }
  }
});

test("national account creation and owner changes follow the Deals switches", async () => {
  const account = "00000000-0000-4000-8000-000000000011";
  const key = "00000000-0000-4000-8000-000000000012";
  for (const [name, oldArgs, path, body] of [
    [
      "create-national-account",
      { name: "Demo Separate Company", owner: "dell" },
      "/national-accounts",
      { name: "Demo Separate Company", owner: "dell", force_new: true },
    ],
    [
      "create-national-account",
      { name: "Demo Matching Company", owner: "dell" },
      "/national-accounts",
      { name: "Demo Matching Company", owner: "dell", company_id: account },
    ],
    [
      "set-national-account-owner",
      { account_client_id: account, owner: "dell", base_version: 0 },
      `/national-accounts/${account}/owner`,
      { owner: "dell", base_version: 0 },
    ],
  ] as const) {
    const legacy = call(name, { ...oldArgs, idempotency_key: key });
    const off = fixture(new Map());
    assert.equal(await (await off.send(legacy)).text(), "old");
    assert.deepEqual(
      off.carr.map((text) => JSON.parse(text)),
      [legacy],
    );
    assert.equal(off.engine.length, 0);

    const next = call(name, { ...oldArgs, ...body, idempotency_key: key, next_deal_save: true });
    for (const routing of [new Map(), dealsReadOn, new Map([["deals-saves-from-engine", "on"]])]) {
      const partial = fixture(routing);
      assert.equal((await (await partial.send(next)).json()).result.isError, true);
      assert.equal(partial.engine.length, 0);
      assert.deepEqual(partial.carr, []);
    }

    const on = fixture("on", async () => Response.json({ account_client_id: account, owner: "dell" }));
    const response = await on.send(next, { origin, cookie: "session=synthetic", "x-carr-csrf": "synthetic" });
    assert.deepEqual(on.carr, []);
    assert.equal(on.engine[0]?.url, `${origin}/api/engine${path}`);
    assert.equal(on.engine[0]?.headers.get("x-carr-csrf"), "synthetic");
    assert.deepEqual(await on.engine[0]?.json(), { ...body, idempotency_key: key });
    assert.deepEqual(JSON.parse((await response.json()).result.content[0].text), {
      ok: true,
      account_client_id: account,
      owner: "dell",
    });
  }
});

test("an existing company name asks for separate-company confirmation", async () => {
  const candidates = [
    {
      id: "00000000-0000-4000-8000-000000000013",
      name: "Demo Matching Company",
      city: "Austin",
      deal_count: 3,
      is_national_account: true,
    },
  ];
  const on = fixture("on", async () => Response.json({ error: "account_name_exists", candidates }, { status: 409 }));
  const response = await on.send(
    call("create-national-account", {
      next_deal_save: true,
      idempotency_key: "00000000-0000-4000-8000-000000000012",
      name: candidates[0]?.name,
      owner: "joe",
    }),
  );
  const result = (await response.json()).result;
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text).candidates, candidates);
  assert.equal(JSON.parse(result.content[0].text).needs_confirm, true);
});

test("a company conversion with a different account in the receipt stays unconfirmed", async () => {
  const company_id = "00000000-0000-4000-8000-000000000013";
  const idempotency_key = "00000000-0000-4000-8000-000000000012";
  const on = fixture("on", async () =>
    Response.json({ account_client_id: "00000000-0000-4000-8000-000000000014", owner: "joe" }),
  );
  const response = await on.send(
    call("create-national-account", {
      next_deal_save: true,
      company_id,
      idempotency_key,
      name: "Example Company",
      owner: "joe",
    }),
  );
  assert.equal(response.status, 503);
  assert.equal(on.engine.length, 1);
  assert.deepEqual(on.carr, []);
});

test("market-deal choices and saves use the new engine behind the Deals switches", async () => {
  const [account, market, location, deal, key] = [1, 2, 3, 4, 5].map(
    (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  );
  const oldArgs = {
    account_client_id: account,
    client_name: "Demo Existing Location",
    deal_name: "Demo Metro Office",
    market: "Demo Metro",
    idempotency_key: key,
  };
  const name = "create-national-market-deal";
  const next = {
    next_deal_save: true,
    account_client_id: account,
    name: "Demo Metro Office",
    market_id: market,
    client_id: location,
    owner: "joe",
    phase: "pending",
    reason: "start_up",
    idempotency_key: key,
  };
  const paths = ["/api/engine/markets", `/api/engine/national-accounts/${account}/locations`];
  for (const path of paths) {
    const request = () => new Request(origin + path, { headers: { cookie: "session=synthetic" } });
    const off = fixture(new Map());
    assert.equal((await worker.fetch(request(), off.env)).status, 404);
    assert.deepEqual(off.engine, []);
    const on = fixture(dealsReadOn);
    assert.equal((await worker.fetch(request(), on.env)).status, 200);
    assert.equal(on.engine[0]?.url, origin + path);
    assert.equal(on.engine[0]?.headers.get("cookie"), "session=synthetic");
  }
  const off = fixture(new Map());
  assert.equal(await (await off.send(call(name, oldArgs))).text(), "old");
  assert.deepEqual(
    off.carr.map((text) => JSON.parse(text)),
    [call(name, oldArgs)],
  );
  assert.deepEqual(off.engine, []);
  const readsOnly = fixture(dealsReadOn);
  assert.equal((await (await readsOnly.send(call(name, next))).json()).result.isError, true);
  assert.deepEqual(readsOnly.carr, []);
  assert.deepEqual(readsOnly.engine, []);
  const on = fixture("on", async () => Response.json({ deal_id: deal, change_id: 0 }, { status: 201 }));
  const reply = await (await on.send(call(name, next))).json();
  assert.equal(reply.result.isError, undefined);
  assert.equal(JSON.parse(reply.result.content[0].text).deal_id, deal);
  assert.equal(on.engine[0]?.url, origin + "/api/engine/deals");
  assert.deepEqual(await on.engine[0]?.json(), {
    national_account_id: account,
    name: next.name,
    market_id: market,
    client_id: location,
    owner: "joe",
    phase: "pending",
    reason: "start_up",
    idempotency_key: key,
  });
});

test("old settle operations cannot reach the engine Home marks door", async () => {
  const f = fixture(new Map());
  for (const action of ["settle", "unsettle"]) {
    const response = await f.send(call("save-engine-home-mark", { action }));
    assert.equal((await response.json()).result.isError, true);
  }
  assert.deepEqual(f.engine, []);
  assert.deepEqual(f.carr, []);
});

for (const signIn of ["carr", "engine"] as const) {
  for (const marker of ["on", "off", null, new Error("KV unavailable")]) {
    test(`Closing anniversaries accepts old leases links with ${signIn} sign-in and saves marker ${marker}`, async () => {
      const switches = new Map([
        ["deals-from-engine", "on"],
        ["leads-from-engine", "on"],
        ["invoices-from-engine", "on"],
        ["charts-from-engine", "on"],
        ["national-deals-from-engine", "on"],
        ["search-from-engine", "on"],
        ["clients-vendors-from-engine", "on"],
        ["relationships-from-engine", "on"],
        ["home-from-engine", "on"],
        ["frame-from-engine", "on"],
        ["deal-cutover-date", "2026-11-20"],
      ]);
      const { env } = fixture(switches);
      const read = env.ENGINE_ROUTING.get;
      const requestEnv = {
        ...env,
        APP_ENV: signIn === "carr" ? "production" : "staging",
        PARTNER_SIGN_IN: signIn,
        WORKSPACE_COMMAND_CENTER_READ_ENABLED: "true",
        ENGINE_ROUTING: {
          get: async (key: string) => {
            if (key !== "deals-saves-from-engine") return read(key);
            if (marker instanceof Error) throw marker;
            return marker;
          },
        },
        CARR: {
          fetch: async (request: Request) => {
            assert.equal(signIn, "carr");
            assert.equal(new URL(request.url).pathname, "/business");
            assert.equal(request.headers.get("cookie"), "__Host-dealroom_session=synthetic");
            return new Response(null);
          },
        },
        PARTNER_APP: {
          fetch: async (request: Request) => {
            assert.equal(signIn, "engine");
            assert.equal(new URL(request.url).pathname, "/auth/session");
            assert.equal(request.headers.get("cookie"), "__Host-doctorcre_session=synthetic");
            return new Response(null);
          },
        },
        ASSETS: {
          fetch: async (request: Request) => new Response(new URL(request.url).pathname, { status: 200 }),
        },
      };
      for (const path of ["/leases", "/leases?mode=live&lease=old", "/leases?quarter=2027-Q1&scope=mine"]) {
        const request = new Request(origin + path, {
          method: "HEAD",
          headers: {
            cookie: signIn === "engine" ? "__Host-doctorcre_session=synthetic" : "__Host-dealroom_session=synthetic",
          },
        });
        const response = await worker.fetch(request, requestEnv);
        assert.equal(response.status, 200, path);
        assert.equal(await response.text(), "/lease-anniversaries.html", path);
      }
    });
  }
}

test("workspace HTML selects engine switches independently", async (t) => {
  const html = "<!doctype html><html><body>Example workspace</body></html>";
  const setAttribute = t.mock.fn();
  const transform = t.mock.fn((asset: Response) => asset);
  class Rewriter {
    on(selector: string, handler: { element: (node: { setAttribute: typeof setAttribute }) => void }) {
      assert.equal(selector, "html");
      handler.element({ setAttribute });
      return this;
    }
    transform = transform;
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "HTMLRewriter");
  Object.defineProperty(globalThis, "HTMLRewriter", { configurable: true, value: Rewriter });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "HTMLRewriter", original);
    else Reflect.deleteProperty(globalThis, "HTMLRewriter");
  });

  for (const path of [
    "/",
    "/inbox",
    "/invoices",
    "/deals",
    "/deals?view=national",
    "/tours/day.html",
    "/review-workflows",
    "/leases",
    "/client-portal",
    "/vendors",
  ]) {
    for (const home of [false, true]) {
      for (const [deals, saves] of [
        [false, false],
        [false, true],
        [true, false],
        [true, true],
      ]) {
        setAttribute.mock.resetCalls();
        transform.mock.resetCalls();
        const tourPlans = !deals && !saves;
        const switches = new Map([
          ["deal-tours-from-engine", tourPlans ? "on" : "off"],
          ["home-from-engine", "off"],
          ["clients-vendors-from-engine", path === "/vendors" ? "on" : "off"],
          ["deals-from-engine", deals ? "on" : "off"],
          ["deals-saves-from-engine", saves ? "on" : "off"],
          ["deal-cutover-date", "2025-06-12"],
        ]);
        const { env, kv } = fixture(switches);
        const get = env.ENGINE_ROUTING.get;
        env.ENGINE_ROUTING.get = async (...args) => {
          const value = await get(...args);
          const [key] = args;
          if (typeof key === "string" && (value === "on" || value === "off"))
            switches.set(key, value === "on" ? "off" : "on");
          return value;
        };
        const ASSETS = {
          fetch: t.mock.fn(
            async (_request: Request) => new Response(html, { headers: { "content-type": "text/html" } }),
          ),
        };
        const assetEnv = { ...env, APP_ENV: home ? "production" : "fixture", ASSETS };
        const response = await worker.fetch(new Request(origin + path), assetEnv);
        assert.equal(response.status, 200);
        for (const key of ["deals-from-engine", "deals-saves-from-engine"])
          assert.equal(
            kv.filter((args) => Array.isArray(args) && args[0] === key).length,
            1,
            `${path} reads ${key} once`,
          );
        assert.ok(!kv.some((args) => Array.isArray(args) && args[0] === "home-from-engine"));
        const chosen = ASSETS.fetch.mock.calls[0]?.arguments[0];
        if (path === "/review-workflows")
          assert.equal(
            new URL(chosen?.url ?? "").pathname,
            home ? "/review-workflows-moved.html" : "/review-workflows.html",
          );
        if (path === "/leases") assert.equal(new URL(chosen?.url ?? "").pathname, "/lease-anniversaries.html");
        if (path === "/client-portal")
          assert.equal(
            new URL(chosen?.url ?? "").pathname,
            saves ? "/client-website-moved.html" : "/client-portal.html",
          );
        const attributes = setAttribute.mock.calls.map(({ arguments: args }) => args[0]).sort();
        const expected = [
          ...(path === "/vendors" ? ["data-clients-vendors-from-engine"] : []),
          ...(tourPlans && new URL(chosen?.url ?? "").pathname === "/pipeline.html"
            ? ["data-deal-tours-from-engine"]
            : []),
          ...(deals ? ["data-deals-from-engine"] : []),
          ...(saves ? ["data-deals-saves-from-engine"] : []),
          ...(home ? ["data-home-today-from-engine"] : []),
        ];
        assert.deepEqual(attributes, expected, path);
        const date = setAttribute.mock.calls.find(({ arguments: args }) => args[0] === "data-deals-saves-from-engine");
        if (saves)
          assert.equal(date?.arguments[1], ["/", "/inbox", "/deals", "/leases"].includes(path) ? "2025-06-12" : "");
        assert.equal(transform.mock.callCount(), Number(expected.length > 0));
        if (!expected.length) {
          assert.equal(await response.text(), html);
        }
      }
    }
  }
});

test("Home Today reads only the engine in the deployed app", async () => {
  const path = "/api/engine/home/today?owner=dell";
  const request = () => new Request(origin + path, { headers: { cookie: "session=synthetic" } });

  const on = fixture(new Map([["home-from-engine", "off"]]));
  const response = await worker.fetch(request(), on.env);
  assert.equal(await response.text(), payload);
  assert.equal(on.engine[0]?.url, origin + path);
  assert.equal(on.engine[0]?.headers.get("cookie"), "session=synthetic");
  assert.deepEqual(on.carr, []);

  const unavailable = fixture(new Map(), async () => new Response(null, { status: 503 }));
  assert.equal((await worker.fetch(request(), unavailable.env)).status, 503);
  assert.deepEqual(unavailable.carr, []);
});

test("Home Today preserves the engine's partner and owner refusals", async () => {
  const enabled = new Map();
  for (const [query, status, error] of [
    ["", 403, "AUTHORIZATION_REFUSED"],
    ["?owner=example", 400, "unknown_owner"],
  ] as const) {
    const f = fixture(enabled, async () => Response.json({ error }, { status }));
    const response = await worker.fetch(new Request(`${origin}/api/engine/home/today${query}`), f.env);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
    assert.deepEqual(f.carr, []);
  }
});

test("Home meeting answers use the signed-in engine routes", async () => {
  const review = "0123456789abcdef";
  const key = "00000000-0000-8000-8000-000000000001";
  const activity = "/api/engine/activities";
  const dismissal = `/api/engine/calendar/reviews/${review}/dismissal`;
  const meeting = { kind: "meeting", calendar_review_key: review, idempotency_key: key };
  const legacy = [
    call("log-activity", { kind: "meeting", calendar_event_key: review }),
    call("answer-board-question", { board_id: "calendar-agenda", question_id: review }),
  ];
  const writes = [
    [activity, meeting],
    [dismissal, { idempotency_key: key }],
  ] as const;
  const post = (path: string, body: object) =>
    new Request(origin + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-carr-csrf": "synthetic" },
      body: JSON.stringify(body),
    });
  const on = fixture(new Map());
  for (const request of legacy) {
    const answer = await (await on.send(request)).json();
    assert.equal(answer.result.isError, true);
    assert.equal(JSON.parse(answer.result.content[0].text).error, "home_routing_changed");
  }
  for (const [path, body] of writes) assert.equal((await worker.fetch(post(path, body), on.env)).status, 200);
  assert.deepEqual(on.carr, []);
  assert.deepEqual(
    on.engine.map((request) => new URL(request.url).pathname),
    [activity, dismissal],
  );
  assert.deepEqual(
    await Promise.all(on.engine.map((request) => request.json())),
    writes.map(([, body]) => body),
  );
  assert.ok(on.engine.every((request) => request.headers.get("x-carr-csrf") === "synthetic"));
});

test("a stale weekly review cannot write to CARR after Deals switches", async () => {
  const body = call("start-deal-review");
  const off = fixture(new Map());
  assert.equal(await (await off.send(body)).text(), "old");
  assert.deepEqual(off.carr, [JSON.stringify(body)]);

  const on = fixture(new Map([["deals-saves-from-engine", "on"]]));
  const response = await on.send(body);
  const reply = await response.json();
  assert.equal(reply.id, body.id);
  assert.equal(reply.result.isError, true);
  assert.match(JSON.parse(reply.result.content[0].text).hint, /Monday review/);
  assert.deepEqual(on.carr, []);
  assert.deepEqual(on.engine, []);
});

function liveClientWrites(source: string): Set<string> {
  const verbs = new Set<string>();
  traverse(parse(source, { sourceType: "module" }), {
    CallExpression(path) {
      const callee = path.get("callee");
      if (!callee.isIdentifier()) return;
      const { name } = callee.node;
      if (!["write", "save", "rawRpc", "emailAction", "requestMcp"].includes(name)) return;
      const verb = path.get("arguments")[name === "emailAction" ? 1 : 0];
      assert.ok(verb?.isExpression(), `Missing verb at ${path.node.loc?.start.line}`);
      if (verb.isIdentifier({ name: "verb" })) {
        const parameter = verb.scope.getBinding("verb");
        const owner = parameter?.scope.path;
        const parent = owner?.parentPath;
        const helper = owner?.isFunctionDeclaration()
          ? owner.node.id?.name
          : parent?.isVariableDeclarator() && parent.node.id.type === "Identifier"
            ? parent.node.id.name
            : undefined;
        if (
          parameter?.kind === "param" &&
          ((name === "requestMcp" && helper === "rawRpc") ||
            (name === "rawRpc" && helper !== undefined && ["rpc", "write", "save", "emailAction"].includes(helper)))
        )
          return;
        if (
          name === "write" &&
          owner?.isObjectMethod() &&
          owner.node.key.type === "Identifier" &&
          owner.node.key.name === "triageSystemWork"
        ) {
          const allowed = path.scope.getBinding("allowed")?.path;
          assert.ok(allowed?.isVariableDeclarator());
          const initializer = allowed.get("init");
          assert.ok(initializer.isNewExpression() && initializer.get("callee").isIdentifier({ name: "Set" }));
          const list = initializer.get("arguments")[0]?.evaluate();
          assert.ok(list?.confident && Array.isArray(list.value), "Unresolved triage verbs");
          for (const value of list.value) {
            assert.equal(typeof value, "string");
            verbs.add(value);
          }
          return;
        }
      }
      const resolved = verb.evaluate();
      assert.ok(
        resolved.confident && typeof resolved.value === "string",
        `Unresolved ${name} verb at line ${path.node.loc?.start.line}`,
      );
      verbs.add(resolved.value);
    },
  });
  verbs.delete("morning-brief"); // rawRpc bypasses the read cache on refresh.
  return verbs;
}

test("every live client mutation is routed, refused, or accounted for after cutover", async () => {
  const client = readFileSync(new URL("../js/live-client.js", import.meta.url), "utf8");
  const keep = new Set([
    "acknowledge-notification",
    "read-client-portal",
    "watch-subject-v2",
    "replace-subject-watch-policy-v2",
    "pause-subject-watch-v2",
    "resume-subject-watch-v2",
    "unwatch-subject-v2",
  ]);
  const outside = new Map([
    ["presence-lease", "Transient Deals editing presence has no copied record."],
    ...["add-loop", "update-loop", "close-loop", "add-industry-event", "update-industry-event"].map(
      (verb) => [verb, "Neither loops nor industry events are copied."] as const,
    ),
    ...[
      "decline-work-request",
      "supersede-work-request",
      "set-work-shape-disposition",
      "link-incident-work-request",
      "add-room-turn",
      "answer-work-request-for-joe",
      "review-and-triage",
      "cancel-capability-session",
      "triage-incident",
      "cancel-workflow-cutover-plan",
      "advance-workflow-cutover-stage",
      "confirm-slice-completions",
      "close-investigation",
      "accept-ready-plan-amendment",
      "approve-retrieval-proposals",
    ].map((verb) => [verb, "Control Room work stays in CARR. Calendar answers are checked separately."] as const),
    ...[
      "decide-doc-suggestion",
      "propose-doc-correction",
      "submit-doc-request",
      "create-doc-conversation",
      "rename-doc-conversation",
      "share-doc-conversation",
    ].map((verb) => [verb, "Doc conversations and requests stay in CARR."] as const),
  ]);
  const switches = new Map([...nextDealsOn, ["home-from-engine", "on"], ["invoices-from-engine", "on"]]);
  const additional = [
    ...keep,
    "claim-lead",
    "update-lead",
    "link-lead-client",
    "new-lead",
    "approve-lead-draft",
    "new-client",
    "add-party",
    "update-party-contact",
    "new-vendor",
    "merge-vendor-rows",
    "add-deal-participant",
    "append-tour-selection-cart-version",
    "reopen-one-action",
    "save-deal-space-search-v1",
    "run-deal-space-search-v1",
    "set-client-publication",
    "start-deal-deliverable",
    "abandon-deal-deliverable",
    "finalize-deal-deliverable",
    "set-deal-deliverable-visibility",
    "snooze-home-inbox",
    "settle-home-inbox",
    "unsettle-home-inbox",
  ];
  async function verify(verbs: Iterable<string>) {
    for (const name of verbs) {
      const f = fixture(switches);
      const body = call(name);
      const response = await f.send(body);
      if (name === "answer-board-question") {
        assert.equal(response.status, 404);
        assert.deepEqual(f.carr, []);
      } else if (keep.has(name) || outside.has(name)) {
        assert.equal(await response.text(), "old", name);
        assert.deepEqual(f.carr, [JSON.stringify(body)], outside.get(name) ?? name);
      } else {
        assert.deepEqual(f.carr, [], `${name} can still save to CARR`);
        if (!f.engine.length) {
          const reply = await response.json();
          assert.equal(reply.result.isError, true, name);
          assert.ok(JSON.parse(reply.result.content[0].text).hint, name);
        }
      }
    }
  }
  await verify(new Set([...liveClientWrites(client), ...additional]));
  const templateWrite = `function probe() { write(\`synthetic-\${"unclassified-save"}\`, {}); }`;
  await assert.rejects(
    verify(liveClientWrites(client + "\n" + templateWrite)),
    /synthetic-unclassified-save can still save/,
  );
  assert.throws(
    () => liveClientWrites(client + "\nfunction probe(name) { write(name, {}); }"),
    /Unresolved write verb/,
  );
});

test("the MCP Tour cart write still forwards before the switch", async () => {
  const body = call("append-tour-selection-cart-version");
  const off = fixture(new Map());
  assert.equal(await (await off.send(body)).text(), "old");
  assert.deepEqual(off.carr, [JSON.stringify(body)]);
});

test("legacy HTTP writes in the pinned contracts have a cutover disposition", async () => {
  const index = new URL("../contracts/carr-interface.v1/http_surfaces/", import.meta.url);
  const surfaces = readdirSync(index)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const entry: unknown = JSON.parse(readFileSync(new URL(file, index), "utf8"));
      assert.ok(entry && typeof entry === "object" && "value" in entry && typeof entry.value === "string", file);
      return entry.value;
    });
  const reads = new Set([
    "/api/tours/feedback",
    "/api/tours/properties/search",
    "/api/tours/property-evidence/v1",
    "/api/v1/atlas-graph",
    "/api/v1/business/*",
    "/api/v1/call-sessions/{id}",
    "/api/v1/call-sessions/{id}/report",
    "/api/v1/command-center",
    "/api/v1/fact-review/comparison/validate",
    "/api/v1/fact-review/documents",
    "/api/v1/fact-review/list",
    "/api/v1/market-terms/read",
    "/api/v1/work-inventory",
    "/pipeline/changes",
  ]);
  const keptPhone = [phone.admission, phone.transfer, phone.answer];
  const phoneMethods = new Map(keptPhone.map(({ method, path }) => [path, method]));
  const contractWrites = Object.keys(tourComposer.writes).map((path) => `POST ${path}`);

  async function verify(paths: string[]) {
    const routes = new Set(contractWrites);
    for (const path of new Set([...paths, ...phoneMethods.keys()])) {
      // The producer's path-only index also lists reads and unrelated workspaces.
      if (
        reads.has(path) ||
        ["/api/room/", "/api/share/", "/api/system-work/"].some((prefix) => path.startsWith(prefix))
      )
        continue;
      routes.add(`${phoneMethods.get(path) ?? "POST"} ${path}`);
    }
    for (const route of routes) {
      const [method, path] = route.split(" ");
      assert.ok(method && path);
      const send = (f: ReturnType<typeof fixture>) =>
        worker.fetch(
          new Request(origin + path.replaceAll(/\{[^}]+\}|\*/g, "cutover-example"), { method, body: "payload" }),
          f.env,
        );
      const off = fixture(new Map());
      assert.equal(await (await send(off)).text(), "old", route);
      assert.deepEqual(off.carr, ["payload"], route);
      const on = fixture(nextDealsOn);
      const response = await send(on);
      if (phoneMethods.has(path)) {
        assert.equal(await response.text(), "old", route);
        assert.deepEqual(on.carr, ["payload"], route);
      } else {
        assert.equal(response.status, 409, `${route} is unguarded`);
        assert.match(
          (await response.json()).error,
          path.startsWith("/api/tours/") ? /Tours on the deal page/ : /Documents/,
        );
        assert.deepEqual(on.carr, [], route);
      }
    }
  }
  await verify(surfaces);
  await assert.rejects(
    verify([...surfaces, "/api/v1/fact-review/synthetic-unclassified-save"]),
    /POST \/api\/v1\/fact-review\/synthetic-unclassified-save is unguarded/,
  );
});

test("the cutover preserves the local report and read-only Tour search", async () => {
  const f = fixture(nextDealsOn);
  for (const [method, path] of [
    ["GET", "/api/post-call"],
    ["GET", "/api/tours/detail"],
    ["POST", "/api/tours/properties/search"],
  ] as const) {
    const response = await worker.fetch(new Request(origin + path, { method }), f.env);
    assert.equal(await response.text(), "old", path);
  }
  assert.equal(f.carr.length, 3);
});

test("Home-only legacy saves are refused independently of Deals", async () => {
  for (const name of ["review-deal-update", "snooze-home-inbox", "settle-home-inbox", "unsettle-home-inbox"]) {
    const home = fixture(new Map());
    const reply = await (await home.send(call(name))).json();
    assert.match(JSON.parse(reply.result.content[0].text).hint, /Home/);
    assert.deepEqual(home.carr, []);
  }
});

test("a wrapped Deal save cannot reach the old system", async () => {
  const f = fixture(nextDealsOn);
  const reply = await (await f.send(call("call-verb", { verb: "patch-deal-field", args: {} }))).json();
  assert.equal(reply.result.isError, true);
  assert.deepEqual(f.carr, []);
});

test("live client prospect and Monday review HTTP saves route to the engine", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const f = fixture(nextDealsOn);
  for (const [entry, target] of [
    ["prospects", "prospects"],
    ["prospects/note", "activities"],
    ["prospects/follow-up", "next-steps"],
    [`prospects/${id}/changes`, `prospects/${id}/changes`],
    [`prospects/${id}/drop`, `prospects/${id}/drop`],
    ["weekly-reviews", "weekly-reviews"],
    [`weekly-reviews/${id}/remove`, `weekly-reviews/${id}/remove`],
  ] as const) {
    const response = await worker.fetch(
      new Request(`${origin}/api/engine/${entry}`, {
        method: "POST",
        body: "{}",
      }),
      f.env,
    );
    assert.equal(response.status, 200, entry);
    assert.equal(f.engine.at(-1)?.url, `${origin}/api/engine/${target}`);
  }
  assert.deepEqual(f.carr, []);
});

test("Party saves and their read reach the engine only with Clients and Vendors on the engine", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const doors: [string, string][] = [
    ["POST", "/api/engine/parties"],
    ["POST", `/api/engine/parties/${id}`],
    ["GET", `/api/engine/parties/${id}`],
    ["POST", "/api/engine/clients"],
    ["POST", `/api/engine/clients/${id}`],
    ["POST", "/api/engine/vendors"],
    ["POST", `/api/engine/vendors/${id}`],
    ["POST", "/api/engine/party-links"],
    ["GET", "/api/engine/parties/search?query=Avery"],
  ];
  for (const [method, path] of doors) {
    const request = () =>
      new Request(origin + path, {
        method,
        headers: { cookie: "session=synthetic", origin },
        ...(method === "POST" && { body: "{}" }),
      });
    const off = fixture(new Map());
    assert.equal((await worker.fetch(request(), off.env)).status, 404, `${method} ${path}`);
    assert.deepEqual(off.engine, []);
    const on = fixture(new Map([["clients-vendors-from-engine", "on"]]));
    assert.equal((await worker.fetch(request(), on.env)).status, 200, `${method} ${path}`);
    assert.equal(on.engine[0]?.url, origin + path);
  }
});

test("An introduction saves only with Clients and Vendors, Deals and Deal saves on the engine", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const clientsVendors = ["clients-vendors-from-engine", "on"] as const;
  const dealsRead = ["deals-from-engine", "on"] as const;
  const dealSaves = ["deals-saves-from-engine", "on"] as const;
  for (const path of [
    "/api/engine/introductions",
    `/api/engine/introductions/${id}`,
    `/api/engine/introductions/${id}/remove`,
  ]) {
    const request = () =>
      new Request(origin + path, { method: "POST", headers: { cookie: "session=synthetic", origin }, body: "{}" });
    for (const routing of [
      [],
      [clientsVendors],
      [clientsVendors, dealsRead],
      [clientsVendors, dealSaves],
      [dealsRead, dealSaves],
    ]) {
      const off = fixture(new Map(routing));
      assert.equal((await worker.fetch(request(), off.env)).status, 404, `${path} with ${routing.map(([k]) => k)}`);
      assert.deepEqual(off.engine, []);
    }
    const on = fixture(new Map([clientsVendors, dealsRead, dealSaves]));
    assert.equal((await worker.fetch(request(), on.env)).status, 200, path);
    assert.equal(on.engine[0]?.url, origin + path);
  }
});

test("A Deals client search still answers while Clients and Vendors read the old system", async () => {
  const deals = fixture(
    new Map([
      ["deals-from-engine", "on"],
      ["deals-saves-from-engine", "on"],
    ]),
  );
  const path = "/api/engine/parties/search?query=Avery&role=client";
  const response = await worker.fetch(
    new Request(origin + path, { headers: { cookie: "session=synthetic", origin } }),
    deals.env,
  );
  assert.equal(response.status, 200);
  assert.equal(deals.engine[0]?.url, origin + path);
});

test("A deal's party saves reach the engine only with Deals and Deal saves on the engine", async () => {
  const deal = "00000000-0000-4000-8000-000000000002";
  for (const door of ["parties", "parties/remove"]) {
    const path = `/api/engine/deals/${deal}/${door}`;
    const request = () =>
      new Request(origin + path, {
        method: "POST",
        headers: { cookie: "session=synthetic", origin },
        body: "{}",
      });
    for (const routing of [
      new Map(),
      new Map([["clients-vendors-from-engine", "on"]]),
      dealsReadOn,
      new Map([["deals-saves-from-engine", "on"]]),
    ]) {
      const off = fixture(routing);
      assert.equal((await worker.fetch(request(), off.env)).status, 404, `${path} with ${[...routing.keys()]}`);
      assert.deepEqual(off.engine, []);
    }
    const on = fixture(nextDealsOn);
    assert.equal((await worker.fetch(request(), on.env)).status, 200, path);
    assert.equal(on.engine[0]?.url, origin + path);
  }
});

test("A closed party save names New, Edit or Link only while Clients and Vendors read the engine", async () => {
  const hints = {
    "new-client": ["Open Clients and choose New client.", "Open Clients to see the current records."],
    "add-party": [
      "Open Clients or Vendors and choose New client or New vendor.",
      "Open Search to find the current record.",
    ],
    "link-parties": [
      "Open the client or vendor and choose Link to someone.",
      "Open Search to find the current record.",
    ],
    "update-party-contact": ["Open the client or vendor and choose Edit.", "Open Search to find the current record."],
    "new-vendor": ["Open Vendors and choose New vendor.", "Open Vendors to see the current records."],
  };
  for (const [verb, [on, off]] of Object.entries(hints))
    for (const [switches, hint] of [
      [
        new Map([
          ["deals-saves-from-engine", "on"],
          ["clients-vendors-from-engine", "on"],
        ]),
        on,
      ],
      [new Map([["deals-saves-from-engine", "on"]]), off],
    ] as const) {
      const frozen = fixture(switches);
      const reply = await (await frozen.send(call(verb, {}))).json();
      assert.deepEqual(JSON.parse(reply.result.content[0].text), { error: "old_save_closed", hint }, verb);
      assert.deepEqual(frozen.carr, []);
    }
});
