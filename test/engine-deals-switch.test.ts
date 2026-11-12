import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

const origin = "https://app.example.test";
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
    DEALS_ROUTING: {
      get: async (...args: unknown[]) => {
        kv.push(args);
        if (value instanceof Error) throw value;
        return value;
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
  const send = (body = call(), headers = { origin, cookie: "session=synthetic" }) =>
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

for (const deal of ["\ud800", "\udc00"]) {
  test(`unpaired surrogate ${JSON.stringify(deal)} falls back with original body`, async () => {
    const f = fixture();
    const body = call("get-deal-room", { deal });
    const response = await f.send(body);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(body)]);
    assert.equal(f.engine.length, 0);
    assert.deepEqual(f.kv, [["deals-from-engine", { cacheTtl: 30 }]]);
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
    const f = fixture("on", async () => new Response("down", { status }));
    assert.equal(await (await f.send()).text(), "old");
    assert.deepEqual(f.carr, [JSON.stringify(call())]);
  });
}
test("binding error falls back", async () => {
  const f = fixture("on", async () => {
    throw new Error("unavailable");
  });
  assert.equal(await (await f.send()).text(), "old");
});
test("engine deadline falls back even when binding ignores cancellation", async () => {
  const f = fixture("on", () => new Promise(() => {}));
  assert.equal(await (await f.send()).text(), "old");
  assert.equal(f.carr.length, 1);
});
test("engine body deadline falls back", async () => {
  const f = fixture("on", async () => new Response(new ReadableStream({ start() {} })));
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
  f.env.DEALS_ROUTING.get = async () => "on";
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
    "on",
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
    "on",
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
  const { ENGINE, DEALS_ROUTING, ...withoutBindings } = f.env;
  assert.ok(ENGINE);
  assert.ok(DEALS_ROUTING);
  const second = await worker.fetch(
    new Request(`${origin}/mcp`, { method: "POST", body: JSON.stringify(call()) }),
    withoutBindings,
  );
  assert.equal(await second.text(), "old");
  assert.equal(f.engine.length, 0);
});

test("engine failure followed by CARR failure returns server error without signing out", async () => {
  const f = fixture("on", async () => {
    throw new Error("synthetic engine failure");
  });
  f.env.CARR.fetch = async () => {
    throw new Error("synthetic CARR failure");
  };
  const response = await f.send();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "carr_unavailable" });
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

for (const method of ["POST", "DELETE", "OPTIONS"]) {
  test(`direct engine ${method} refuses with Allow before accessing bindings`, async () => {
    const response = await worker.fetch(new Request(`${origin}/api/engine/deals`, { method }), {
      GIT_SHA: "0".repeat(40),
      APP_ENV: "staging",
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
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
