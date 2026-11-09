import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public-shell/sw.js", import.meta.url), "utf8");
async function worker() {
  const handlers = new Map<string, (event: object) => void>();
  let token: string | null = "synthetic-session",
    online = true,
    cacheWrites = 0,
    networkPosts = 0;
  let now = Date.now();
  const clients = new Set(["intake-a", "intake-b"]);
  const context = {
    URL,
    Response,
    Request,
    Blob,
    File,
    AbortSignal,
    crypto,
    Date: { now: () => now },
    clearTimeout,
    setTimeout: () => 1,
    caches: {
      keys: async () => [],
      delete: async () => true,
      open: async () => ({
        put: async () => {
          cacheWrites++;
        },
      }),
    },
    fetch: async (input: Request | string) => {
      if (!online) throw Error("offline");
      if (input === "/auth/session")
        return new Response(JSON.stringify({ actor: { slug: "synthetic" }, csrf_token: token }), {
          status: token ? 200 : 401,
        });
      if (input instanceof Request && input.method === "POST") networkPosts++;
      return new Response("network");
    },
    self: {
      location: { origin: "https://app.example" },
      clients: { get: async (id: string) => (clients.has(id) ? { id } : undefined) },
      addEventListener(name: string, handler: (event: object) => void) {
        handlers.set(name, handler);
      },
    },
  };
  vm.runInNewContext(source, context);
  return {
    elapse(ms: number) {
      now += ms;
    },
    get cacheWrites() {
      return cacheWrites;
    },
    get networkPosts() {
      return networkPosts;
    },
    session(value: string | null) {
      token = value;
    },
    offline() {
      online = false;
    },
    async post(
      path = "/share-target",
      type = "application/pdf",
      origin = "https://app.example",
      size = 6,
      chunkSize?: number,
    ) {
      const form = new FormData();
      form.set("files", new File([new Uint8Array(size)], "Demo.pdf", { type }));
      let request = new Request(`https://app.example${path}`, { method: "POST", body: form, headers: { origin } });
      if (chunkSize) {
        const bytes = new Uint8Array(await request.arrayBuffer());
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let offset = 0; offset < bytes.length; offset += chunkSize)
              controller.enqueue(bytes.slice(offset, offset + chunkSize));
            controller.close();
          },
        });
        const options = { method: "POST", headers: request.headers, body, duplex: "half" };
        request = new Request(request.url, options);
      }
      let response: Promise<Response> | undefined;
      handlers.get("fetch")?.({
        request,
        respondWith(value: Promise<Response>) {
          response = value;
        },
      });
      return response;
    },
    closeClient(id: string) {
      clients.delete(id);
    },
    async message(action = "read", clientId = "intake-a") {
      let promise: Promise<void> | undefined, result: unknown;
      handlers.get("message")?.({
        data: { type: "doctorcre-share", csrf: token, action },
        source: { url: "https://app.example/share-intake.html", id: clientId },
        ports: [
          {
            postMessage(value: unknown) {
              result = value;
            },
          },
        ],
        waitUntil(value: Promise<void>) {
          promise = value;
        },
      });
      await promise;
      return result;
    },
    async revoke() {
      let promise: Promise<void> | undefined;
      handlers.get("message")?.({
        data: { type: "doctorcre-session-revoked" },
        waitUntil(value: Promise<void>) {
          promise = value;
        },
      });
      await promise;
    },
  };
}
test("share POST hands off exact bytes through 303 without shell cache or network POST", async () => {
  const x = await worker();
  const response = await x.post();
  assert.equal(response?.status, 303);
  assert.equal(response?.headers.get("location"), "/share-intake.html");
  const result = await x.message();
  assert.ok(result && typeof result === "object" && "share" in result);
  assert.equal(x.cacheWrites, 0);
  assert.equal(x.networkPosts, 0);
});
test("unknown POST remains network-only", async () => {
  const x = await worker();
  assert.equal((await x.post("/unknown"))?.status, 200);
  assert.equal(x.networkPosts, 1);
  assert.equal(x.cacheWrites, 0);
});
for (const [label, type, origin, size] of [
  ["cross-origin", "application/pdf", "https://other.example", 1],
  ["wrong type", "text/html", "https://app.example", 1],
  ["oversize", "application/pdf", "https://app.example", 26214401],
] as const)
  test(`${label} visibly refuses without caching`, async () => {
    const x = await worker();
    const response = await x.post("/share-target", type, origin, size);
    assert.match(response?.headers.get("location") ?? "", /refused=/);
    assert.equal(x.cacheWrites, 0);
  });
test("second share is refused and cannot replace first", async () => {
  const x = await worker();
  await x.post();
  const first = await x.message();
  assert.match((await x.post())?.headers.get("location") ?? "", /refused=busy/);
  assert.deepEqual(await x.message(), first);
});
for (const mode of ["signed-out", "offline", "stale-session", "sign-out"])
  test(`${mode} returns no bytes`, async () => {
    const x = await worker();
    if (mode === "signed-out") x.session(null);
    if (mode === "offline") x.offline();
    const response = await x.post();
    if (mode === "stale-session") x.session("different-session");
    if (mode === "sign-out") await x.revoke();
    const reply = await x.message();
    assert.ok(reply && typeof reply === "object" && "ok" in reply && reply.ok === false);
    if (mode === "signed-out" || mode === "offline") assert.match(response?.headers.get("location") ?? "", /refused=/);
  });
test("explicit clear removes custody", async () => {
  const x = await worker();
  await x.post();
  await x.message("clear");
  assert.deepEqual(JSON.parse(JSON.stringify(await x.message())), {
    ok: false,
    error: "Share expired. Share the file again.",
  });
});

test("expired custody cannot return preview bytes", async () => {
  const x = await worker();
  await x.post();
  x.elapse(600001);
  assert.deepEqual(JSON.parse(JSON.stringify(await x.message())), {
    ok: false,
    error: "Share expired. Share the file again.",
  });
});

test("small multipart chunks preserve the shared file", async () => {
  const x = await worker();
  assert.equal((await x.post("/share-target", "application/pdf", "https://app.example", 6, 1))?.status, 303);
  const reply = await x.message();
  assert.ok(
    reply &&
      typeof reply === "object" &&
      "share" in reply &&
      reply.share &&
      typeof reply.share === "object" &&
      "file" in reply.share &&
      reply.share.file instanceof File,
  );
  assert.deepEqual(new Uint8Array(await reply.share.file.arrayBuffer()), new Uint8Array(6));
});

test("another live intake page cannot consume the same share", async () => {
  const x = await worker();
  await x.post();
  await x.message();
  const other = await x.message("read", "intake-b");
  assert.ok(other && typeof other === "object" && "ok" in other && other.ok === false);
  const original = await x.message();
  assert.ok(original && typeof original === "object" && "ok" in original && original.ok === true);
});
test("a closed intake page releases custody for reconciliation in a new page", async () => {
  const x = await worker();
  await x.post();
  const original = await x.message();
  x.closeClient("intake-a");
  assert.deepEqual(await x.message("read", "intake-b"), original);
});
