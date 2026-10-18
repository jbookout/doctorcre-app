import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const read = (path) => readFile(new URL(path, ROOT), "utf8");
const json = async (path) => JSON.parse(await read(path));

const fixture = await json("data/board-seed.json");
assert.equal(fixture.fixture?.synthetic, true, "the local board fixture must be explicitly synthetic");
assert.equal(fixture.fixture?.schema, "doctorcre-demo-board.v1");
assert.ok(fixture.deals.length >= 8, "the fixture must exercise a useful board");
assert.ok(fixture.deals.every((deal) => /^Demo /.test(deal.name)), "fixture deal names must be visibly fictional");

const contract = await json("contracts/carr-interface.v1.json");
assert.equal(contract.schema, "doctorcre-carr-interface.v1");
assert.match(contract.producer.source_commit, /^[0-9a-f]{40}$/);
assert.equal(contract.transport.database_access, "forbidden");
assert.deepEqual(contract.mcp_operations, [...new Set(contract.mcp_operations)].sort(),
  "the versioned MCP operations must be unique and sorted");
const textExtensions = new Set([".js", ".mjs", ".ts", ".tsx", ".json", ".html", ".css", ".md", ".yml", ".yaml"]);
const forbidden = [
  [/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/, "private key"],
  [/postgres(?:ql)?:\/\//i, "database connection string"],
  [/@neondatabase|DATABASE_URL/, "database implementation or credential name", (path) => path.startsWith("js/")],
  // A PATH SEGMENT, not a substring. The repository that produces those reads
  // is named by a whole directory in an import path; `./control-room-model.js`
  // is a module in THIS repository whose name merely starts with the same
  // letters, and refusing it would refuse the app's own Control Room page.
  [/(?:from\s+|import\s*\(\s*)["'](?:[^"']*\/)?(?:carr-system|mcp-server|control-room)(?:\/[^"']*)?["']/, "cross-repository source import"]
];

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "coverage", "dist", "build"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else result.push(path);
  }
  return result;
}

for (const path of await files(ROOT_PATH)) {
  if (!textExtensions.has(extname(path))) continue;
  const repositoryPath = relative(ROOT_PATH, path);
  if (repositoryPath === "scripts/check-repository.mjs") continue;
  const source = await readFile(path, "utf8");
  for (const [pattern, label, applies = () => true] of forbidden) {
    if (!applies(repositoryPath)) continue;
    assert.doesNotMatch(source, pattern, `${repositoryPath} contains a ${label}`);
  }
}

// V2 look tells (plan F4): stylesheets already moved onto css/tokens.css stay free of the
// V1 tells. Add a file here when its slice migrates it; never remove one.
const V2_MIGRATED_STYLESHEETS = [
  "css/tokens.css", "css/system.css", "css/app-shell.css", "css/workspace.css",
  "css/correspondence.css", "public-shell/shell.css",
  "css/home-dashboard.css", "css/relationship-network.css", "css/lease-radar.css", "css/business-workspace.css",
  "css/app.css", "css/pipeline.css", "css/deal-timeline.css",
  "css/conversations.css", "css/tasks.css", "css/doc-activity.css", "css/doc-presence.css", "css/morning-brief.css",
  "css/workspace-business.css", "css/leads.css", "css/invoice-tracker.css",
  "css/calendar.css", "css/ideas.css", "css/notifications.css",
];
const v2Tells = [
  [/(?<!repeating-linear-)gradient\(/, "gradient (only repeating-linear-gradient pattern encoding is allowed)"],
  [/backdrop-filter/, "backdrop-filter"],
  [/Barlow|Oswald|Montserrat/, "font family other than the token faces"],
  [/#[0-9a-fA-F]{3,8}\b/, "raw hex colour outside css/tokens.css", (path) => path !== "css/tokens.css"],
  [/:root\s*\{[^}]*--(?:ground|surface-\d|hairline|fg|accent|font-size-\d|font-text)\s*:/, "palette or type token outside css/tokens.css", (path) => path !== "css/tokens.css"],
];
for (const path of V2_MIGRATED_STYLESHEETS) {
  const source = (await read(path)).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [pattern, label, applies = () => true] of v2Tells) {
    if (!applies(path)) continue;
    assert.doesNotMatch(source, pattern, `${path} contains a V2 tell: ${label}`);
  }
}

console.log(`repository check passed: ${fixture.deals.length} synthetic deals, ${contract.mcp_operations.length} pinned MCP operations`);
