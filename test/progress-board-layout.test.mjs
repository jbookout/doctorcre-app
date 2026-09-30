// Real layout, real browser: at phone (390px) and desktop widths no card
// content may overflow its card, and the page never scrolls sideways. The
// real page and code run against a local server whose /mcp answers with the
// synthetic fixture; nothing in production code knows about this test.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FULL = JSON.parse(await readFile(join(ROOT, "test/fixtures/progress-board-full.json"), "utf8"));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml" };

function findChrome() {
  const candidates = [process.env.CHROME_BIN];
  if (existsSync("/opt/pw-browsers")) for (const dir of readdirSync("/opt/pw-browsers"))
    if (dir.startsWith("chromium-")) candidates.push(join("/opt/pw-browsers", dir, "chrome-linux", "chrome"));
  candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  return candidates.find(path => path && existsSync(path)) || null;
}

const MEASURE = `
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
for (let i = 0; i < 200 && !(document.querySelector("#board-stages .board-card") && document.querySelector(".app-shell-doc")); i += 1)
  await wait(25);
document.querySelector("#live-toggle")?.click();
await wait(50);
const problems = [];
const cards = [...document.querySelectorAll(".board-card, .blocked-card, .completed-card, .ledger-row, .question-card")];
for (const card of cards) {
  const box = card.getBoundingClientRect();
  const name = card.dataset.cardId || card.className;
  if (card.scrollWidth > card.clientWidth + 1) problems.push(name + ": scrollWidth " + card.scrollWidth + " > clientWidth " + card.clientWidth);
  for (const child of card.querySelectorAll("*")) {
    const rect = child.getBoundingClientRect();
    if (!rect.width) continue;
    if (rect.right > box.right + 1 || rect.left < box.left - 1)
      problems.push(name + ": ." + (child.className || child.tagName) + " spills outside its card");
  }
}
for (const model of document.querySelectorAll(".card-model")) {
  const style = getComputedStyle(model);
  if (style.textOverflow !== "ellipsis" || style.whiteSpace !== "nowrap") problems.push("model line is not a one-line ellipsis");
  if (!model.title) problems.push("model line has no title");
}
// PR identifiers are never clipped: the repository name and the number stay readable.
for (const label of document.querySelectorAll(".board-card .card-pr, .blocked-card .card-pr, .completed-card .card-pr")) {
  const owner = label.closest("[data-card-id]")?.dataset.cardId || "card";
  if (label.scrollWidth > label.clientWidth + 1)
    problems.push(owner + ": PR label clipped (" + label.clientWidth + " < " + label.scrollWidth + ")");
}
// Every fixed control is the thing a tap at its centre reaches, with the app shell mounted.
for (const control of document.querySelectorAll("#legend-toggle, .app-shell-doc:not([hidden])")) {
  const rect = control.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  const target = hit?.closest("a, button");
  if (target !== control) problems.push((control.id || control.className) + ": a centre tap reaches " + (target?.id || target?.className || hit?.tagName));
}
const page = document.documentElement;
if (page.scrollWidth > innerWidth + 1) problems.push("page scrolls sideways: " + page.scrollWidth + " > " + innerWidth);
parent.document.body.setAttribute("data-measure", JSON.stringify({ cards: cards.length, width: innerWidth, problems }));
`;

function serve() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/mcp") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const { params } = JSON.parse(body);
      const read = params?.name === "read-progress-board"
        ? (params.arguments?.board_id === "all-repos" ? FULL.all_repos : FULL.project) : {};
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result: { content: [{ text: JSON.stringify({ ok: true, ...read }) }] } }));
      return;
    }
    if (url.pathname === "/__frame") {
      // Headless windows cannot go below 500px, so the page runs in a frame of the exact width.
      const width = Number(url.searchParams.get("width"));
      const board = encodeURIComponent(url.searchParams.get("board"));
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><body style="margin:0"><iframe src="/progress-board?board=${board}"
        style="border:0;width:${width}px;height:2400px"></iframe></body>`);
      return;
    }
    if (url.pathname === "/__measure.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(MEASURE);
      return;
    }
    const path = url.pathname === "/progress-board" ? "/progress-board.html" : url.pathname;
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { response.writeHead(403); response.end(); return; }
    try {
      let content = await readFile(file);
      if (path === "/progress-board.html")
        content = Buffer.from(String(content).replace("</body>", '<script type="module" src="/__measure.js"></script></body>'));
      response.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
      response.end(content);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const chrome = findChrome();

for (const width of [390, 1280]) {
  for (const board of ["carr-v5", "all-repos"]) {
    test(`no card content overflows its card at ${width}px on ${board}`, { skip: chrome ? false : "no Chrome or Chromium found; set CHROME_BIN" }, async () => {
      const server = await serve();
      try {
        const { port } = server.address();
        // Async on purpose: a synchronous spawn would block this process's own server.
        const run = await new Promise(resolve => execFile(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
          "--no-first-run", "--no-proxy-server", "--window-size=1400,2500", "--virtual-time-budget=10000",
          "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
          "--dump-dom", `http://127.0.0.1:${port}/__frame?width=${width}&board=${board}`],
        { encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) => resolve({ stdout: stdout || "", stderr: stderr || String(error || "") })));
        const match = run.stdout.match(/data-measure="([^"]*)"/);
        assert.ok(match, `the page measured itself: ${run.stderr.slice(-400)}`);
        const result = JSON.parse(match[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">"));
        assert.equal(result.width, width);
        assert.ok(result.cards > 10, `cards rendered: ${result.cards}`);
        assert.deepEqual(result.problems, []);
      } finally {
        server.close();
      }
    });
  }
}
