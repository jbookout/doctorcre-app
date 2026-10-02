import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { boardDirectory, boardView } from "../js/progress-board-model.js";
import { execFileSync } from "node:child_process";

const contract = JSON.parse(await readFile(new URL("../contracts/carr-interface.v1.json", import.meta.url), "utf8"));
const pinnedProducer = "993f6e630aca20175b92a0475b2dda3dd51bdba9";

test("property evidence pins the Progress directory CARR producer", () => {
  assert.equal(contract.producer.source_commit, pinnedProducer);
});

// Opt-in cross-repository verification reads committed source, never a working
// tree or database. The ordinary app suite remains offline and self-contained.
test("the exact pinned producer serves property evidence alongside the existing Tour reads", {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && "Set CARR_PRODUCER_CHECKOUT to verify the pinned producer",
}, async () => {
  const git = (...args) => execFileSync("git", ["-C", process.env.CARR_PRODUCER_CHECKOUT, ...args], { encoding: "utf8" });
  const pin = contract.producer.source_commit;
  const timestampSource = git("show", `${pin}:mcp-server/src/tour-route-timestamp.js`);
  const timestampModule = `data:text/javascript;base64,${Buffer.from(timestampSource).toString("base64")}`;
  const source = git("show", `${pin}:mcp-server/src/tour-internal-web.js`)
    .replace('"./tour-route-timestamp.js"', JSON.stringify(timestampModule));
  const { createTourInternalWebHandler, isTourInternalRequest } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const propertyId = "10000000-0000-4000-8000-000000000001";
  const asOf = "2026-09-29T12:00:00.000Z";
  const data = { schema: "tour-property-evidence.v1", property_id: propertyId, as_of: asOf, facts: {} };
  const calls = [];
  const handler = createTourInternalWebHandler({
    readPropertyEvidenceFn: async context => { calls.push(context); return { ok: true, data }; },
    listToursFn: async () => ({ ok: true, data: { tours: [] } }),
    readTourSelectionCartFn: async () => ({ ok: true, data: { stops: [] } }),
  });
  const request = new Request(`https://app.doctorcre.com/api/tours/property-evidence/v1?property_id=${propertyId}&as_of=${encodeURIComponent(asOf)}`);
  const env = { APP_HOST: "app.doctorcre.com" };
  const actor = { id: "synthetic-partner" };
  const session = { csrfToken: "synthetic-csrf" };
  const response = await handler.fetch(request, env, {}, actor, session);
  assert.equal(response.status, 200, `property evidence must exist at ${pin}`);
  assert.equal(isTourInternalRequest(request), true);
  assert.deepEqual(await response.json(), { data, csrf_token: session.csrfToken });
  assert.deepEqual(calls[0].input, { property_id: propertyId, as_of: asOf });
  assert.deepEqual(calls[0].actor, actor);
  assert.equal((await handler.fetch(request, env, {})).status, 401);
  for (const path of ["/api/tours/library", `/api/tours/selection-cart?tour_id=${propertyId}`]) {
    assert.equal((await handler.fetch(new Request(`https://app.doctorcre.com${path}`), env, {}, actor, session)).status, 200);
  }
  git("merge-base", "--is-ancestor", "c4f1ad45273175c26c074336c0fecbf789718348", pin);
  git("merge-base", "--is-ancestor", "0cc6fe2538a81521bf8c25b0df58aa4063ed614b", pin);
});


test("the app consumes the merged producer's directory and selected-board interface", {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && "Set CARR_PRODUCER_CHECKOUT to verify the pinned board interface",
}, async () => {
  const committed = path => execFileSync("git", ["-C", process.env.CARR_PRODUCER_CHECKOUT,
    "show", `${contract.producer.source_commit}:${path}`], { encoding: "utf8" });
  const modules = new Map();
  async function moduleUrl(path) {
    if (modules.has(path)) return modules.get(path);
    let source = committed(path);
    for (const match of [...source.matchAll(/from\s+"(\.\/[^"\n]+)"/g)]) {
      const dependency = await moduleUrl(posix.join(posix.dirname(path), match[1]));
      source = source.replace(JSON.stringify(match[1]), JSON.stringify(dependency));
    }
    const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
    modules.set(path, url);
    return url;
  }
  const { boardAnswerTools } = await import(await moduleUrl("mcp-server/src/board-answers.js"));
  const tools = boardAnswerTools({ withEnvelope() { assert.fail("reads must not write"); }, writeEvent() { assert.fail("reads must not audit as writes"); } });
  for (const verb of ["list-progress-boards", "read-progress-board", "answer-board-question"])
    assert.ok(contract.mcp_operations.includes(verb));
  assert.equal(tools["list-progress-boards"].write, false);
  assert.deepEqual(tools["list-progress-boards"].inputSchema, { type: "object", additionalProperties: false, properties: {} });
  assert.equal(tools["read-progress-board"].write, false);
  assert.deepEqual(tools["read-progress-board"].inputSchema.required, ["board_id"]);
  assert.equal(tools["answer-board-question"].humanOnly, true);
  const actor = { id: "10000000-0000-4000-8000-000000000001", slug: "codex", human: false,
    native_agent_verified: true, sponsoring_human_slug: "joe" };
  const row = { board_id: "carr-v5", version: 2, updated_at: "2026-10-01T12:00:00Z",
    snapshot_json: { title: "Synthetic system board", tasks: { build: { status: "running", title: "Synthetic build" },
      malformed: [], prototype: { status: "__proto__" } } } };
  const calls = [];
  const client = { async query(sql, params) {
    calls.push([sql, params]);
    assert.match(sql, /(?:q\.)?organization_tenant_id=\$1 and (?:q\.)?sponsoring_human_slug=\$2/);
    assert.deepEqual(params.slice(0, 2), ["carr-internal", "joe"]);
    return { rows: sql.includes("from board_question") ? [] : [row] };
  } };
  const directory = boardDirectory(await tools["list-progress-boards"].handler(client, actor, {}));
  assert.equal(directory[0].updated_at, row.updated_at);
  assert.deepEqual(directory[0].task_counts, JSON.parse('{"__proto__":1,"running":1}'));
  assert.equal("snapshot_json" in directory[0], false);
  const view = boardView(await tools["read-progress-board"].handler(client, actor, { board_id: "carr-v5" }));
  assert.equal(view.version, 2);
  assert.equal(view.updated_at, directory[0].updated_at);
  assert.equal(view.stages.flatMap(stage => stage.tasks).length, 2);
  assert.deepEqual(calls[1][1], ["carr-internal", "joe", "carr-v5"]);
});
