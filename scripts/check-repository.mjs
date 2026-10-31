import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readCarrInterface } from "./carr-interface.mjs";

const ROOT = new URL("../", import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT);
const read = (path) => readFile(new URL(path, ROOT), "utf8");
const json = async (path) => JSON.parse(await read(path));

const fixture = await json("data/board-seed.json");
assert.equal(fixture.fixture?.synthetic, true, "the local board fixture must be explicitly synthetic");
assert.equal(fixture.fixture?.schema, "doctorcre-demo-board.v1");
assert.ok(fixture.deals.length >= 8, "the fixture must exercise a useful board");
assert.ok(fixture.deals.every((deal) => /^Demo /.test(deal.name)), "fixture deal names must be visibly fictional");

const contract = await readCarrInterface(ROOT);
assert.equal(contract.schema, "doctorcre-carr-interface.v1");
assert.match(contract.producer.source_commit, /^[0-9a-f]{40}$/);
assert.equal(contract.transport.database_access, "forbidden");
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
    if ([".git", ".worktrees", "node_modules", "coverage", "dist", "build"].includes(entry.name)) continue;
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

// V2 look tells (plan F4), repo-wide: every first-party stylesheet, page and script stays free
// of the V1 tells, so css/tokens.css is the one place a colour is written. Tests, vendored
// libraries and generated test output (out/, gitignored) are not first-party UI.
const TELL_EXTENSIONS = new Set([".css", ".html", ".js", ".mjs"]);
const notFirstParty = (path) => /^(?:test|tests|out)\//.test(path) || /(?:^|\/)vendor\//.test(path);
// Files allowed to write a raw colour, each with its reason. Keep this list short and never
// add chrome to it: a new colour belongs in css/tokens.css as a role.
const RAW_COLOUR_EXCEPTIONS = new Map([
  ["css/tokens.css", "the token file: the one place a colour is written"],
  // MapLibre style JSON takes literal colours, not CSS custom properties, and plan G5 keeps
  // basemap styling outside V2. Both are the placeholder background under a basemap.
  ["tours/itinerary-map.js", "MapLibre placeholder basemap background"],
  ["reports/share.js", "MapLibre basemap background on the public tour share"],
]);
const HEX = "#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})";
const v2Tells = [
  [/(?<!repeating-linear-)gradient\(|<(?:linear|radial)Gradient\b|create(?:Linear|Radial)Gradient\(/, "gradient (only repeating-linear-gradient pattern encoding is allowed)"],
  [/backdrop-filter/, "backdrop-filter"],
  [/Barlow|Oswald|Montserrat/, "font family other than the token faces"],
  // In CSS any hex is a colour. In pages and scripts a colour is a quoted literal or a style
  // declaration value; prose ("PR #1190"), anchors (href="#add") and selector arguments
  // (querySelector("#bad")) are not.
  [new RegExp(`${HEX}\\b`), "raw hex colour outside css/tokens.css", (path) => path.endsWith(".css") && !RAW_COLOUR_EXCEPTIONS.has(path)],
  [new RegExp(`(?<!href=|\\()(["'\`])${HEX}\\1|:\\s*${HEX}(?![\\w-])`), "raw hex colour outside css/tokens.css", (path) => !path.endsWith(".css") && !RAW_COLOUR_EXCEPTIONS.has(path)],
  [/:root\s*\{[^}]*--(?:ground|surface-\d|hairline|fg|accent|font-size-\d|font-text)\s*:/, "palette or type token outside css/tokens.css", (path) => path.endsWith(".css") && path !== "css/tokens.css"],
];
const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
let tellFiles = 0;
for (const path of await files(ROOT_PATH)) {
  const repositoryPath = relative(ROOT_PATH, path);
  if (!TELL_EXTENSIONS.has(extname(path)) || notFirstParty(repositoryPath) || repositoryPath === "scripts/check-repository.mjs") continue;
  tellFiles++;
  const source = withoutComments(await readFile(path, "utf8"));
  for (const [pattern, label, applies = () => true] of v2Tells) {
    if (!applies(repositoryPath)) continue;
    assert.doesNotMatch(source, pattern, `${repositoryPath} contains a V2 tell: ${label}`);
  }
}
assert.ok(tellFiles > 100, "the V2 tells rule must reach the whole first-party tree");

console.log(`repository check passed: ${fixture.deals.length} synthetic deals, ${contract.mcp_operations.length} pinned MCP operations, V2 tells absent from ${tellFiles} first-party files`);
