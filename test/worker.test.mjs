import assert from "node:assert/strict";
import test from "node:test";

test('blocking 1: Leads map module, CSS and derived worker URLs pass through deployed asset routing',async()=>{
 const {readFile}=await import('node:fs/promises');
 const html=await readFile(new URL('../leads.html',import.meta.url),'utf8');
 const source=await readFile(new URL('../js/leads-territory-map.js',import.meta.url),'utf8');
 const css=html.match(/href="([^"]*maplibre-gl.css)"/)[1];
 const module=new URL(source.match(/import\("([^"]*maplibre-gl.mjs)"\)/)[1],'https://example.test/js/leads-territory-map.js');
 for(const path of [new URL(css,'https://example.test/').pathname,module.pathname,new URL('maplibre-gl-shared.mjs',module).pathname,new URL('maplibre-gl-worker.mjs',module).pathname]){
 let calls=0;const response=await handleDoctorcreRequest(request(path),environment({assets:{fetch:async()=>{calls++;return new Response('asset')}}}));
 assert.equal(response.status,200,path);assert.equal(calls,1,path);
 }
});

import { handleDoctorcreRequest } from "../src/worker.js";

const HOST = "doctorcre-app-staging.joe-bookout-carr-us.workers.dev";
const request = (path, init) => new Request(`https://${HOST}${path}`, init);

test("Doc activity uses an admitted gate and restores signed-out return-to", async () => {
  let forwarded;
  const carr = { fetch: async value => {
    forwarded = value;
    if (new URL(value.url).pathname !== "/control-room") return new Response("OAuth/API fallback", { status: 404 });
    return value.headers.has("cookie") ? new Response(null, { headers: { "set-cookie": "__Host-dealroom_session=fresh" } })
      : new Response(null, { status: 302, headers: { location: `https://${HOST}/auth/login?return_to=%2Fcontrol-room` } });
  } };
  const signedIn = await handleDoctorcreRequest(request("/doc-activity?partner=dell", { headers: { cookie: "__Host-dealroom_session=opaque" } }), environment({ carr }));
  assert.equal(signedIn.status, 200);
  assert.equal(await signedIn.text(), "asset:/activity.html");
  assert.equal(new URL(forwarded.url).search, "");
  assert.equal(forwarded.headers.get("cookie"), "__Host-dealroom_session=opaque");
  assert.equal(signedIn.headers.get("set-cookie"), "__Host-dealroom_session=fresh");
  const signedOut = await handleDoctorcreRequest(request("/doc-activity?partner=dell"), environment({ carr }));
  assert.equal(signedOut.status, 302);
  assert.equal(new URL(signedOut.headers.get("location")).searchParams.get("return_to"), "/doc-activity?partner=dell");
});

test('Invoices use an admitted gate and restore the original sign-in deep link', async () => {
  for (const outcome of [200, 302, 403]) {
    let forwarded, assets = 0;
    const response = await handleDoctorcreRequest(request('/invoices?invoice=demo', {headers:{cookie:'session=opaque'}}), environment({
      carr:{fetch:async value=>{forwarded=value;return new Response(null,{status:new URL(value.url).pathname==='/control-room'?outcome:404,headers:outcome===302?{location:request('/auth/login?return_to=%2Fcontrol-room').url}:{}});}},
      assets:{fetch:async value=>{assets++;return new Response(`asset:${new URL(value.url).pathname}`);}}
    }));
    assert.equal(response.status,outcome); assert.equal(new URL(forwarded.url).pathname,'/control-room');
    assert.equal(forwarded.headers.get('cookie'),'session=opaque'); assert.equal(assets,outcome===200?1:0);
    if(outcome===200)assert.equal(await response.text(),'asset:/invoices.html');
    if(outcome===302)assert.equal(new URL(response.headers.get('location')).searchParams.get('return_to'),'/invoices?invoice=demo');
  }
});

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
  assert.equal(await (await handleDoctorcreRequest(request("/favicon.ico"), env)).text(), "asset:/public-shell/icons/dealroom.svg");
  assert.equal(await (await handleDoctorcreRequest(request("/public-shell/shell.css"), env)).text(), "asset:/public-shell/shell.css");
  assert.equal(carrCalls, 0);
  assert.equal((await handleDoctorcreRequest(request("/unknown"), env)).status, 404);
  assert.equal((await handleDoctorcreRequest(request("/leads", { method: "POST" }), env)).status, 405);
});

