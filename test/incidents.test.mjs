// V5-UX-C14 — the incident page, one test per checkable-done clause.
//
// The payloads below are the record layer's own shapes: `get-incident` returns
// the row plus FOUR separate lists, and facts are kept apart from hypotheses
// because they are different kinds of claim. A test written against a merged
// list would pass here and let the page turn a guess into a finding.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  HYPOTHESIS_EYEBROW, REFUSAL_SENTENCE, REF_REFUSAL, WORK_REQUEST_REFUSAL, factRows, hypothesisRows,
  incidentHeader, linkArgs, linkOperationKey, linkRows, occurrenceRows, refFromSearch,
  validIncidentDetailPayload, whoCanClearLine,
} from "../js/incidents-model.js";
import { canonicalHref } from "../js/control-room-model.js";
import { createFixtureClient } from "../js/fixture-client.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const html = await read("incidents.html");
const css = await read("css/incidents.css");
const pageJs = await read("js/incidents.js");
const routes = JSON.parse(await read("contracts/app-routes.v1.json"));
const contract = JSON.parse(await read("contracts/carr-interface.v1.json"));

const fixture = async (options = {}) => {
  const seed = await read("data/board-seed.json");
  return createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seed).toString("base64")}`, ...options });
};

const REF = "INC-20260915-01";

/* ------------------------------------------------------------- the reference */

test("the reference comes from the query string, and both failures are named", () => {
  assert.deepEqual(refFromSearch(`?ref=${REF}`), { state: "ok", ref: REF, given: REF });
  assert.equal(refFromSearch("").state, "missing");
  assert.equal(refFromSearch("?ref=").state, "missing");
  assert.equal(refFromSearch("?ref=INC-2026-01").state, "malformed");
  assert.equal(refFromSearch("?ref=WR-000901").state, "malformed");
  assert.equal(refFromSearch("?ref=INC-20260915-1").state, "malformed");
  assert.equal(refFromSearch("?ref=inc-20260915-01").state, "malformed");
  assert.equal(REF_REFUSAL, "This page needs an incident reference like INC-20260915-01.");
  assert.ok(html.includes(REF_REFUSAL), "the page does not carry the refusal sentence");
});

test("a bare page still offers the open list, and the Control Room links into it", async () => {
  const client = await fixture();
  const board = await client.incidentBoard({ state: "open" });
  assert.ok(board.count >= 3);
  for (const row of board.incidents) {
    assert.equal(canonicalHref(row), `/incidents?ref=${row.ref}`);
  }
  assert.match(pageJs, /incidentBoard\(\{ state: "open" \}\)/, "the bare page takes no list read");
});

/* ------------------------------------------------------------------ the detail */

test("the fixture detail keeps facts, hypotheses, occurrences and links apart", async () => {
  const client = await fixture();
  const detail = await client.getIncident({ ref: REF, fact_limit: 50 });
  assert.equal(validIncidentDetailPayload(detail), true);
  assert.equal(detail.incident.ref, REF);
  assert.ok(detail.facts.length >= 1, "no fact");
  assert.ok(detail.hypotheses.length >= 1, "no hypothesis");
  assert.ok(detail.occurrences.length >= 1, "no occurrence");
  const factText = detail.facts.map((fact) => fact.statement);
  for (const hypothesis of detail.hypotheses) {
    assert.equal(factText.includes(hypothesis.statement), false, "a hypothesis is also a fact");
  }
  for (const row of ["INC-20260915-01", "INC-20260916-02", "INC-20260916-03"]) {
    const each = await client.getIncident({ ref: row });
    assert.equal(each.incident.ref, row);
    assert.ok(Array.isArray(each.links));
  }
  await assert.rejects(() => client.getIncident({ ref: "INC-20991231-99" }), (error) => {
    assert.equal(error.payload.error, "incident_not_found");
    return true;
  });
});

test("every fact carries its own source and an AM/PM clock, never a borrowed one", () => {
  const rows = factRows([
    { statement: "The writer exited", source: "export log", observed_at: "2026-09-13T16:10:00.000Z" },
    { statement: "No generation row exists", source: null, observed_at: "not a time" },
    { statement: "", source: "ignored", observed_at: "2026-09-13T04:10:00.000Z" },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, "export log");
  assert.equal(rows[0].clock, "4:10 PM");
  assert.equal(rows[1].source, "no source recorded");
  assert.equal(rows[1].clock, "unknown");
});

test("hypotheses, occurrences and links state what the ledger recorded and nothing more", () => {
  const hypotheses = hypothesisRows([
    { statement: "The lease was lost", status: "under investigation", recorded_at: "2026-09-13T06:15:00.000Z" },
    { statement: "An index is missing" },
  ]);
  assert.equal(hypotheses[0].clock, "6:15 AM");
  assert.equal(hypotheses[1].status, "not assessed");
  assert.equal(occurrenceRows([{ observed_at: "2026-09-16T13:11:00.000Z" }])[0].note, "no note recorded");
  const links = linkRows([{ kind: "work_request", ref: "WR-000901" }, { kind: "run", ref: "RUN-demo-0042" }, { ref: "" }]);
  assert.equal(links.length, 2);
  assert.equal(links[0].href, "/system-work.html");
  assert.equal(links[0].label, "WR-000901");
  assert.equal(links[1].href, null, "a run has no page in this application");
});

test("the header says unknown where the row said nothing, and never zero", () => {
  const header = incidentHeader({ ref: REF, title: "Demo export stopped", severity: "SEV-1", state: "investigating", age_days: 1, occurrences: 6 });
  assert.equal(header.age, "1 day old");
  assert.equal(header.occurrences, "seen 6 times");
  assert.equal(header.owner, "unknown");
  assert.equal(header.environment, "unknown");
  const bare = incidentHeader({ ref: REF, title: "Demo", severity: "SEV-2", state: "open" });
  assert.equal(bare.age, "unknown");
  assert.equal(bare.occurrences, "seen unknown times");
});

/* -------------------------------------------------------- who can clear this */

test("who can clear this is built from the row, and the page offers no partner act", () => {
  assert.equal(
    whoCanClearLine({ ready_to_close: true, blocked_by: "ignored" }),
    "Ready to close: a partner closes it in their own session with the root cause.",
  );
  assert.equal(
    whoCanClearLine({ ready_to_close: false, blocked_by: "no recovery evidence", next_action: "ignored" }),
    "Blocked by: no recovery evidence",
  );
  assert.equal(whoCanClearLine({ ready_to_close: false, next_action: "Read the log" }), "Next: Read the log");
  assert.equal(
    whoCanClearLine({ ready_to_close: false }),
    "The ledger recorded no next step and no blocker for this incident.",
  );
  for (const verb of ["adjudicate-incident", "close-incident", "open-incident", "adjudicateIncident", "closeIncident"]) {
    assert.equal(html.includes(verb), false, `${verb} appears on the page`);
    assert.equal(pageJs.includes(verb), false, `${verb} appears in the page script`);
  }
});

/* ------------------------------------------------------------------ the write */

test("the one write goes through the command kernel with one operation key", () => {
  assert.match(pageJs, /import \{ createCommandState, performCommand \} from "\.\/command-feedback\.mjs"/);
  assert.match(pageJs, /await performCommand\(\{/);
  assert.match(pageJs, /newKey: uuidv4/);
  assert.match(pageJs, /client\.linkIncidentWorkRequest\(request\)/);
  assert.match(pageJs, /createCommandDock\(\{/, "the dock is not mounted");
  assert.equal(/idempotency_key/.test(pageJs), false, "the page mints its own key instead of the kernel's");
  assert.equal(linkOperationKey(REF, "WR-000901"), "incident:INC-20260915-01:link:WR-000901");
  const built = linkArgs(REF, " wr-000901 ");
  assert.deepEqual(built.args, { incident_ref: REF, work_request: "WR-000901" });
  assert.equal(linkArgs(REF, "WR-").ok, false);
  assert.equal(linkArgs(REF, "not a ref").message, WORK_REQUEST_REFUSAL);
  assert.equal(linkArgs("nonsense", "WR-000901").message, REF_REFUSAL);
});

test("the fixture write validates both patterns, refuses a duplicate, and replays under one key", async () => {
  const client = await fixture();
  const key = "11111111-1111-4111-8111-111111111111";
  const first = await client.linkIncidentWorkRequest({ idempotency_key: key, incident_ref: REF, work_request: "WR-000902" });
  assert.equal(first.ok, true);
  const replay = await client.linkIncidentWorkRequest({ idempotency_key: key, incident_ref: REF, work_request: "WR-000902" });
  assert.deepEqual(replay, first, "the same key did not replay the stored answer");
  const detail = await client.getIncident({ ref: REF });
  assert.equal(detail.links.filter((link) => link.ref === "WR-000902").length, 1, "the replay wrote a second link");

  await assert.rejects(
    () => client.linkIncidentWorkRequest({ idempotency_key: "22222222-2222-4222-8222-222222222222", incident_ref: REF, work_request: "WR-000902" }),
    (error) => { assert.equal(error.payload.error, "already_linked"); return true; },
  );
  await assert.rejects(
    () => client.linkIncidentWorkRequest({ idempotency_key: "33333333-3333-4333-8333-333333333333", incident_ref: REF, work_request: "nope" }),
    (error) => { assert.equal(error.payload.error, "invalid_work_request"); return true; },
  );
  await assert.rejects(
    () => client.linkIncidentWorkRequest({ idempotency_key: "44444444-4444-4444-8444-444444444444", incident_ref: "INC-1", work_request: "WR-000902" }),
    (error) => { assert.equal(error.payload.error, "invalid_incident_ref"); return true; },
  );
});

/* ---------------------------------------------------------------- the outage */

test("a read that did not answer is unknown in the app's own words", async () => {
  const client = await fixture({ outage: "incidents" });
  await assert.rejects(() => client.getIncident({ ref: REF }), /fixture outage/);
  assert.equal(REFUSAL_SENTENCE, "the record layer refused or timed out");
  assert.match(pageJs, /view\[slot\] = \{ state: "unknown", reason: REFUSAL_SENTENCE \}/);
  // The server's own text is never painted: the catch takes no argument, so
  // there is nothing to leak into the sentence a person reads.
  assert.match(pageJs, /\} catch \{/);
  assert.equal(/error\.message|error\.payload|await response\.text\(\)/.test(pageJs), false, "the page can paint the server's words");
});

/* ------------------------------------------------------------- the static page */

test("the route and the two verbs are pinned in the contracts", () => {
  assert.equal(routes.routes["/incidents"], "incidents.html");
  assert.equal(routes.version, "1.10.0");
  assert.equal(contract.version, "1.17.0");
  for (const verb of ["get-incident", "link-incident-work-request"]) {
    assert.ok(contract.mcp_operations.includes(verb), `${verb} is not pinned`);
  }
  assert.deepEqual(contract.mcp_operations, [...contract.mcp_operations].sort(), "the operation list is sorted");
});

test("the page is the shared shell: titles not descriptions, one Doc, a mono ref, AM/PM, 44px", () => {
  assert.match(html, /<title>Incident · DoctorCRE<\/title>/);
  assert.match(html, /<span class="mono" id="incidentRef">/, "the reference is not monospace");
  assert.match(html, new RegExp(`<p class="eyebrow" id="hypothesesEyebrow">${HYPOTHESIS_EYEBROW}</p>`), "the hypotheses eyebrow is missing");
  assert.match(html, /data-section="facts"/);
  assert.match(html, /data-section="hypotheses"/);
  assert.notEqual(
    /data-section="facts"/.exec(html).index,
    /data-section="hypotheses"/.exec(html).index,
    "facts and hypotheses share one region",
  );
  assert.match(html, /<button class="doc-fab" type="button" id="docFab"/);
  assert.equal([...html.matchAll(/class="doc-chat glass" id="docChat"/g)].length, 1, "Doc appears once");
  assert.match(html, /<div id="receiptDock" class="receipt-dock"/, "the dock is not mounted");
  assert.doesNotMatch(html, /<p class="(?:intro|lede|description)"/);
  assert.doesNotMatch(html, /\bTODO\b/);
  for (const match of html.replace(/\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/g, "<iso>").matchAll(/\b\d{1,2}:\d{2}\b(.{0,4})/g)) {
    assert.match(match[1], /^\s*(AM|PM)/, `"${match[0]}" prints without AM or PM`);
  }
  assert.match(css, /\.btn \{ min-height: var\(--touch\); \}/);
  assert.match(css, /\.chip \{ min-height: var\(--touch\); [^}]*\}/);
  assert.match(css, /\.field input \{ min-height: var\(--touch\); \}/);
});
