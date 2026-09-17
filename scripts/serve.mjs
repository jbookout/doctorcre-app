import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const routes = JSON.parse(await readFile(new URL("../contracts/app-routes.v1.json", import.meta.url), "utf8")).routes;
const types = {".css":"text/css; charset=utf-8",".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".png":"image/png",".svg":"image/svg+xml",".webmanifest":"application/manifest+json; charset=utf-8"};

/**
 * Synthetic V5-UX-C10 census. Every name starts with "Demo " so nothing here can
 * be mistaken for a record. It is deliberately NOT a clean census: portfolio_node
 * is unavailable and loop is partial, because the empty-looking incomplete census
 * is the exact state the surface exists to make visible, and a fixture that only
 * shows the happy path never exercises it.
 */
const CENSUS_SOURCE_REFS = {
  work_request: "ops.work_request", portfolio_node: "ops.portfolio_node", loop: "public.loop_item",
  work_shape: "ops.work_shape_revision", slice_plan: "ops.engineering_slice_plan", governance_item: "ops.rule_admission",
};
const CENSUS_KINDS = Object.keys(CENSUS_SOURCE_REFS);
const SYSTEM_WORK = "/system-work.html";

const censusItem = (kind, id, version, title, status, updated_at, related, open) => ({
  kind, id, version, title, status, source_ref: CENSUS_SOURCE_REFS[kind], updated_at,
  related, unlinked: related.length === 0, open,
});

const CENSUS_PAGES = [
  [
    censusItem("work_request", "WR-000061", "4", "Demo bounded request: reconcile vendor rows", "in_progress", "2026-09-16T13:40:00.000Z", [{ kind: "doctrine_section", id: "demo-origin-0001" }], SYSTEM_WORK),
    censusItem("work_request", "WR-000059", "7", "Demo bounded request: retire the demo export", "superseded", "2026-09-16T11:05:00.000Z", [{ kind: "work_request", id: "WR-000061" }], SYSTEM_WORK),
    censusItem("work_request", "WR-000901", "4", "Demo built, not merged", "in_progress", "2026-09-16T10:00:00.000Z", [{ kind: "portfolio_node", id: "PF-DEMO-1" }], SYSTEM_WORK),
    censusItem("work_request", "WR-000902", "2", "Demo merged, not activated", "in_progress", "2026-09-16T09:00:00.000Z", [{ kind: "portfolio_node", id: "PF-DEMO-2" }], SYSTEM_WORK),
    censusItem("work_request", "WR-000903", "7", "Demo active, consumer unproven", "in_progress", "2026-09-16T08:00:00.000Z", [], SYSTEM_WORK),
    censusItem("work_request", "WR-000904", "1", "Demo captured in error", "captured", "2026-09-16T07:00:00.000Z", [], SYSTEM_WORK),
    censusItem("work_request", "WR-000905", "3", "Demo stale plan", "in_progress", "2026-09-16T06:00:00.000Z", [{ kind: "portfolio_node", id: "PF-DEMO-1" }], SYSTEM_WORK),
    censusItem("loop", "612", "3", "Demo loop: name the owner of the demo digest", "dormant", "2026-09-15T22:18:00.000Z", [], null),
    censusItem("work_shape", "8f21c4a0-0000-4000-8000-000000000001", "2", "Demo bounded request: reconcile vendor rows", "unset", "2026-09-15T20:02:00.000Z", [{ kind: "work_request", id: "WR-000061" }], SYSTEM_WORK),
    censusItem("slice_plan", "b1d7e9c2-0000-4000-8000-000000000002", "4", "Demo slice plan: census consumer surface", "registered", "2026-09-15T17:44:00.000Z", [{ kind: "work_request", id: "WR-000061" }], SYSTEM_WORK),
    censusItem("governance_item", "demo-rule-7ac1", "1", "Demo rule admission: shadow-only delivery for the demo pack", "declined", "2026-09-15T09:30:00.000Z", [], null),
  ],
  [
    censusItem("work_request", "WR-000048", "12", "Demo bounded request: portability of the demo census", "closed", "2026-09-14T16:20:00.000Z", [], SYSTEM_WORK),
    censusItem("loop", "250", "1", "Demo loop: the living-orb panel visual", "dormant", "2026-09-13T08:00:00.000Z", [{ kind: "loop_domain", id: "demo-design" }], null),
    censusItem("governance_item", "demo-rule-31bd", "5", "Demo rule admission: coverage travels with every count", "active", "2026-09-12T19:10:00.000Z", [{ kind: "guidance_intake", id: "demo-intake-0004" }], null),
  ],
];

// One leg is down and one cannot be counted, so census_complete is false and the
// surface must say so rather than presenting the page below as the whole truth.
const CENSUS_LEG_STATE = {
  work_request: { state: "complete", total: 7, reason: null },
  portfolio_node: { state: "unavailable", total: null, reason: "DEPENDENCY_UNAVAILABLE" },
  loop: { state: "partial", total: null, reason: "count_unavailable;rows_missing_order_key:1" },
  work_shape: { state: "complete", total: 1, reason: null },
  slice_plan: { state: "complete", total: 1, reason: null },
  governance_item: { state: "complete", total: 2, reason: null },
};

function censusResponse(url) {
  const requestedKinds = (url.searchParams.get("kinds") || "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const kinds = requestedKinds.length > 0 ? CENSUS_KINDS.filter((kind) => requestedKinds.includes(kind)) : [...CENSUS_KINDS];
  const limit = Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100;
  const pageIndex = url.searchParams.get("cursor") === "demo-cursor-page-2" ? 1 : 0;
  const items = CENSUS_PAGES[pageIndex].filter((item) => kinds.includes(item.kind)).slice(0, limit);
  const coverage = kinds.map((kind) => {
    const leg = CENSUS_LEG_STATE[kind];
    const row = {
      kind, source_ref: CENSUS_SOURCE_REFS[kind], state: leg.state,
      count_returned: items.filter((item) => item.kind === kind).length,
      count_total: leg.total, reason: leg.reason,
    };
    if (leg.state === "unavailable") return row;
    return { ...row, excluded_other_tenant: 0, page_capped: false };
  });
  const complete = coverage.every((entry) => entry.state === "complete");
  const unreadable = coverage.filter((entry) => entry.state === "unavailable").map((entry) => entry.kind);
  const partial = coverage.filter((entry) => entry.state === "partial").map((entry) => entry.kind);
  const observed = new Date();
  return {
    viewer: "joe", tenant: "carr-internal", kinds, statuses: null, limit,
    items, coverage, census_complete: complete,
    next_cursor: pageIndex === 0 && CENSUS_PAGES[1].some((item) => kinds.includes(item.kind)) ? "demo-cursor-page-2" : null,
    source: {
      source: "work_inventory_census",
      source_ref: kinds.map((kind) => CENSUS_SOURCE_REFS[kind]).join("+"),
      observed_at: observed.toISOString(),
      valid_until: new Date(observed.valueOf() + 60_000).toISOString(),
      freshness: complete ? "fresh" : "unknown",
      correlation_id: `demo-census-${observed.valueOf()}`,
      safe_explanation: unreadable.length > 0
        ? `This census is INCOMPLETE, not empty: ${unreadable.join(", ")} could not be read. The remaining sources are current as of this request.`
        : partial.length > 0
          ? `This census returned every row it could enumerate, but ${partial.join(", ")} could not be counted in full, so a total is not claimed.`
          : "Fresh because every source answered a no-store request-time canonical read; valid for 60 seconds.",
    },
  };
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/api/v1/work-inventory") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(censusResponse(url)));
      return;
    }
    const requested = routes[url.pathname] || url.pathname.replace(/^\//, "");
    const path = resolve(root, requested || "workspace.html");
    const repositoryPath = relative(root, path);
    if (repositoryPath.startsWith("..") || isAbsolute(repositoryPath) || !(await stat(path)).isFile()) throw new Error("not found");
    response.writeHead(200, {"content-type": types[extname(path)] || "application/octet-stream", "cache-control":"no-store"});
    response.end(await readFile(path));
  } catch {
    response.writeHead(404, {"content-type":"text/plain; charset=utf-8"});
    response.end("Not found\n");
  }
}).listen(8787, "127.0.0.1", () => console.log("DoctorCRE fixture server: http://127.0.0.1:8787"));