// V5-UX-C15: the gated Control Room cannot be its own fallback, so /status is
// answered ahead of the gate. If this ever takes the CARR path again, the page
// disappears in exactly the outage it exists for.
test("the independent status page is served without a CARR call", async () => {
  let carrCalls = 0;
  const env = environment({ carr: { fetch: async () => { carrCalls += 1; return new Response(); } } });
  assert.equal(await (await handleDoctorcreRequest(request("/status"), env)).text(), "asset:/status.html");
  assert.equal(carrCalls, 0, "the status page must not consult CARR");
  assert.equal((await handleDoctorcreRequest(request("/status", { method: "POST" }), env)).status, 405);
  assert.equal(carrCalls, 0);
  assert.equal((await handleDoctorcreRequest(request("/leads", { method: "POST" }), env)).status, 405);
});

// V5-UX-C14: the incident page is an ordinary GATED page. It is served through
// the normal APP_ROUTES branch, so a signed-out request reaches the CARR gate
// exactly as /control-room does; nothing about it is ungated.
test("the incident page is served on the gated route", async () => {
  let carrCalls = 0;
  const env = environment({ carr: { fetch: async () => { carrCalls += 1; return new Response(); } } });
  assert.equal(await (await handleDoctorcreRequest(request("/incidents"), env)).text(), "asset:/incidents.html");
  assert.equal(carrCalls, 1, "the incident page goes through the CARR gate");
  assert.equal((await handleDoctorcreRequest(request("/incidents", { method: "POST" }), env)).status, 405);
});

test("retired design prototypes redirect to gated Design Lab references", async () => {
  const forwarded = [];
  const env = environment({ carr: { fetch: async (value) => { forwarded.push(value); return new Response(); } } });
  const legacy = await handleDoctorcreRequest(request("/design/operations?tab=atlas"), env);
  assert.equal(legacy.status, 308);
  assert.equal(new URL(legacy.headers.get("location")).pathname, "/design-lab");
  assert.equal(new URL(legacy.headers.get("location")).searchParams.get("reference"), "operations");
  assert.equal(await (await handleDoctorcreRequest(request("/design-lab?reference=operations", { headers: { cookie: "__Host-dealroom_session=opaque" } }), env)).text(), "asset:/design.html");
  assert.equal(forwarded.length, 1, "the new reference page consults the CARR gate");
  for (const value of forwarded) assert.equal(new URL(value.url).pathname, "/control-room");
  assert.equal(new URL(forwarded[0].url).search, "");
  assert.equal(forwarded[0].headers.get("cookie"), "__Host-dealroom_session=opaque");
  const signedOut = await handleDoctorcreRequest(request("/design-lab?reference=operations"), environment({
    carr: { fetch: async () => new Response(null, { status: 302, headers: { location: `https://${HOST}/auth/login` } }) },
  }));
  assert.equal(signedOut.status, 302);
  // /designer is not a prototype path and must not borrow the Control Room gate.
  let other;
  await handleDoctorcreRequest(request("/leads"), environment({ carr: { fetch: async (value) => { other = value; return new Response(); } } }));
  assert.equal(new URL(other.url).pathname, "/leads");
});

