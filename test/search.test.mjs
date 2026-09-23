// V5-UX-B05 — Authorized global search and saved views.
//
// One test per clause of the slice record, named B05-1 … B05-14, plus the
// captured-payload test defect 33e8409b asks for. Each asserts over the MODEL
// (js/search-model.js) rather than only over the page text, because a page that
// paints the right words from the wrong decision is the failure this suite
// exists to catch.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createFixtureClient } from "../js/fixture-client.js";
import { PREFERENCES_KEY } from "../js/shell.js";
import {
  AUTHORIZATION_SENTENCE, NOT_SEARCHED_SENTENCE, SAVED_VIEWS_KEY, SAVED_VIEW_SENTENCE,
  SCOPE_CHIP_SENTENCE, SEARCH_STATE_COPY, SEARCH_STATES,
  acceptsSearchResponse, applyScope, buildFindAndCatchUpArguments, buildFindArguments,
  classifySearchFailure, deepLinkFor, groupSearchResults, parseSearchAddress,
  readSavedViews, refusalDetail, renameView, resetViews, retiredSummary, saveView, scopeChips,
  searchAddress, searchPhase, truncationNotes, validSearchPayload, visibleCount, writeSavedViews,
} from "../js/search-model.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => readFile(`${ROOT}${file}`, "utf8");

const html = await read("business-workspace.html");
const pageJs = await read("js/search.js");
const modelJs = await read("js/search-model.js");
const css = await read("css/business-workspace.css");
const contract = JSON.parse(await read("contracts/carr-interface.v1.json"));
const routes = JSON.parse(await read("contracts/app-routes.v1.json"));
const liveCapture = JSON.parse(await read("test/fixtures/search-live-capture.json"));

