import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { JSDOM } from "jsdom";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { parseSearchResponse } from "../src/ui/deal-space-search-model.ts";
import responses from "./fixtures/deal-space-searches/responses.json" with { type: "json" };
import recorded from "./fixtures/tour-stop-drag.json" with { type: "json" };
import registry from "./fixtures/walk-verb-registry.json" with { type: "json" };
import { buildToursAppScript } from "./tours-app-loader.ts";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
export function fixturePath(requestPath: string) {
  const decoded = decodeURIComponent(requestPath);
  const resolved = path.resolve(root, `.${decoded}`);
  if (!decoded.startsWith("/") || decoded.includes("\\") || !resolved.startsWith(root + path.sep))
    throw Error("Fixture path outside root");
  return resolved;
}
export const fixtureDeal = "11111111-1111-4111-8111-111111111111";
export const propA = "44444444-4444-4444-8444-444444444444";
export const propB = "55555555-5555-4555-8555-555555555555";
export type FixtureMode = "pass" | "cancelled" | "near-miss" | "write" | "unknown-verb" | "unknown-post";
export async function tourDragRoutes(mode: FixtureMode = "pass") {
  const read = (name: string) => readFile(fixturePath(name), "utf8");
  const routes = new Map<string, { contentType: string; body: string }>();
  const add = (name: string, contentType: string, body: string) => {
    fixturePath(name);
    routes.set(name, { contentType, body });
  };
  for (const name of ["/js/mcp-requests.mjs", "/js/current-read.mjs"]) add(name, "text/javascript", await read(name));
  add("/js/private-session.js", "text/javascript", "export const sessionFetch = (...args) => fetch(...args);");
  for (const [name, body] of [
    ["library", recorded.library],
    ["detail", recorded.detail],
  ] as const)
    add(`/api/tours/${name}`, "application/json", JSON.stringify(body));
  add(
    "/app-release",
    "application/json",
    JSON.stringify({ service: "doctorcre-app", environment: "production", source_commit: "1".repeat(40) }),
  );
  add(
    "/deals",
    "text/html",
    `<iframe title="Tour shortlist, route and packet" style="border:0;width:100%;height:10000px" src="/tours/route-editor.html?deal=${fixtureDeal}&tour=${recorded.detail.data.id}"></iframe>`,
  );
  const html = new JSDOM(await read("/tours/route-editor.html"));
  try {
    for (const node of html.window.document.querySelectorAll("script, link")) node.remove();
    const style = html.window.document.createElement("style");
    style.textContent = (
      await Promise.all(["/css/tokens.css", "/tours/app.css", "/tours/property-panel.css"].map(read))
    ).join("\n");
    html.window.document.head.append(style);
    const script = html.window.document.createElement("script");
    script.textContent = await buildToursAppScript();
    html.window.document.body.append(script);
    if (["write", "unknown-verb", "unknown-post"].includes(mode)) {
      const fault = html.window.document.createElement("script");
      const name = mode === "write" ? "append-tour-route-version" : "unregistered-verb";
      fault.textContent = `document.addEventListener("pointermove",e=>{if(e.buttons===1) void fetch(${JSON.stringify(mode === "unknown-post" ? "/unknown" : "/mcp")},{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:99,method:"tools/call",params:{name:${JSON.stringify(name)},arguments:{}}})}).catch(()=>{});})`;
      html.window.document.body.append(fault);
    }
    if (mode === "cancelled" || mode === "near-miss") {
      const fault = html.window.document.createElement("script");
      fault.textContent =
        mode === "cancelled"
          ? 'document.addEventListener("pointerup",e=>e.stopImmediatePropagation(),true)'
          : 'document.addEventListener("pointerup",()=>queueMicrotask(()=>{const row=document.querySelector("#route-stops > li");row.dataset.propertyId += "-near-miss";}))';
      html.window.document.body.append(fault);
    }
    add("/tours/route-editor.html", "text/html", html.serialize());
  } finally {
    html.window.close();
  }
  return routes;
}
export async function runTourDragProofFixture(
  routes: Awaited<ReturnType<typeof tourDragRoutes>>,
  context: TestContext,
  missingSession = false,
) {
  const server = await startTourDragFixture(routes);
  try {
    const directory = temporaryDirectory("tour-drag-proof-", context);
    const storage = `${directory}/state.json`;
    if (!missingSession) await writeFile(storage, JSON.stringify({ cookies: [], origins: [] }));
    return await promisify(execFile)(
      process.execPath,
      [
        "scripts/prove-tour-stop-drag.ts",
        "--origin",
        server.origin,
        "--expected-commit",
        "1".repeat(40),
        "--tour-url",
        `${server.origin}/deals?deal=${fixtureDeal}`,
        "--storage-state",
        storage,
        "--timeout-ms",
        "30000",
      ],
      { timeout: 40000 },
    );
  } finally {
    await server.close();
  }
}

export async function startTourDragFixture(routes: Awaited<ReturnType<typeof tourDragRoutes>>) {
  const searches = { ...responses.reopened, searches: [] };
  parseSearchResponse(searches, fixtureDeal, true);
  const verbs = [...registry.response.verbs, { name: "read-deal-space-searches-v1", write: false }];
  let rpcReads = 0;
  const server = await startWorkerFixture({
    routes,
    env: {
      APP_ENV: "fixture",
      CARR: {
        fetch: async (request: Request) => {
          const body = await request.json();
          if (body.method !== "tools/call") return Response.json({ error: "unknown_rpc" }, { status: 400 });
          let payload: unknown;
          if (body.params?.name === "list-verbs") payload = { ...registry.response, count: verbs.length, verbs };
          else if (body.params?.name === "read-deal-space-searches-v1") {
            assert.equal(body.params.arguments.deal_id, fixtureDeal);
            parseSearchResponse(searches, fixtureDeal, true);
            rpcReads++;
            payload = searches;
          } else throw Error("Unexpected fixture RPC");
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
          });
        },
      },
    },
  });
  return {
    ...server,
    get rpcReads() {
      return rpcReads;
    },
  };
}
