import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";

const exec = promisify(execFile);
const fixture = JSON.parse(
  await readFile(new URL("./fixtures/deal-space-searches/responses.json", import.meta.url), "utf8"),
);
const client = "22222222-2222-4222-8222-222222222222";
const record = {
  id: client,
  name: "Synthetic Clinic",
  notes: "Exact source notes",
  city: "Pensacola",
  state: "FL",
  vertical: "Dermatology",
};
const commit = "1".repeat(40);
test("production proof CLI passes the real review UI and fails a near-miss source", async () => {
  const assets = await appAssetSnapshot();
  const registry = JSON.parse(await readFile(new URL("./fixtures/walk-verb-registry.json", import.meta.url), "utf8"));
  for (const nearMiss of [false, true]) {
    const saved = {
      ...fixture.saved.search,
      client_prefill_source: {
        client_id: client,
        source_ref: `/api/v1/business/clients/${client}`,
        observed_at: "2026-11-11T12:00:00Z",
      },
    };
    const binding = { deal_id: saved.deal_id, client_id: client };
    const routes = new Map();
    const html = (body: string) => ({ contentType: "text/html", body });
    const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
    routes.set("/app-release", json({ service: "doctorcre-app", environment: "production", source_commit: commit }));
    routes.set(
      "/deals",
      html(
        '<iframe title="Tour shortlist, route and packet" style="width:100%;height:10000px;border:0" src="/tours/route-editor.html"></iframe>',
      ),
    );
    routes.set("/js/private-session.js", {
      contentType: "text/javascript",
      body: "export const sessionFetch=(...args)=>fetch(...args);",
    });
    routes.set(`/api/v1/business/clients/${client}`, {
      sequence: [
        json({ record }),
        json({ record: nearMiss ? { ...record, notes: `${record.notes} changed` } : record }),
      ],
    });
    routes.set(
      "/tours/route-editor.html",
      html(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/tours/app.css"><main id="view"></main><script type="module">
   import {mountSavedSearches} from '/js/ui-deal-space-searches.js';
   const saved=${JSON.stringify(saved)},binding=${JSON.stringify(binding)},list=${JSON.stringify(fixture.reopened)};
   mountSavedSearches(document.querySelector('#view'),{dealId:saved.deal_id,describe:()=>null,hydrate:async()=>{},handoff:()=>false,call:async verb=>verb==='get-deal-room'?binding:{...list,searches:[saved]}});
  </script>`),
    );
    for (const path of routes.keys()) assets.delete(path);
    const server = await startWorkerFixture({
      assets,
      routes,
      env: {
        APP_ENV: "fixture",
        CARR: {
          fetch: async (request: Request) => {
            const body = await request.json();
            const payload =
              body.params?.name === "get-deal-room"
                ? binding
                : body.params?.name === "list-verbs"
                  ? registry.response
                  : { ...fixture.reopened, searches: [saved] };
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
            });
          },
        },
      },
    });
    try {
      let code = 0,
        stdout = "";
      try {
        ({ stdout } = await exec(
          process.execPath,
          [
            "scripts/prove-deal-client-prefill.ts",
            "--fixture",
            "--origin",
            server.origin,
            "--expected-commit",
            commit,
            "--deal-id",
            saved.deal_id,
            "--search-id",
            saved.id,
          ],
          { timeout: 60000 },
        ));
      } catch (error) {
        assert.ok(error && typeof error === "object" && "code" in error && "stdout" in error);
        code = Number(error.code);
        stdout = String(error.stdout);
      }
      assert.equal(code, nearMiss ? 1 : 0, stdout);
      assert.equal(JSON.parse(stdout).exitCode, code);
    } finally {
      await server.close();
    }
  }
});
