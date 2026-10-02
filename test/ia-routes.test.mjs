import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import routeContract from "../contracts/app-routes.v1.json" with { type: "json" };
import { appShellMarkup, navigationItems } from "../js/app-shell.js";
import { handleDoctorcreRequest } from "../src/worker.js";

const origin = "https://app.doctorcre.com";
const originalPaths = [
  "/", "/control-room", "/progress-board", "/workspace", "/deals", "/leads",
  "/clients", "/vendors", "/calendar", "/ideas", "/system-work.html",
  "/room.html", "/queue.html", "/tours", "/share", "/design",
  "/design/business", "/design/operations", "/work-inventory", "/tasks",
  "/pipeline", "/business", "/status", "/incidents", "/notifications",
  "/conversations",
];

const newHomes = {
  "/tasks": "/", "/work": "/", "/tasks.html": "/",
  "/progress-board": "/control-room/progress",
  "/workspace": "/",
  "/queue.html": "/control-room/progress/work?view=tasks",
  "/control-room/agents/queue": "/control-room/progress/work?view=tasks",
  "/pipeline": "/deals?view=board",
  "/business": "/",
  "/system-work.html": "/work-requests",
  "/room.html": "/control-room/progress/work?view=wire",
  "/agent-room": "/control-room/progress/work?view=wire",
  "/design": "/design-lab",
  "/design/business": "/design-lab?reference=business",
  "/design/operations": "/design-lab?reference=operations",
  "/work-inventory": "/all-work",
  "/notifications": "/updates",
  "/conversations": "/doc-chats",
  "/ideas": "/ideas-events",
};

const html = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const env = {
  CARR: { fetch: async () => new Response("admitted") },
  ASSETS: { fetch: async (request) => {
    const asset = new URL(request.url).pathname.slice(1);
    return new Response(await html(asset), { headers: { "content-type": "text/html" } });
  } },
};

test("the approved map accounts for every original path with a permanent home", async () => {
  assert.equal(originalPaths.length, 26);
  assert.deepEqual(Object.keys(routeContract.redirects || {}).sort(), Object.keys(newHomes).sort());
  for (const path of originalPaths) {
    const response = await handleDoctorcreRequest(new Request(`${origin}${path}`), env);
    if (path === "/share") {
      assert.equal(response.status, 302);
      assert.match(response.headers.get("location"), /^https:\/\/reports\.doctorcre\.com\/share/);
      continue;
    }
    let destination = path;
    if (path in newHomes) {
      assert.equal(response.status, 308, `${path}: permanent redirect`);
      const location = new URL(response.headers.get("location"), origin);
      destination = `${location.pathname}${location.search}`;
      assert.equal(destination, newHomes[path], `${path}: approved home`);
    }
    const final = path in newHomes
      ? await handleDoctorcreRequest(new Request(`${origin}${destination}`), env)
      : response;
    assert.equal(final.status, 200, `${path}: destination renders`);
    const page = await final.text();
    assert.match(page, /id="appShell"/, `${path}: shared shell mount`);
    assert.match(page, /src="(?:\.\.\/)?\/?js\/app-shell\.js"/, `${path}: shared shell script`);
    assert.deepEqual(
      [...appShellMarkup(new URL(destination, origin).pathname).matchAll(/data-app-nav-item[^>]*aria-label="([^"]+)"/g)].map((match) => match[1]),
      navigationItems.map((item) => item.label), `${path}: identical navigation`,
    );
  }
});

test("the shell has seven top sections and grouped secondary destinations", () => {
  assert.deepEqual(navigationItems.filter(item => !item.group).map((item) => item.label),
    ["Home", "Leads", "Tours", "Deals", "Vendors", "Control Room"]);
  const shell = appShellMarkup("/tasks");
  for (const group of ["Updates", "Operations", "Reference"]) {
    assert.match(shell, new RegExp(`app-shell-more-group[^>]*>${group}`));
  }
  for (const name of ["Updates", "Doc Chats", "Work Requests", "All Work", "Incidents", "Project activity", "Design Lab", "Status"]) {
    assert.match(shell, new RegExp(`aria-label="${name}" href="[^"]+">${name}`));
  }
});

test("legacy search and tab links retain the query after redirection", async () => {
  const search = await handleDoctorcreRequest(new Request(`${origin}/business?q=mobile%20clinic`), env);
  assert.equal(search.status, 308);
  assert.equal(new URL(search.headers.get("location")).pathname, "/search");
  assert.equal(new URL(search.headers.get("location")).searchParams.get("q"), "mobile clinic");
  const charts = await handleDoctorcreRequest(new Request(`${origin}/business?charts=1&group=phase&pick=Pending`), env);
  assert.equal(charts.status, 308);
  assert.equal(new URL(charts.headers.get("location")).searchParams.get("view"), "charts");
  assert.equal(new URL(charts.headers.get("location")).searchParams.get("group"), "phase");
  const events = await handleDoctorcreRequest(new Request(`${origin}/ideas?tab=events`), env);
  assert.equal(events.status, 308);
  assert.equal(new URL(events.headers.get("location")).pathname, "/ideas-events");
  assert.equal(new URL(events.headers.get("location")).searchParams.get("tab"), "events");
  const board = await handleDoctorcreRequest(new Request(`${origin}/pipeline?filter=active`), env);
  assert.equal(board.status, 308);
  assert.equal(new URL(board.headers.get("location")).pathname, "/deals");
  assert.equal(new URL(board.headers.get("location")).searchParams.get("view"), "board");
  assert.equal(new URL(board.headers.get("location")).searchParams.get("filter"), "active");
});