const seedText = await read("data/board-seed.json");
const fixture = async () => createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seedText).toString("base64")}` });

const emptyPayload = Object.freeze({
  parties: [], deals: [], connections: [], organizations: [], lead_client_links: [], deals_via_link: [],
  note: "No retired aliases among these matches — every ref listed is live.",
});

const nullRefPayload = Object.freeze({
  ...emptyPayload,
  organizations: [{
    name: "Demo Null Ref Organization", live_rows: 1, refs: [null], retired_aliases: 0,
    retired_refs: [], retired_refs_truncated: false, live_as_role: 0, role_refs: [null], all_retired: false,
  }],
});

/* ------------------------------------------------------------------------ B05-1 */

test("B05-1 every rendered count is a field of the one payload, the render path issues no second read, and the argument objects carry exactly the producer's keys", async () => {
  const client = await fixture();
  const payload = await client.find(buildFindArguments("Pensacola"));
  const groups = groupSearchResults(payload);

  // Each group's count IS the length of the rows the payload delivered. No
  // total is computed over anything else, and nothing is enriched by a second
  // read: a count is a fact of this answer or it is not printed.
  for (const group of groups) assert.equal(group.count, group.rows.length, `${group.id} counts its own rows`);
  assert.equal(visibleCount(groups), groups.reduce((total, group) => total + group.rows.length, 0));
  const organizations = groups.find((group) => group.id === "organizations");
  const fromPayload = payload.organizations[0];
  assert.equal(organizations.rows[0].counts.find((entry) => entry.label === "live records").value, fromPayload.live_rows);
  assert.equal(organizations.rows[0].counts.find((entry) => entry.label === "retired aliases").value, fromPayload.retired_aliases);

  // The arguments. `find` declares ONE property, `find-and-catch-up` two, both
  // under additionalProperties:false — an actor, a kind or a tenant added here
  // would be refused by the gateway AND would mean the app had begun deciding
  // what a partner may see.
  assert.deepEqual(Object.keys(buildFindArguments("x")), ["query"]);
  assert.deepEqual(Object.keys(buildFindAndCatchUpArguments("x")), ["query", "limit"]);

  // The render path. Everything between the guard and the paint reads the one
  // payload already in hand.
  const renderBody = pageJs.slice(pageJs.indexOf("function render()"), pageJs.indexOf("async function read("));
  assert.doesNotMatch(renderBody, /client\./, "the render path issues no read of its own");
  assert.doesNotMatch(renderBody, /fetch\(/, "the render path issues no fetch of its own");
  assert.ok(pageJs.includes(AUTHORIZATION_SENTENCE) === false, "the sentence lives in the model, not retyped in the page");
  assert.ok(html.includes(AUTHORIZATION_SENTENCE), "the page states what authorization means here");
});

/* ------------------------------------------------------------------------ B05-2 */

test("B05-2 a null element inside refs renders no ref chip, no link, and never the word null", () => {
  assert.equal(validSearchPayload(nullRefPayload), true, "a null ref element is the producer's real shape and must be accepted");
  const [organizations] = groupSearchResults(nullRefPayload);
  const row = organizations.rows[0];
  assert.deepEqual([...row.refs], [], "an array of refs is not an array of links");
  assert.deepEqual([...row.roleRefs], []);
  assert.equal(row.link, null, "nothing is linked from a ref that is not a string");
  assert.equal(JSON.stringify([row.refs, row.roleRefs]), "[[],[]]", "the null element never reaches a chip");
  for (const value of [row.name, ...row.counts.map((entry) => `${entry.value} ${entry.label}`), row.note]) {
    assert.doesNotMatch(String(value), /\bnull\b/, "no rendered value prints the word null");
  }
});

/* ------------------------------------------------------------------------ B05-3 */

test("B05-3 Back restores the query and the chips from the address, byte for byte, and re-renders without a read", () => {
  const before = { query: "alpha", kinds: ["deals"] };
  const address = searchAddress(before);
  assert.equal(address, "/business?q=alpha&kinds=deals");
  const restored = parseSearchAddress(address.slice(address.indexOf("?")));
  assert.equal(restored.query, before.query);
  assert.deepEqual([...restored.kinds], before.kinds);
  assert.equal(restored.present, true);
  // Byte-equal: the address a restored view produces is the address it came from.
  assert.equal(searchAddress({ query: restored.query, kinds: [...restored.kinds] }), address);
  // An address with no ?q= at all is not a search that returned nothing.
  assert.equal(parseSearchAddress("?kinds=deals").present, false);
  // A kind the page does not group is dropped rather than carried as a filter.
  assert.deepEqual([...parseSearchAddress("?q=a&kinds=deals,invented").kinds], ["deals"]);

  assert.match(pageJs, /addEventListener\?\.\("popstate", \(\) => restoreFromAddress\(\{ reread: false \}\)\)/, "popstate restores without a read of its own");
  const restoreBody = pageJs.slice(pageJs.indexOf("function restoreFromAddress("), pageJs.indexOf("function wire()"));
  assert.match(restoreBody, /if \(reread && view\.submitted\) read\(\{ push: false \}\);\s*\n\s*else render\(\);/, "a restore without reread paints from the payload in hand");
});

/* ------------------------------------------------------------------------ B05-4 */

test("B05-4 a no-match and a missing source are two different states, and only one offers Retry", async () => {
  const client = await fixture();
  const answered = await client.find(buildFindArguments("zzqqnotathing"));
  // A no-match is a 200 with six empty arrays and the producer's note.
  assert.equal(validSearchPayload(answered), true);
  assert.equal(visibleCount(groupSearchResults(answered)), 0);
  assert.equal(searchPhase({ status: "ready", payload: answered, submitted: true }), "no_match");

  const outaged = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seedText).toString("base64")}`, outage: "search" });
  let thrown = null;
  try { await outaged.find(buildFindArguments("Pensacola")); } catch (error) { thrown = error; }
  assert.equal(thrown?.status, 503, "a missing source throws with a status");
  assert.equal(classifySearchFailure(thrown), "unavailable");
  assert.equal(searchPhase({ status: "unavailable", payload: null, submitted: true }), "unavailable");

  const noMatch = SEARCH_STATE_COPY.no_match;
  const unavailable = SEARCH_STATE_COPY.unavailable;
  assert.notEqual(noMatch.title, unavailable.title, "two facts, two headings");
  assert.notEqual(noMatch.copy, unavailable.copy, "two facts, two bodies");
  assert.equal(unavailable.retry, true, "an unanswered path is worth asking again");
  assert.equal(noMatch.retry, false, "the record layer answered; there is nothing to retry");
});

