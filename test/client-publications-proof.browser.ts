import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import { CHROMIUM_SAFETY_ARGS } from "../scripts/chromium-safety-args.mjs";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startFixture, startWorkerFixture } from "../scripts/fixture-http.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";

const commit = "a".repeat(40),
  deal = "11111111-1111-4111-8111-111111111111",
  id = "33333333-3333-4333-8333-333333333333";
test("proof CLI passes exact projections, fails near misses and refuses missing release/session evidence", async (t) => {
  const scratch = temporaryDirectory("j15-proof-", t);
  const release = { service: "doctorcre-app", environment: "production", source_commit: commit };
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    routes: new Map([["/app-release", { contentType: "application/json", body: JSON.stringify(release) }]]),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const slot = await startFixture();
  const port = new URL(slot.origin).port;
  await slot.close();
  const context = await chromium.launchPersistentContext(`${scratch}/browser`, {
    headless: true,
    args: [...CHROMIUM_SAFETY_ARGS, `--remote-debugging-port=${port}`],
  });
  t.after(() => context.close());
  const portal = {
    slug: "synthetic",
    materials: [],
    publications: [{ kind: "milestone", title: "Published milestone", content: "Approved update" }],
  };
  const row = {
    id,
    kind: "milestone",
    title: "Published milestone",
    content: "Approved update",
    published: true,
    version: 2,
  };
  const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><button role="tab">Client view</button><main id="view"></main><script type="module">import {mountClientPublications} from '/js/ui-client-publications.js';mountClientPublications(document.querySelector('#view'),{dealId:'${deal}',request:async(name,args)=>{const response=await fetch('/mcp',{method:'POST',body:JSON.stringify({params:{name,arguments:args}})});const value=await response.json();return JSON.parse(value.result.content[0].text);}});</script>`;
  await context.route("**/deals?*", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await context.route("**/mcp", (route) => {
    const name = route.request().postDataJSON().params.name;
    const value =
      name === "list-deal-deliverables"
        ? { ok: true, schema_version: "deal-deliverables.v1", deliverables: [] }
        : name === "list-deal-client-publications"
          ? { ok: true, schema_version: "client-publications.v1", publications: [row] }
          : { ok: true, schema_version: "client-publications.v1", portal };
    return route.fulfill({ json: { result: { content: [{ type: "text", text: JSON.stringify(value) }] } } });
  });
  const releaseServer = await startFixture({
    routes: new Map([["/release", { contentType: "application/json", body: JSON.stringify({ git_sha: commit }) }]]),
  });
  t.after(() => releaseServer.close());
  const evidencePath = `${scratch}/evidence.json`;
  const evidence = {
    client_read: { ok: true, schema_version: "client-portal.v1", portal },
    receipt: { id, version: 2, published: true },
    hidden_canaries: ["PRIVATE FILE", "HIDDEN MILESTONE"],
  };
  const run = (extra: string[] = []) =>
    new Promise<{ code: number; output: string }>((resolve) =>
      execFile(
        process.execPath,
        [
          "scripts/prove-client-publications.ts",
          "--origin",
          server.origin,
          "--commit",
          commit,
          "--carr-origin",
          releaseServer.origin,
          "--carr-commit",
          commit,
          "--deal",
          deal,
          "--evidence",
          evidencePath,
          "--cdp-url",
          `http://127.0.0.1:${port}`,
          "--timeout-ms",
          "10000",
          ...extra,
        ],
        { timeout: 20000 },
        (error, stdout) =>
          resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, output: stdout }),
      ),
    );
  await writeFile(evidencePath, JSON.stringify(evidence));
  const pass = await run();
  assert.equal(pass.code, 0, pass.output);
  await writeFile(
    evidencePath,
    JSON.stringify({
      ...evidence,
      client_read: {
        ...evidence.client_read,
        portal: { ...portal, publications: [{ ...portal.publications[0], content: "Approved updates" }] },
      },
    }),
  );
  const fail = await run();
  assert.equal(fail.code, 1, fail.output);
  await writeFile(evidencePath, JSON.stringify(evidence));
  assert.equal((await run(["--commit", "b".repeat(40)])).code, 78);
  assert.equal((await run(["--cdp-url", "http://127.0.0.1:1"])).code, 78);
});
