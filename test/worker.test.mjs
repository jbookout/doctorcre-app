import assert from "node:assert/strict";
import test from "node:test";

import { handleDoctorcreRequest } from "../src/worker.js";

const HOST = "doctorcre-app-staging.joe-bookout-carr-us.workers.dev";
const request = (path, init) => new Request(`https://${HOST}${path}`, init);

function environment({ carr, assets } = {}) {
  return {
    APP_ENV: "staging",
    GIT_SHA: "1".repeat(40),
    CF_VERSION_METADATA: { id: "version-one", tag: "staging-one", timestamp: "2026-09-14T00:00:00Z" },
    CARR: carr,
    ASSETS: assets || { fetch: async (assetRequest) => new Response(`asset:${new URL(assetRequest.url).pathname}`) },
  };
}

test("protected documents use CARR as the auth gate and serve DoctorCRE-owned assets", async () => {
  let forwarded;
  const env = environment({ carr: { fetch: async (value) => {
    forwarded = value;
    return new Response("transitional CARR asset", { headers: { "set-cookie": "__Host-dealroom_session=fresh; Path=/; Secure; HttpOnly; SameSite=Lax" } });
  } } });
  const response = await handleDoctorcreRequest(request("/leads?owner=joe", { headers: { cookie: "__Host-dealroom_session=opaque" } }), env);
  assert.equal(await response.text(), "asset:/leads.html");
  assert.equal(new URL(forwarded.url).pathname, "/leads");
  assert.equal(forwarded.redirect, "manual");
  assert.equal(forwarded.headers.get("cookie"), "__Host-dealroom_session=opaque");
  assert.match(response.headers.get("set-cookie"), /__Host-dealroom_session=fresh/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
});

test("auth redirects and API refusals pass through without exposing a second authority path", async () => {
  const redirect = await handleDoctorcreRequest(request("/"), environment({
    carr: { fetch: async () => new Response(null, { status: 302, headers: { location: `https://${HOST}/auth/login?return_to=%2F` } }) },
  }));
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), `https://${HOST}/auth/login?return_to=%2F`);

  let forwarded;
  const refusal = await handleDoctorcreRequest(request("/mcp", { method: "POST", body: "{}" }), environment({
    carr: { fetch: async (value) => { forwarded = value; return new Response('{"error":"unauthorized"}', { status: 401 }); } },
  }));
  assert.equal(refusal.status, 401);
  assert.equal(forwarded.method, "POST");
  assert.equal(await forwarded.text(), "{}");

  for (const path of ["/api/call-context", "/api/post-call?session=S-1"]) {
    const response = await handleDoctorcreRequest(request(path), environment({
      carr: { fetch: async () => new Response("proxied") },
    }));
    assert.equal(await response.text(), "proxied");
  }
});

test("CARR outages fail closed and never substitute cached business data", async () => {
  const env = environment({ carr: { fetch: async () => { throw new Error("offline"); } } });
  const document = await handleDoctorcreRequest(request("/deals"), env);
  assert.equal(document.status, 503);
  assert.match(await document.text(), /No cached business data/);
  const api = await handleDoctorcreRequest(request("/api/v1/command-center"), env);
  assert.equal(api.status, 503);
  assert.deepEqual(await api.json(), { error: "carr_unavailable" });
});

test("public assets bypass CARR, while unknown and mutation routes fail closed", async () => {
  let carrCalls = 0;
  const env = environment({ carr: { fetch: async () => { carrCalls += 1; return new Response(); } } });
  assert.equal(await (await handleDoctorcreRequest(request("/js/app.js"), env)).text(), "asset:/js/app.js");
  assert.equal(await (await handleDoctorcreRequest(request("/icons/dealroom.svg"), env)).text(), "asset:/public-shell/icons/dealroom.svg");
  assert.equal(await (await handleDoctorcreRequest(request("/public-shell/shell.css"), env)).text(), "asset:/public-shell/shell.css");
  assert.equal(carrCalls, 0);
  assert.equal((await handleDoctorcreRequest(request("/unknown"), env)).status, 404);
  assert.equal((await handleDoctorcreRequest(request("/leads", { method: "POST" }), env)).status, 405);
});

test("share links remain on the isolated reports host and release identity is explicit", async () => {
  const share = await handleDoctorcreRequest(request("/share?tour=T-1"), environment());
  assert.equal(share.status, 302);
  assert.equal(share.headers.get("location"), "https://reports.doctorcre.com/share?tour=T-1");
  const release = await (await handleDoctorcreRequest(request("/app-release"), environment())).json();
  assert.deepEqual(release, {
    service: "doctorcre-app", environment: "staging", source_commit: "1".repeat(40),
    provider_version_id: "version-one", provider_version_tag: "staging-one",
    provider_version_created_at: "2026-09-14T00:00:00Z",
    carr_contract: { schema: "doctorcre-carr-interface.v1", version: "1.2.0" },
    route_contract: { schema: "doctorcre-app-routes.v1", version: "1.2.0" },
  });
});