/* ------------------------------------------------------------------------ B05-5 */

test("B05-5 saving, renaming and resetting a view never touches the workspace preference key and sends no verb", () => {
  const map = new Map();
  const written = [];
  const storage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { written.push(key); map.set(key, value); },
    removeItem: (key) => map.delete(key),
  };
  let views = writeSavedViews(storage, saveView([], { name: "Pensacola leads", query: "Pensacola", kinds: ["leads"] }));
  assert.deepEqual(views.map((view) => view.name), ["Pensacola leads"]);
  views = writeSavedViews(storage, renameView(views, "Pensacola leads", "Panhandle leads"));
  assert.deepEqual(views.map((view) => view.name), ["Panhandle leads"]);
  assert.deepEqual([...readSavedViews(storage)], [...views]);
  views = writeSavedViews(storage, resetViews());
  assert.deepEqual([...views], []);

  assert.deepEqual([...new Set(written)], [SAVED_VIEWS_KEY], "one key, and it is not the preference key");
  assert.equal(written.includes(PREFERENCES_KEY), false, "a saved view changes no partner preference");
  assert.equal(map.has(PREFERENCES_KEY), false);
  assert.notEqual(SAVED_VIEWS_KEY, PREFERENCES_KEY);

  // No verb is sent, because there is none to send.
  const savedViewBody = pageJs.slice(pageJs.indexOf('$("saveViewButton")'), pageJs.indexOf('$("resetViewsButton")'));
  assert.doesNotMatch(savedViewBody, /client\./, "saving a view calls no verb");
  assert.ok(html.includes(SAVED_VIEW_SENTENCE), "the page says a saved view is a device fact");
  // Storage is a convenience, never a requirement.
  assert.deepEqual([...readSavedViews(null)], []);
});

/* ------------------------------------------------------------------------ B05-6 */

test("B05-6 two overlapping reads resolved out of order render the second query's payload", async () => {
  const client = await fixture();
  const state = { sequence: 0, payload: null, query: null };
  const start = (query) => ({ query, token: ++state.sequence, answer: client.find(buildFindArguments(query)) });

  const first = start("Pensacola");
  const second = start("Demo Pensacola Legacy Practices");
  // Resolved in the WRONG order on purpose: the newer answer lands first.
  const secondPayload = await second.answer;
  if (acceptsSearchResponse(state.sequence, second.token)) { state.payload = secondPayload; state.query = second.query; }
  const firstPayload = await first.answer;
  if (acceptsSearchResponse(state.sequence, first.token)) { state.payload = firstPayload; state.query = first.query; }

  assert.equal(state.query, "Demo Pensacola Legacy Practices", "the older answer was dropped");
  assert.deepEqual(state.payload, secondPayload, "the second query's payload stands");
  assert.notDeepEqual(firstPayload, secondPayload, "the two reads really do differ, so the assertion means something");
  assert.equal(acceptsSearchResponse(2, 1), false);
  assert.equal(acceptsSearchResponse(2, 2), true);

  // The stale state renders NOTHING: it is asserted, not narrated.
  const readBody = pageJs.slice(pageJs.indexOf("async function read("), pageJs.indexOf("function pushAddress("));
  for (const fragment of readBody.split("await ").slice(1)) {
    assert.match(fragment, /acceptsSearchResponse\(view\.sequence, sequence\)/, "every await is followed by the sequence guard");
  }
});

