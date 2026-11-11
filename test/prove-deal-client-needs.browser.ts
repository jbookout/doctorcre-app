import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { parseNeed, parseVendorNeeds } from "../src/ui/deal-client-needs-model.ts";
import { assertProofDeadlineCleanup } from "./proof-browser-harness.mjs";

const exec = promisify(execFile),
  commit = "1".repeat(40);
const raw = JSON.parse(await readFile(new URL("./fixtures/client-needs/authoring.json", import.meta.url), "utf8"));
const need = parseNeed(raw, { deal: raw.deal_id, client: raw.client_id });
const approved = {
  ...need,
  state: "approved",
  approved_revision: 1,
  approved_by: need.client_id,
  approved_at: "2026-11-11T00:00:00Z",
};
const lapsed = { ...need, id: "44444444-4444-4444-8444-444444444444", state: "edited_lapsed" };
const assets = await appAssetSnapshot();
async function fixture(t: import("node:test").TestContext, mode = "ready") {
  const snapshot = new Map(assets);
  const rows = mode === "empty" ? [] : [approved, lapsed];
  const deal = {
    schema_version: "client-needs.v1",
    subject: "deal",
    subject_id: need.deal_id,
    as_of: "2026-11-11T00:00:00Z",
    state: rows.length ? "ready" : "empty",
    rows,
    next_offset: null,
  };
  const vendor = { ...deal, subject: "vendor", subject_id: need.vendor_id, rows: rows.length ? [approved] : [] };
  parseVendorNeeds(vendor, need.vendor_id);
  snapshot.set("/pipeline.html", {
    body: Buffer.from(
      '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/system.css"><link rel="stylesheet" href="/css/pipeline.css"><main style="max-width:700px;padding:16px;margin:auto" id="host"></main><script type="module" src="/js/need-proof-fixture.js"></script></html>',
    ),
    contentType: "text/html",
  });
  snapshot.set("/js/need-proof-fixture.js", {
    body: Buffer.from(
      `import {mountDealClientNeeds} from '/js/ui-deal-client-needs.js'; import {createMcpRequests} from '/js/mcp-requests.mjs'; const call=createMcpRequests();mountDealClientNeeds(document.querySelector('#host'),{deal:'${need.deal_id}',client:'${need.client_id}',call:async(v,a)=>{const r=await call(v,a);return r.payload;}});`,
    ),
    contentType: "text/javascript",
  });
  if (mode === "near-miss") {
    const asset = snapshot.get("/js/ui-deal-client-needs.js");
    assert.ok(asset);
    snapshot.set("/js/ui-deal-client-needs.js", {
      ...asset,
      body: Buffer.from(asset.body.toString().replaceAll(".source_revision", ".source_ref")),
    });
  }
  const server = await startWorkerFixture({
    assets: snapshot,
    routes: new Map([["/release", { body: JSON.stringify({ git_sha: commit }), contentType: "application/json" }]]),
    env: {
      APP_ENV: "production",
      GIT_SHA: commit,
      CARR: {
        fetch: async (request) => {
          const path = new URL(request.url).pathname;
          if (path === "/auth/session") return Response.json({ actor: { slug: "synthetic" }, csrf_token: "synthetic" });
          if (path === "/mcp") {
            const body = await request.json();
            const payload = body.params.name === "read-deal-client-needs-v1" ? deal : vendor;
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
            });
          }
          if (path === "/release") return Response.json({ git_sha: commit });
          return new Response("signed in");
        },
      },
    },
  });
  t.after(() => server.close());
  return server;
}
const args = (origin: string) => [
  "--origin",
  origin,
  "--expected-commit",
  commit,
  "--expected-producer-commit",
  commit,
  "--producer-origin",
  origin,
  "--deal",
  need.deal_id,
  "--client",
  need.client_id,
  "--vendor",
  need.vendor_id,
  "--fixture",
];
test("proof CLI passes exact reads, refuses missing evidence and near-miss values", async (t) => {
  const server = await fixture(t);
  const result = await exec(process.execPath, ["scripts/prove-deal-client-needs.ts", ...args(server.origin)]);
  assert.equal(JSON.parse(result.stdout).status, "passed");
  for (const [mode, code] of [
    ["empty", 78],
    ["near-miss", 1],
  ] as const) {
    const bad = await fixture(t, mode);
    await assert.rejects(
      exec(process.execPath, ["scripts/prove-deal-client-needs.ts", ...args(bad.origin), "--timeout-ms", "3000"]),
      (e) => {
        assert.ok(e && typeof e === "object" && "code" in e);
        assert.equal(e.code, code);
        return true;
      },
    );
  }
});
for (const mode of ["late launch", "stalled evaluation"])
  test(`proof ${mode} cleanup`, async (t) => {
    const server = await fixture(t);
    await assertProofDeadlineCleanup(t, {
      entry: "scripts/prove-deal-client-needs.ts",
      args: args(server.origin),
      mode,
      timeoutMs: 1000,
      acquisitionDelayMs: 1200,
    });
  });
