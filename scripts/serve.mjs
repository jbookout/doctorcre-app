import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atlasFixtureResponse } from "./atlas-fixture.mjs";
import { censusResponse } from "./work-inventory-fixture.mjs";
import { BOARD_ROUTE, boardIdFromPath, legacyBoardDestination } from '../js/progress-board-route.js';

const root = process.env.DOCTORCRE_FIXTURE_ROOT || fileURLToPath(new URL("../", import.meta.url));
const routeContract = JSON.parse(await readFile(new URL("../contracts/app-routes.v1.json", import.meta.url), "utf8"));
const carrContract = JSON.parse(await readFile(new URL("../contracts/carr-interface.v1.json", import.meta.url), "utf8"));
const routes = routeContract.routes;
const redirects = routeContract.redirects || {};
const types = {".css":"text/css; charset=utf-8",".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".png":"image/png",".svg":"image/svg+xml",".webmanifest":"application/manifest+json; charset=utf-8"};


createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    // V5-UX-C15: the fixture's own /app-release, so the independent status page
    // can be exercised here. `?outage=release` (and `all`) refuses it, which is
    // the only way to see the "the app itself did not answer" path in a browser.
    if (url.pathname === "/app-release") {
      const outage = url.searchParams.get("outage");
      if (outage === "release" || outage === "all") {
        response.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "app_release_outage_requested_by_the_fixture_switch" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({
        service: "doctorcre-app", environment: "fixture", source_commit: "0".repeat(40),
        provider_version_id: null, provider_version_tag: null, provider_version_created_at: null,
        carr_contract: { schema: carrContract.schema, version: carrContract.version },
        route_contract: { schema: routeContract.schema, version: routeContract.version },
      }));
      return;
    }
    if (url.pathname === "/api/v1/atlas-graph") {
      // One function decides this route, and test/control-room.test.mjs imports
      // that same function: the fixture cannot drift from what the test certifies.
      const answer = atlasFixtureResponse(url, request.method);
      response.writeHead(answer.status, { ...answer.headers, "cache-control": "no-store" });
      response.end(answer.body === null ? undefined : JSON.stringify(answer.body));
      return;
    }
    if (url.pathname === "/api/v1/work-inventory") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(censusResponse(url)));
      return;
    }
    const boardDestination = legacyBoardDestination(url);
    if (boardDestination) {
      response.writeHead(308, { location: boardDestination.pathname + boardDestination.search, 'cache-control': 'no-store' });
      response.end();
      return;
    }
    if (Object.hasOwn(redirects, url.pathname)) {
      const target = url.pathname === "/business" && url.searchParams.has("q") ? "/search"
        : url.pathname === "/business" && url.searchParams.get("charts") === "1" ? "/?view=charts"
        : redirects[url.pathname];
      const destination = new URL(target, url.origin);
      for (const [key, value] of url.searchParams) if (!destination.searchParams.has(key)) destination.searchParams.append(key, value);
      response.writeHead(308, { location: destination.pathname + destination.search, "cache-control": "no-store" });
      response.end();
      return;
    }
    // Mirrors src/worker.js assetPath: the icons live under public-shell/ and
    // every page links them at /icons/. /favicon.ico is a fixture-only courtesy
    // so a browser's automatic request is not a 404 on every page.
    if (url.pathname.startsWith("/icons/")) url.pathname = `/public-shell${url.pathname}`;
    if (url.pathname === "/favicon.ico") url.pathname = "/public-shell/icons/dealroom.svg";
    const requested = url.pathname === "/deals" && url.searchParams.get("view") === "national" ? "index.html"
      : url.pathname === "/" && url.searchParams.get("view") === "charts" ? "charts.html"
      : routes[boardIdFromPath(url.pathname) ? BOARD_ROUTE : url.pathname] || url.pathname.replace(/^\//, "");
    const path = resolve(root, requested || "workspace.html");
    const repositoryPath = relative(root, path);
    if (repositoryPath.startsWith("..") || isAbsolute(repositoryPath) || !(await stat(path)).isFile()) throw new Error("not found");
    response.writeHead(200, {"content-type": types[extname(path)] || "application/octet-stream", "cache-control":"no-store"});
    response.end(await readFile(path));
  } catch {
    response.writeHead(404, {"content-type":"text/plain; charset=utf-8"});
    response.end("Not found\n");
  }
}).listen(Number(process.env.PORT || 8787), "127.0.0.1", function () { console.log(`DoctorCRE fixture server: http://127.0.0.1:${this.address().port}`); });