test("Ideas and Events use the admitted Control Room sign-in gate", async () => {
  let forwarded;
  const signedIn = await handleDoctorcreRequest(request("/ideas-events?tab=events", {
    headers: { cookie: "__Host-dealroom_session=opaque" },
  }), environment({ carr: { fetch: async (value) => { forwarded = value; return new Response(); } } }));
  assert.equal(await signedIn.text(), "asset:/ideas.html");
  assert.equal(new URL(forwarded.url).pathname, "/control-room");
  assert.equal(new URL(forwarded.url).search, "");
  assert.equal(forwarded.headers.get("cookie"), "__Host-dealroom_session=opaque");

  const signedOut = await handleDoctorcreRequest(request("/ideas-events?tab=events"), environment({
    carr: { fetch: async () => new Response(null, { status: 302, headers: { location: `https://${HOST}/auth/login` } }) },
  }));
  assert.equal(signedOut.status, 302);
});

test("lease radar uses the admitted Business gate and preserves the sign-in return path", async () => {
  let forwarded;
  const response = await handleDoctorcreRequest(request("/leases?quarter=2027-Q1", {
    headers: { cookie: "__Host-dealroom_session=opaque" },
  }), environment({ carr: { fetch: async value => { forwarded = value; return new Response(); } } }));
  assert.equal(await response.text(), "asset:/lease-radar.html");
  assert.equal(new URL(forwarded.url).pathname, "/business");
  assert.equal(new URL(forwarded.url).search, "");
  assert.equal(forwarded.headers.get("cookie"), "__Host-dealroom_session=opaque");
  const signedOut = await handleDoctorcreRequest(request("/leases?quarter=2027-Q1"), environment({
    carr: { fetch: async () => new Response(null, { status: 302, headers: {
      location: `https://${HOST}/auth/login?return_to=%2Fbusiness`,
    } }) },
  }));
  assert.equal(new URL(signedOut.headers.get("location")).searchParams.get("return_to"), "/leases?quarter=2027-Q1");
});

test("lease projection proxies the authenticated GET and CARR refusal unchanged", async () => {
  let forwarded;
  const response = await handleDoctorcreRequest(request("/api/v1/business/leases", {
    headers: { cookie: "__Host-dealroom_session=opaque" },
  }), environment({ carr: { fetch: async value => {
    forwarded = value;
    return new Response('{"error":"unauthorized"}', { status: 401, headers: { "cache-control": "no-store" } });
  } } }));
  assert.equal(new URL(forwarded.url).pathname, "/api/v1/business/leases");
  assert.equal(forwarded.method, "GET");
  assert.equal(forwarded.headers.get("cookie"), "__Host-dealroom_session=opaque");
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});

test("signed-out Ideas Events visits return to the requested path and query", async () => {
  const response = await handleDoctorcreRequest(request("/ideas-events?tab=events"), environment({
    carr: { fetch: async () => new Response(null, {
      status: 302,
      headers: { location: `https://${HOST}/auth/login?return_to=%2Fcontrol-room` },
    }) },
  }));

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"),
    `https://${HOST}/auth/login?return_to=%2Fideas-events%3Ftab%3Devents`);
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
    carr_contract: { schema: "doctorcre-carr-interface.v1", version: "1.43.0" },
    route_contract: { schema: "doctorcre-app-routes.v1", version: "1.20.0" },
  });
});


test("retired Work deep links redirect to Home and retain their query", async () => {
  let carrCalls = 0;
  const env = environment({ carr: { fetch: async () => { carrCalls++; return new Response(); } } });
  for (const path of ["/tasks", "/work", "/tasks.html"]) {
    const response = await handleDoctorcreRequest(request(`${path}?ref=synthetic-work&actor=dell`), env);
    assert.equal(response.status, 308);
    const destination = new URL(response.headers.get("location"));
    assert.equal(destination.pathname, "/");
    assert.equal(destination.search, "?ref=synthetic-work&actor=dell");
  }
  assert.equal(carrCalls, 0, "redirects have no business effect");
});
