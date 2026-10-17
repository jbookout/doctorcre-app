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

console.log(`repository check passed: ${fixture.deals.length} synthetic deals, ${contract.mcp_operations.length} pinned MCP operations`);
