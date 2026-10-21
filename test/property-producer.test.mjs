import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { boardDirectory, boardView } from "../js/progress-board-model.js";
import { execFileSync } from "node:child_process";
import { handleDoctorcreRequest } from "../src/worker.js";
import { validSystemWork, groupSystemWork, recentLive } from "../js/system-work-board-model.js";
import { renderDealChecklist } from "../js/deal-checklist.js";

const contract = JSON.parse(await readFile(new URL("../contracts/carr-interface.v1.json", import.meta.url), "utf8"));

const producerModules = new Map();
async function producerModuleUrl(path) {
  if (producerModules.has(path)) return producerModules.get(path);
  let source = execFileSync("git", ["-C", process.env.CARR_PRODUCER_CHECKOUT,
    "show", `${contract.producer.source_commit}:${path}`], { encoding: "utf8" });
  for (const match of [...source.matchAll(/from\s+(["'])(\.\.?\/[^"'\n]+)\1/g)]) {
    const dependency = await producerModuleUrl(posix.join(posix.dirname(path), match[2]));
    source = source.replace(match[1] + match[2] + match[1], JSON.stringify(dependency));
  }
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  producerModules.set(path, url);
  return url;
}

test("the runtime pin binds the checklist and feature-switch reads to one producer", () => {
  for (const producer of [contract.mcp_read_contracts["get-deal-room"].producer,
    contract.mcp_read_contracts["get-deal-room"].checklist.producer,
    contract.mcp_read_contracts["list-feature-switches"].producer]) {
    assert.equal(producer.repository, contract.producer.repository);
    assert.equal(producer.source_commit, contract.producer.source_commit);
  }
});

test("the advertised runtime registers inherited conversation, notification, session and room contracts", {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && "Set CARR_PRODUCER_CHECKOUT to verify inherited registrations",
}, async () => {
  const registry = execFileSync("git", ["-C", process.env.CARR_PRODUCER_CHECKOUT,
    "show", `${contract.producer.source_commit}:mcp-server/src/tools.js`], { encoding: "utf8" });
  for (const [module, factory, verbs] of [
    ["doc-conversation.js", "docConversationTools", ["read-doc-conversation", "list-doc-conversations", "create-doc-conversation", "rename-doc-conversation", "share-doc-conversation"]],
    ["notifications.js", "notificationTools", ["notification-feed", "acknowledge-notification", "read-notification-preferences", "set-notification-preference"]],
    ["codex-continuity.js", "codexContinuityTools", ["list-my-codex-sessions"]],
    ["session-identity.js", "sessionIdentityTools", ["read-session-identity", "read-dispatch-history"]],
    ["partner-room.js", "partnerRoomTools", ["read-room", "read-room-latest", "read-room-queue", "add-room-turn"]],
    ["dispatch-spine.js", "dispatchSpineTools", ["record-dispatch-link", "acknowledge-dispatch"]],
    ["tour-property-search.js", "tourPropertySearchTools", ["search-tour-properties", "read-tour-selection-cart", "append-tour-selection-cart-version"]],
  ]) {
    assert.match(registry, new RegExp(`registerTools\\(${factory}\\(`), `${factory} must be registered`);
    const producer = await import(await producerModuleUrl(`mcp-server/src/${module}`));
    const tools = producer[factory]({});
    for (const verb of verbs) {
      assert.ok(contract.mcp_operations.includes(verb), `${verb} must remain in the app interface`);
      assert.equal(typeof tools[verb]?.handler, "function", `${verb} must exist at the advertised runtime`);
      assert.equal(tools[verb].inputSchema.type, "object");
    }
  }
});

test("the same advertised producer derives the versioned checklist consumed by the app", {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && "Set CARR_PRODUCER_CHECKOUT to verify checklist derivation",
}, async () => {
  const { deriveDealChecklist, CHECKLIST_SOURCES } = await import(await producerModuleUrl("mcp-server/src/deal-checklist.js"));
  const seam = contract.mcp_read_contracts["get-deal-room"].checklist;
  const checklist = deriveDealChecklist({ type: "renewal", critical_dates: [
    { id: "synthetic-review", kind: "attorney_review", due_on: "2026-10-20", source: "fixture:review", status: "open" },
  ] }, CHECKLIST_SOURCES.map(source => ({ id: source.section_id, body_hash: source.content_hash, status: "active" })), "2026-10-20");
  assert.equal(checklist.schema_version, seam.schema_version);
  assert.equal(checklist.template_state, "current");
  assert.deepEqual(checklist.phases.map(phase => phase.id), seam.phase_keys);
  assert.ok(checklist.phases.flatMap(phase => phase.items).every(item => seam.statuses.includes(item.status)));
  assert.equal(checklist.due_items[0].status, "due");
  assert.match(renderDealChecklist(checklist), /data-checklist-item="critical-date:synthetic-review"/);
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
  const { boardAnswerTools } = await import(await producerModuleUrl("mcp-server/src/board-answers.js"));
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
    // Publisher totals include cards omitted from the bounded task payload.
    snapshot_json: { title: "Synthetic system board", task_counts: JSON.parse('{"__proto__":1,"running":7}'),
      tasks: { build: { status: "running", title: "Synthetic build" },
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
  assert.deepEqual(directory[0].task_counts, JSON.parse('{"__proto__":1,"running":7}'));
  assert.equal("snapshot_json" in directory[0], false);
  const view = boardView(await tools["read-progress-board"].handler(client, actor, { board_id: "carr-v5" }));
  assert.equal(view.version, 2);
  assert.equal(view.updated_at, directory[0].updated_at);
  assert.equal(view.stages.flatMap(stage => stage.tasks).length, 2);
  assert.deepEqual(calls[1][1], ["carr-internal", "joe", "carr-v5"]);
});

// Feature revisions record provenance. The one CARR service binding must serve
// the entire interface at the advertised runtime revision.
test("the advertised runtime producer retains Unfinished and the system-filtered Live Library", {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && "Set CARR_PRODUCER_CHECKOUT to verify inherited system work",
}, () => {
  const committed = path => execFileSync("git", ["-C", process.env.CARR_PRODUCER_CHECKOUT,
    "show", `${contract.producer.source_commit}:${path}`], { encoding: "utf8" });
  const registry = committed("mcp-server/src/tools.js");
  assert.ok(/import.*systemWorkTools.*system-work-census/.test(registry), "pinned producer lacks the inherited system-work module import");
  assert.ok(/registerTools\(systemWorkTools\(/.test(registry), "pinned producer must register inherited system-work tools");
  assert.match(committed("mcp-server/src/system-work-census.v5.js"), /["']unfinished-work["']\s*:/);

  assert.match(committed("mcp-server/src/work-inventory-census.v5.js"), /system === true/);
});

test("the pinned Unfinished handler returns unfinished and completed records consumable by Control Room", {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && "Set CARR_PRODUCER_CHECKOUT to verify system-work reads",
}, async () => {
  const { systemWorkTools } = await import(await producerModuleUrl("mcp-server/src/system-work-census.v5.js"));
  const tool = systemWorkTools()["unfinished-work"];
  assert.equal(tool.write, false);
  assert.equal(tool.inputSchema.properties.live_library.type, "boolean");
  const actor = { slug: "joe", human: true };
  const calls = [];
  const client = { async query(sql, params) {
    calls.push([sql, params]);
    assert.match(sql, /^select /, "census must only read");
    assert.deepEqual(params.slice(0, 2), ["carr-internal", "joe"]);
    if (sql.includes("from public.board_snapshot")) return { rows: [] };
    assert.match(sql, /from public.loop_item/);
    if (sql.startsWith("select count(*)")) return { rows: [{ count: "1" }] };
    const completed = params[2];
    return { rows: [{ id: completed ? "completed-loop" : "unfinished-loop", title: "Synthetic system work",
      state: completed ? "done" : "open", opened_at: "2026-10-01T12:00:00Z",
      last_activity_at: "2026-10-02T12:00:00Z", owner: "joe", version: "1",
      completed, cancelled: false, identity: { loop_id: 1, kind: "open_loop" } }] };
  } };
  for (const live_library of [false, true]) {
    const read = validSystemWork(await tool.handler(client, actor, { kinds: "loop", live_library, limit: 1 }));
    assert.equal(read.viewer, "joe");
    assert.equal(read.census_complete, true);
    assert.equal(read.next_cursor, null);
    assert.equal(read.coverage[0].count_total, 1);
    assert.equal(read.items[0].completed, live_library);
    assert.equal(read.items[0].id, live_library ? "completed-loop" : "unfinished-loop");
    assert.deepEqual(groupSystemWork(read.items)[0].items, read.items);
    assert.deepEqual(recentLive(read.items), read.items);
    assert.equal(read.items[0].available_triage_actions.length, live_library ? 0 : 3);
  }
  assert.equal(calls.length, 6);
});

test("the same advertised runtime producer registers Doc activity", {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && "Set CARR_PRODUCER_CHECKOUT to verify runtime activity admission",
}, () => {
  const registry = execFileSync("git", ["-C", process.env.CARR_PRODUCER_CHECKOUT,
    "show", `${contract.producer.source_commit}:mcp-server/src/tools.js`], { encoding: "utf8" });
  assert.ok(/registerTools\(docActivityTools\(/.test(registry),
    "the advertised runtime producer must register Doc activity alongside inherited system work");
});

// Evaluate only the pinned producer's route predicate and its declarations.
// This proves gate admission without loading its database or credential doors.
test("Doc activity reaches the exact pinned CARR browser route predicate through the app Worker", {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && "Set CARR_PRODUCER_CHECKOUT to verify gate admission",
}, async () => {
  const committed = path => execFileSync("git", ["-C", process.env.CARR_PRODUCER_CHECKOUT,
    "show", `${contract.producer.source_commit}:${path}`], { encoding: "utf8" });
  const source = committed("mcp-server/src/dealroom-web.js");
  const business = committed("mcp-server/src/workspace-business-read.js");
  const declaration = (text, name) => {
    const found = text.match(new RegExp(`^(?:export )?const ${name} = [\\s\\S]*?;\\n`, "m"));
    assert.ok(found, `producer declaration missing: ${name}`);
    return found[0].replace(/^export /, "");
  };
  const functions = ["cookieValue", "dealroomOrigin", "doctorcreAppOrigin", "dealroomOriginForRequest",
    "legacyDealroomOrigin", "requestMatchesDealroomOrigin", "isDealroomRequest"].map(name => {
      const found = source.match(new RegExp(`^(?:export )?function ${name}\\([^]*?^}`, "m"));
      assert.ok(found, `producer route function missing: ${name}`);
      return found[0].replace(/^export /, "");
    });
  const constants = ["SESSION_COOKIE", "SYSTEM_WORK_PREFIX", "COMMAND_CENTER_API_PREFIX", "DEALROOM_HOST_PATTERN",
    "APP_DOCUMENT_PATHS", "DEALROOM_EXACT_PATHS", "DEALROOM_PATH_PREFIXES"].map(name => declaration(source, name));
  const businessConstants = ["CLIENTS_ROUTE", "VENDORS_ROUTE", "BUSINESS_ASSET_PATH"].map(name => declaration(business, name));
  const module = [...businessConstants, ...constants, ...functions, "export { isDealroomRequest };"].join("\n");
  const { isDealroomRequest } = await import(`data:text/javascript;base64,${Buffer.from(module).toString("base64")}`);
  const origin = "https://app.doctorcre.com", env = { DOCTORCRE_APP_HOST: "app.doctorcre.com" };
  assert.equal(isDealroomRequest(new Request(origin + "/doc-activity"), env), false, "the unmapped route is not admitted");
  const carr = { fetch: async request => {
    assert.equal(isDealroomRequest(request, env), true, "the forwarded gate path must be admitted by the pin");
    return request.headers.has("cookie") ? new Response(null)
      : new Response(null, { status: 302, headers: { location: origin + "/auth/login?return_to=%2Fcontrol-room" } });
  } };
  const assets = { fetch: async request => new Response(new URL(request.url).pathname) };
  const signedIn = await handleDoctorcreRequest(new Request(origin + "/doc-activity", { headers: { cookie: "synthetic-session" } }), { CARR: carr, ASSETS: assets });
  assert.equal(await signedIn.text(), "/activity.html");
  const signedOut = await handleDoctorcreRequest(new Request(origin + "/doc-activity?partner=dell"), { CARR: carr, ASSETS: assets });
  assert.equal(signedOut.status, 302);
  assert.equal(new URL(signedOut.headers.get("location")).searchParams.get("return_to"), "/doc-activity?partner=dell");
});

test("the advertised runtime producer accepts the inherited Live Library system=true query", {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && "Set CARR_PRODUCER_CHECKOUT to verify system-filtered inventory",
}, async () => {
  const source = execFileSync("git", ["-C", process.env.CARR_PRODUCER_CHECKOUT,
    "show", `${contract.producer.source_commit}:mcp-server/src/dealroom-web.js`], { encoding: "utf8" });
  const found = source.match(/^async function workInventoryResponse\([^]*?^}/m);
  assert.ok(found, "producer must expose its inventory response handler");
  const module = `const workspaceCommandCenterEnabled = () => true;
    const JSON_HEADERS = { "content-type": "application/json" };
    const json = (body, status=200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
    ${found[0]}
    export { workInventoryResponse };`;
  const { workInventoryResponse } = await import(`data:text/javascript;base64,${Buffer.from(module).toString("base64")}`);
  let consumed;
  const inventory = { schema: "unfinished-work.v1", items: [{ id: "synthetic-system-item", title: "Synthetic completed build" }] };
  const response = await workInventoryResponse(new Request("https://app.doctorcre.com/api/v1/work-inventory?system=true&live_library=true"), {}, { actor: { slug: "joe" } }, {
    workInventoryReader: async (_env, _actor, _correlation, args) => { consumed = args; return inventory; },
  });
  assert.equal(response.status, 200, "the pin must admit the query already used by the Live Library");
  assert.equal(consumed.system, "true");
  assert.equal(consumed.live_library, "true");
  assert.deepEqual(await response.json(), inventory, "the admitted query must return the inherited inventory to the app");
});

// The switch read and both write gates must exist at the advertised runtime,
// not only at the feature's provenance revision.
test("the advertised runtime producer serves the feature-switch read and gates both suggestion writes", {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && "Set CARR_PRODUCER_CHECKOUT to verify runtime feature switches",
}, async () => {
  const seam = contract.mcp_read_contracts["list-feature-switches"];
  assert.equal(seam.producer.source_commit, contract.producer.source_commit, "the read's provenance is the advertised runtime");
  const registry = execFileSync("git", ["-C", process.env.CARR_PRODUCER_CHECKOUT,
    "show", `${contract.producer.source_commit}:${seam.producer.module.replace(/feature-switches\.js$/, "tools.js")}`], { encoding: "utf8" });
  assert.ok(/registerTools\(featureSwitchTools\(/.test(registry), "the runtime must register the feature-switch tools");
  assert.ok(/if \(FEATURE_VERBS\[name\]\) await requireFeature\(client, actor, FEATURE_VERBS\[name\]\);/.test(registry),
    "the runtime must check the switch on every gated verb before its handler");

  const { featureSwitchTools, FEATURE_VERBS, requireFeature } = await import(await producerModuleUrl(seam.producer.module));
  const { featureEnabled, featureSwitchRefusal } = await import("../js/feature-switches.js");
  const gate = seam.first_consumer;
  for (const verb of gate.worker_gated_verbs) {
    assert.equal(FEATURE_VERBS[verb], gate.name, `${verb} must be gated by ${gate.name}`);
    assert.ok(contract.mcp_operations.includes(verb));
  }

  const tool = featureSwitchTools({ withEnvelope() { assert.fail("reads must not write"); },
    writeEvent() { assert.fail("reads must not audit"); }, executeRegisteredTool() { assert.fail("reads must not delegate"); } })["list-feature-switches"];
  assert.notEqual(tool.write, true);
  assert.deepEqual(tool.inputSchema, seam.inputSchema);
  const row = enabled => ({ id: "10000000-0000-4000-8000-000000000001", name: gate.name, description: "Synthetic switch",
    default_enabled: gate.seed_default, enabled, audience: "team", owner: "joe", created_at: "2026-10-01T12:00:00Z",
    expected_removal_on: "2026-12-31", retired_at: null, version: 2, retirement_loop_id: null });
  const reader = enabled => ({ async query(sql) {
    assert.match(sql.trim(), /^select /, "the read must only read");
    return { rows: sql.includes("from feature_switch") ? [row(enabled)] : [] };
  } });
  const actor = { id: "synthetic-actor", slug: "joe", human: true };
  for (const enabled of [true, false]) {
    const read = await tool.handler(reader(enabled), actor, {});
    for (const key of seam.response.required_keys) assert.ok(key in read, `response key ${key}`);
    assert.equal(read.schema, seam.response.schema);
    for (const key of seam.response.switch_keys) assert.ok(key in read.switches[0], `switch key ${key}`);
    assert.equal(featureEnabled(read, gate.name), enabled, "the app consumes CARR's own evaluation");
    const refusal = await requireFeature(reader(enabled), actor, gate.name).then(() => null, error => error);
    assert.equal(refusal === null, enabled);
    if (!enabled) assert.equal(featureSwitchRefusal(refusal), true, "the app recognises the runtime's refusal as a settled non-write");
  }
});

test("runtime error capture is pinned to its own exact producer revision", async () => {
  const runtimeErrors = JSON.parse(await readFile(new URL(`../${contract.runtime_errors.contract}`, import.meta.url), "utf8"));
  assert.deepEqual(contract.runtime_errors.producer, { repository: "jbookout/carr-system", source_commit: "a3a6913f7af0d721ab538090b1347976befcf421" });
  assert.ok(contract.http_surfaces.includes(runtimeErrors.browser_endpoint));
});

test("runtime error wire contract and scrub rules match the exact pinned producer", {
  skip: !process.env.CARR_PRODUCER_CHECKOUT && "Set CARR_PRODUCER_CHECKOUT to verify runtime error ingress",
}, async () => {
  const pin = contract.runtime_errors.producer.source_commit;
  const show = path => execFileSync("git", ["-C", process.env.CARR_PRODUCER_CHECKOUT, "show", `${pin}:${path}`], { encoding: "utf8" });
  const producerContract = JSON.parse(show("mcp-server/src/runtime-errors.v1.json"));
  assert.deepEqual(JSON.parse(await readFile(new URL(`../${contract.runtime_errors.contract}`, import.meta.url), "utf8")), producerContract);
  const source = show("mcp-server/src/runtime-errors.js").replace("import contract from './runtime-errors.v1.json' with { type: 'json' };",
    `const contract = ${JSON.stringify(producerContract)};`);
  const producer = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const { scrubError } = await import("../js/error-tracking.js");
  for (const input of [
    { type: "TypeError", message: "Cannot read properties of Alice", stack: "TypeError: Alice\n at f (https://app/js/a.js?email=a@example.test:12:3)", route: "/clients/Alice?x=1", release_sha: "a".repeat(40) },
    { type: "HTTP5xx", message: "Alice", route: "/deals/1/leads", release_sha: "nope" },
    { type: "Alice", message: "aliceRecord is not defined", stack: "f@https://app/js/a.js:1:2", route: "no-slash" },
    {},
  ]) assert.deepEqual(scrubError(input), producer.scrubError(input));
});
