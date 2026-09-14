import carrContract from "../contracts/carr-interface.v1.json" with { type: "json" };
import routeContract from "../contracts/app-routes.v1.json" with { type: "json" };

const APP_ROUTES = new Map(Object.entries(routeContract.routes));
const PROXY_EXACT = new Set(["/mcp", "/pipeline/changes", "/api/call-context", "/api/post-call"]);
const PROXY_PREFIXES = ["/auth/", "/api/v1/", "/api/room/", "/api/system-work/", "/api/tours/", "/api/post-call/"];
const STATIC_EXACT = new Map([
  ["/manifest.webmanifest", "/manifest.webmanifest"],
  ["/sw.js", "/public-shell/sw.js"],
  ["/offline.html", "/public-shell/offline.html"],
]);
const STATIC_PREFIXES = ["/css/", "/data/", "/js/", "/public-shell/", "/tours/"];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function unavailable(documentRequest) {
  if (!documentRequest) return json({ error: "carr_unavailable" }, 503);
  return new Response("<!doctype html><title>DoctorCRE unavailable</title><h1>DoctorCRE is temporarily unavailable</h1><p>No cached business data is being shown.</p>", {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function secure(response) {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", [
    "default-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'",
    "form-action 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:4682", "worker-src 'self'",
  ].join("; "));
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "same-origin");
  headers.set("permissions-policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function assetPath(pathname) {
  if (STATIC_EXACT.has(pathname)) return STATIC_EXACT.get(pathname);
  if (pathname.startsWith("/icons/")) return `/public-shell${pathname}`;
  return STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ? pathname : null;
}

async function assetResponse(request, env, path) {
  if (!env?.ASSETS?.fetch) return json({ error: "app_assets_unavailable" }, 503);
  const url = new URL(request.url);
  url.pathname = path;
  url.search = "";
  const response = await env.ASSETS.fetch(new Request(url, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: { accept: request.headers.get("accept") || "*/*" },
  }));
  const headers = new Headers(response.headers);
  headers.set("cache-control", path.endsWith(".html") || path.endsWith(".js") || path.endsWith(".css")
    ? "no-cache" : "public, max-age=300");
  if (path === "/public-shell/sw.js") headers.set("service-worker-allowed", "/");
  return secure(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
}

async function carrResponse(request, env, documentRequest = false) {
  if (!env?.CARR?.fetch) return unavailable(documentRequest);
  try {
    return await env.CARR.fetch(new Request(request, { redirect: "manual" }));
  } catch {
    return unavailable(documentRequest);
  }
}

function copySessionCookies(from, to) {
  const values = typeof from.headers.getSetCookie === "function"
    ? from.headers.getSetCookie() : [from.headers.get("set-cookie")].filter(Boolean);
  if (!values.length) return to;
  const headers = new Headers(to.headers);
  for (const value of values) headers.append("set-cookie", value);
  return new Response(to.body, { status: to.status, statusText: to.statusText, headers });
}

function release(env) {
  const sourceCommit = /^[0-9a-f]{40}$/.test(env?.GIT_SHA || "") ? env.GIT_SHA : null;
  const provider = env?.CF_VERSION_METADATA || {};
  return json({
    service: "doctorcre-app",
    environment: env?.APP_ENV || "unknown",
    source_commit: sourceCommit,
    provider_version_id: provider.id || null,
    provider_version_tag: provider.tag || null,
    provider_version_created_at: provider.timestamp || null,
    carr_contract: { schema: carrContract.schema, version: carrContract.version },
    route_contract: { schema: routeContract.schema, version: routeContract.version },
  });
}

export async function handleDoctorcreRequest(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (pathname === "/app-release") return request.method === "GET" ? release(env) : json({ error: "method_not_allowed" }, 405);
  if (pathname === "/share") return Response.redirect(`https://reports.doctorcre.com/share${url.search}`, 302);

  const routeAsset = APP_ROUTES.get(pathname);
  if (routeAsset) {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
    const gate = await carrResponse(request, env, true);
    if (gate.status !== 200) return gate;
    return copySessionCookies(gate, await assetResponse(request, env, `/${routeAsset}`));
  }

  const staticAsset = assetPath(pathname);
  if (staticAsset) {
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
    return assetResponse(request, env, staticAsset);
  }

  if (PROXY_EXACT.has(pathname) || PROXY_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return carrResponse(request, env);
  }
  return json({ error: "not_found" }, 404);
}

export default { fetch: handleDoctorcreRequest };