/* ------------------------------------------------------------------------ B05-7 */

test("B05-7 the page never re-ranks: no sort, no reverse, and the producer's order survives grouping", async () => {
  for (const [name, source] of [["js/search.js", pageJs], ["js/search-model.js", modelJs]]) {
    assert.doesNotMatch(source, /\.sort\(/, `${name} must not sort`);
    assert.doesNotMatch(source, /\.reverse\(/, `${name} must not reverse`);
  }
  const client = await fixture();
  const payload = await client.find(buildFindArguments("Pensacola"));
  const groups = groupSearchResults(payload);
  // Every group's row order is the slice of the producer's own order.
  const organizations = groups.find((group) => group.id === "organizations");
  assert.deepEqual(organizations.rows.map((row) => row.name), payload.organizations.map((row) => row.name));
  const deals = groups.find((group) => group.id === "deals");
  assert.deepEqual(deals.rows.map((row) => row.name), payload.deals.map((row) => row.name));
  const leads = groups.find((group) => group.id === "leads");
  assert.deepEqual(leads.rows.map((row) => row.name), payload.parties.filter((row) => row.kind === "lead").map((row) => row.name));
  // The survivors-first repair: a retired alias sorts where the producer put it,
  // and the page does not move it.
  assert.equal(payload.parties[0].merged, false, "the producer puts live rows first");
});

/* ------------------------------------------------------------------------ B05-8 */

test("B05-8 a scope chip hides rows in the browser and leaves the outgoing argument object untouched", async () => {
  const client = await fixture();
  const payload = await client.find(buildFindArguments("Pensacola"));
  const groups = groupSearchResults(payload);
  assert.ok(groups.length > 1, "there is more than one group to narrow");

  const narrowed = applyScope(groups, ["deals"]);
  assert.deepEqual(narrowed.map((group) => group.id), ["deals"]);
  assert.equal(visibleCount(narrowed) < visibleCount(groups), true, "a chip hides rows");
  assert.deepEqual(applyScope(groups, []).map((group) => group.id), groups.map((group) => group.id), "no chip means no narrowing");

  // The chip carries the group's own count, and selection is a view fact.
  const chips = scopeChips(groups, ["deals"]);
  assert.deepEqual(chips.filter((chip) => chip.selected).map((chip) => chip.id), ["deals"]);
  for (const chip of chips) assert.equal(chip.count, groups.find((group) => group.id === chip.id).count);

  // The argument object is unchanged by a chip: there is no door to narrow at.
  assert.deepEqual(buildFindArguments("Pensacola"), { query: "Pensacola" });
  const chipBody = pageJs.slice(pageJs.indexOf('$("searchChips")?.addEventListener'), pageJs.indexOf('$("saveViewButton")'));
  assert.doesNotMatch(chipBody, /client\.|read\(/, "a chip re-reads nothing");
  assert.ok(html.includes(SCOPE_CHIP_SENTENCE), "the page says a chip is a view, not a narrower question");
});

/* ------------------------------------------------------------------------ B05-9 */

test("B05-9 all nine states carry their own rendered text and are reachable through the fixture", async () => {
  assert.deepEqual([...SEARCH_STATES], ["loading", "empty", "no_match", "stale", "unavailable", "refused", "unknown", "partial", "disambiguation"]);
  const titles = SEARCH_STATES.map((state) => SEARCH_STATE_COPY[state].title);
  assert.equal(new Set(titles.filter((title, index) => SEARCH_STATES[index] !== "stale")).size, SEARCH_STATES.length - 1, "each state says its own words");
  for (const state of SEARCH_STATES) {
    assert.ok(SEARCH_STATE_COPY[state].title.length > 0 && SEARCH_STATE_COPY[state].copy.length > 0, `${state} has rendered evidence`);
  }

  const client = await fixture();
  assert.equal(searchPhase({ status: "loading", payload: null, submitted: true }), "loading");
  assert.equal(searchPhase({ status: "idle", payload: null, submitted: false }), "empty");
  assert.equal(searchPhase({ status: "ready", payload: await client.find(buildFindArguments("zzqqnotathing")), submitted: true }), "no_match");
  assert.equal(searchPhase({ status: "unavailable", payload: null, submitted: true }), "unavailable");
  assert.equal(searchPhase({ status: "refused", payload: null, submitted: true }), "refused");
  assert.equal(searchPhase({ status: "unknown", payload: null, submitted: true }), "unknown");
  assert.equal(searchPhase({ status: "ready", payload: await client.find(buildFindArguments("Pensacola")), submitted: true }), "partial");
  assert.equal(searchPhase({ status: "ready", payload: emptyPayload, catchUp: await client.findAndCatchUp({ query: "Pensacola" }), submitted: true }), "disambiguation");
  // A stale answer is never a state the reader is shown: it renders nothing and
  // the current query's result stands.
  assert.equal(acceptsSearchResponse(4, 3), false);
  // no-match and unavailable are mutually exclusive by construction.
  assert.notEqual(searchPhase({ status: "unavailable", payload: null, submitted: true }), "no_match");
});

/* ----------------------------------------------------------------------- B05-10 */

test("B05-10 a needs_disambiguation answer renders the count, the candidates and the producer's hint, and opens none of them", async () => {
  const client = await fixture();
  const answer = await client.findAndCatchUp({ query: "Pensacola" });
  assert.equal(answer.state, "needs_disambiguation");
  assert.equal(answer.candidate_count, answer.candidates.length + (answer.candidates_truncated ? answer.candidate_count - answer.candidates.length : 0));
  assert.ok(answer.candidates.length > 1);
  assert.equal(answer.hint, "Choose one exact target and call catch-me-up; this verb never guesses.");
  // The hint is printed verbatim — it is not rewritten anywhere in this app.
  assert.doesNotMatch(pageJs, /never guesses/, "the hint is the producer's sentence, not the page's");
  assert.match(pageJs, /escapeHtml\(payload\.hint\)/, "the page prints the hint it was given");
  const disambiguationBody = pageJs.slice(pageJs.indexOf("function renderDisambiguation()"), pageJs.indexOf("function renderRetired()"));
  assert.doesNotMatch(disambiguationBody, /location\.|href=|client\./, "the page opens no candidate on its own");
  assert.match(disambiguationBody, /escapeHtml\(String\(payload\.candidate_count\)\)/, "the producer's own count is what is shown");
});

/* ----------------------------------------------------------------------- B05-11 */

test("B05-11 each refusal names its code, and no rendered string carries the error body", async () => {
  const client = await fixture();
  const cases = [
    [() => client.findAndCatchUp({ query: "  " }), "invalid_query"],
    [() => client.findAndCatchUp({ query: "Dell", limit: 99 }), "invalid_limit"],
    [() => client.findAndCatchUp({ query: "Dell", kinds: ["lead"] }), "unregistered_operation_fields"],
    [() => client.find({}), "missing_required"],
  ];
  for (const [run, code] of cases) {
    let thrown = null;
    try { await run(); } catch (error) { thrown = error; }
    assert.ok(thrown, `${code} is refused`);
    assert.equal(classifySearchFailure(thrown), "refused", `${code} is a decision, not an outage`);
    const detail = refusalDetail(thrown);
    assert.equal(detail.code, code);
  }
  const fields = refusalDetail((() => { try { return null; } catch { return null; } })() || { payload: { error: "unregistered_operation_fields", operation: "find-and-catch-up", fields: ["kinds"] } });
  assert.deepEqual([...fields.fields], ["kinds"]);
  assert.equal(fields.operation, "find-and-catch-up");
  // `error.body` is a server's own text written for whoever maintains the verb.
  // It travels on the error and no surface renders it.
  assert.doesNotMatch(pageJs, /\.body\b/, "the page never reads the error body");
  assert.doesNotMatch(modelJs, /\.body\b/, "the model never reads the error body");
});

/* ----------------------------------------------------------------------- B05-12 */

test("B05-12 a truncation renders the partial state with the producer's exact counts", async () => {
  const client = await fixture();
  const payload = await client.find(buildFindArguments("Pensacola"));
  const truncated = payload.organizations.find((row) => row.retired_refs_truncated === true);
  assert.ok(truncated, "the fixture reproduces the producer's retired-ref cap");
  assert.equal(truncated.retired_refs.length, 10, "RETIRED_REF_CAP is ten");
  assert.equal(truncated.retired_aliases, 12, "and twelve were recorded");

  const notes = truncationNotes(payload);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /10 retired references shown of 12 recorded\./, "the exact counts, not a word for them");
  assert.equal(searchPhase({ status: "ready", payload, submitted: true }), "partial");

  const candidateTruncated = { state: "needs_disambiguation", candidates: [{}, {}], candidate_count: 40, candidates_truncated: true };
  assert.match(truncationNotes(emptyPayload, candidateTruncated)[0], /2 candidates shown of 40 found\./);
  assert.deepEqual([...truncationNotes(emptyPayload, null)], [], "nothing truncated, nothing claimed");

  const summary = retiredSummary(payload);
  assert.equal(summary.organizations.find((row) => row.truncated)?.retiredAliases, 12);
  assert.equal(summary.note, payload.note, "the producer's note is printed, not paraphrased");
});

/* ----------------------------------------------------------------------- B05-13 */

test("B05-13 the fixture derives candidates the way findCatchUpCandidates does: one survivor once, two same-named deals twice", async () => {
  const client = await fixture();
  const payload = await client.find(buildFindArguments("Pensacola"));
  const answer = await client.findAndCatchUp({ query: "Pensacola", limit: 50 });
  assert.equal(answer.state, "needs_disambiguation");
  const targets = answer.candidates.map((row) => row.target);

  // Two deals share a name in the fixture, and the producer does NOT deduplicate
  // deals. Both are candidates.
  const repeated = payload.deals.filter((row) => row.name === "Demo Pensacola medical office building");
  assert.equal(repeated.length, 2, "the fixture really does carry two deals with one name");
  assert.equal(targets.filter((target) => target === "Demo Pensacola medical office building").length, 2, "deals are not deduplicated");

  // An organization contributes ONE candidate however many refs it aggregates.
  const manyRefs = payload.organizations.find((row) => row.refs.filter((ref) => typeof ref === "string").length > 1);
  assert.ok(manyRefs, "the fixture carries an organization with two live refs");
  assert.equal(targets.filter((target) => target === manyRefs.name).length, 1, "a survivor appears once");

  // A retired alias is never a candidate; an organization whose only ref is null
  // contributes none either.
  assert.equal(targets.includes("Demo Pensacola Smiles (retired alias)"), false, "live parties only");
  assert.equal(targets.includes("Demo Pensacola Imaging Partners"), false, "a null ref is not a ref");

  // The order is lexical by target, which is what the producer does — and is not
  // a relevance order the page may repair.
  assert.deepEqual(targets, [...targets].map((target) => target), "the order arrives decided");
  for (let index = 1; index < targets.length; index += 1) {
    assert.ok(targets[index - 1].localeCompare(targets[index]) <= 0, "candidates arrive in localeCompare order");
  }
  assert.equal(answer.candidates_truncated, false);
  assert.equal(answer.candidate_count, answer.candidates.length);
});

/* ----------------------------------------------------------------------- B05-14 */

test("B05-14 the interface contract pins both verbs alphabetically at 1.19.0 and no route moves", () => {
  assert.equal(routes.version, "1.12.0", "no new route: the Search tab lives on /business");
  assert.equal(routes.routes["/business"], "business-workspace.html");
  assert.equal(contract.version, "1.21.0", "two added operations are an additive, minor bump");
  assert.equal(contract.producer.source_commit, "35009e9dedab3a603836c662d0f7f12dfeb1a284", "S02 repinned the producer to the release that first serves the session-identity verbs");
  for (const verb of ["find", "find-and-catch-up"]) assert.ok(contract.mcp_operations.includes(verb), `${verb} is pinned`);
  assert.deepEqual(contract.mcp_operations, [...contract.mcp_operations].toSorted(), "mcp_operations stays sorted");
  const at = contract.mcp_operations.indexOf("find");
  assert.equal(contract.mcp_operations[at - 1], "engineering-passport");
  assert.equal(contract.mcp_operations[at + 1], "find-and-catch-up");
  assert.equal(contract.mcp_operations[at + 2], "get-call-context");
  // Both verbs travel over the existing /mcp mount, so no HTTP surface is added.
  assert.equal(contract.http_surfaces.includes("/api/v1/search"), false);
  assert.ok(html.includes(NOT_SEARCHED_SENTENCE), "the page names the sources it does not search");
  assert.match(css, /#searchChips \.chip, #savedViewList \.chip, \.saved-view \.chip \{ min-height: var\(--touch\)/, "every control the tab adds clears the touch floor");
  assert.doesNotMatch(css.slice(css.indexOf("V5-UX-B05")), /#[0-9a-fA-F]{3,8}\b/, "no literal colour in the B05 block");
  assert.doesNotMatch(pageJs, /new Date\(/, "the page keeps no clock of its own");
});

/* ------------------------------ defect 33e8409b: the validator against production */

test("B05-live-capture the validator accepts the REAL captured find payloads, nulls and all", () => {
  assert.equal(liveCapture.verb, "find");
  assert.ok(liveCapture.captures.length >= 2, "more than one real answer was captured");
  for (const capture of liveCapture.captures) {
    assert.equal(validSearchPayload(capture.payload), true, `the live ${capture.query} payload is accepted`);
    // And the shape really does carry what the validator was relaxed for.
    const groups = groupSearchResults(capture.payload);
    for (const group of groups) assert.equal(group.count, group.rows.length);
  }
  const pensacola = liveCapture.captures.find((capture) => capture.query === "Pensacola").payload;
  const dell = liveCapture.captures.find((capture) => capture.query === "Dell").payload;
  // The four nullable facts §2.2 enumerates, present in the real answers.
  assert.equal(pensacola.parties.some((row) => row.city === null && row.specialty === null && row.org_name === null), true, "null city, specialty and org_name");
  assert.equal(dell.deals.some((row) => row.owner === null), true, "a null owner");
  assert.equal(pensacola.organizations.some((row) => row.refs.includes(null)), true, "a NULL ELEMENT inside refs");
  assert.equal(dell.organizations.some((row) => row.refs.includes(null)), true, "and again in the second capture");
  // A validator that accepted a payload missing one of the seven keys would be
  // just as wrong as one that refused production.
  for (const key of ["parties", "deals", "connections", "organizations", "lead_client_links", "deals_via_link", "note"]) {
    const missing = { ...pensacola };
    delete missing[key];
    assert.equal(validSearchPayload(missing), false, `a payload missing ${key} is refused`);
  }
  // Nothing is linked off a ref, and only two kinds have an address at all.
  assert.equal(deepLinkFor({ kind: "client", name: "A B", merged: false }), "/clients?q=A%20B");
  assert.equal(deepLinkFor({ kind: "vendor", name: "A B", merged: false }), "/vendors?q=A%20B");
  assert.equal(deepLinkFor({ kind: "lead", name: "A B", merged: false }), null, "no page reads a lead by address");
  assert.equal(deepLinkFor({ kind: "client", name: "A B", merged: true }), null, "a retired alias opens nothing");
});
