import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  NO_PORTFOLIO_REASON, STAGES, STALE_REASON, availableActions, deliveryStages, dispositionArgs,
  dispositionEffect, dispositionOptions, operationKeys, refusalMessage, renderCount, stageDenominator,
  validPassportPayload, validPortfolioPayload, validWorkRequestCard,
} from "../js/delivery-evidence-model.js";
import { dispositionState } from "../js/work-inventory-model.js";
import { createFixtureClient } from "../js/fixture-client.js";
import { createCommandState, performCommand } from "../js/command-feedback.mjs";
import { uuidv4 } from "../js/uuid.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const evidenceRef = (ref) => ({ ref, content_digest: "d".repeat(64), redaction_class: "metadata_only" });
const facet = (state, ref = null, note = "note") => ({ state, evidence_refs: ref ? [evidenceRef(ref)] : [], note });
const slice = (slice_ref, state) => ({ slice_ref, ordinal: 1, dependency_refs: [], state, planned_check_refs: [], deviation_refs: [], manual_qa_required: false, release_requirement: "none" });

/**
 * The producer's own shape, transcribed from the engineering passport
 * projection. Every closure facet is an OBJECT with a state, not a ref — that
 * is the shape the record layer emits, and a fixture that disagreed with it
 * would let this consumer pass against a passport that cannot exist.
 */
function passport(overrides = {}) {
  const closure = {
    work: facet("unresolved"), proof: facet("unresolved"), explanation: facet("unresolved"),
    release: facet("unresolved"), learning: { state: "unresolved", route: null, evidence_refs: [], note: "seam" },
    ...(overrides.closure || {}),
  };
  return {
    schema_version: "engineering-passport.v1",
    work_request: "WR-000901",
    accepted_plan_revision: { id: "WR-000901-PLAN", revision: 3, digest: "a".repeat(64) },
    plan_digest: "b".repeat(64),
    slice_plan: { work_request: "WR-000901", slices: [] },
    execution_envelopes: [], slices: [slice("SL-1", "verified_complete")],
    current_receipts: [], current_reviewer_facts: [], receipts: [], reviewer_facts: [], qa_facts: [],
    operator_receipt: { what_changed: [], why: "why", evidence_refs: [], deviations: [], remaining_risk: [], manual_qa_items: [] },
    closure_state: "blocked",
    stale_conflict: { state: "none", reason: null },
    projection_digest: "c".repeat(64),
    ...overrides,
    closure,
  };
}

const card = (overrides = {}) => ({ ok: true, human_ref: "WR-000904", title: "Demo captured", state: "captured", version: 1, ...overrides });

const coverageRow = (overrides = {}) => ({
  kind: "work_request", source_ref: "ops.work_request", state: "complete", count_returned: 3,
  count_total: 12, reason: null, excluded_other_tenant: 0, page_capped: false, ...overrides,
});

const stageOf = (cells, name) => cells.find((cell) => cell.stage === name);

test("the passport contract is exact-key and refuses an undeclared field", () => {
  assert.equal(validPassportPayload(passport()), true);
  assert.equal(validPassportPayload({ ...passport(), surprise: 1 }), false);
  const { qa_facts, ...missing } = passport();
  void qa_facts;
  assert.equal(validPassportPayload(missing), false);
  assert.equal(validPassportPayload(null), false);
  // A slice state the passport cannot emit is not a slice state this page reads.
  assert.equal(validPassportPayload(passport({ slices: [slice("SL-1", "shipped")] })), false);
});

test("a null count_total renders unknown, never 0 and never a percentage", () => {
  // THE NAMED CASE. Mutating count_total to null must flip the answer.
  const known = stageDenominator([coverageRow()]);
  assert.deepEqual(known, { known: true, total: 12, reason: null });
  assert.equal(renderCount(3, known), "3 of 12 (25%)");

  const unknown = stageDenominator([coverageRow({ count_total: null, state: "partial", reason: "the count timed out" })]);
  assert.equal(unknown.known, false);
  assert.equal(unknown.total, null);
  assert.equal(unknown.reason, "the count timed out");
  assert.equal(renderCount(3, unknown), "unknown");
  assert.doesNotMatch(renderCount(3, unknown), /%|\b0\b/);

  // A complete leg that still claimed no total is just as unknown.
  assert.equal(renderCount(3, stageDenominator([coverageRow({ count_total: null })])), "unknown");
  // And so is a page-capped one, whose returned rows are not the whole source.
  assert.equal(renderCount(3, stageDenominator([coverageRow({ page_capped: true })])), "unknown");
  // No work-request coverage row at all is unknown, not zero.
  assert.equal(renderCount(3, stageDenominator([{ ...coverageRow(), kind: "loop" }])), "unknown");
  assert.equal(renderCount(0, known), "0 of 12 (0%)");
});

test("the three CR-AC examples each render a non-operational token, never complete", () => {
  // built-unmerged: every slice verified, closure still unresolved.
  const built = deliveryStages(passport());
  assert.equal(stageOf(built, "source_verified").state, "complete");
  assert.equal(stageOf(built, "merged").state, "unknown");
  assert.notEqual(stageOf(built, "merged").state, "complete");

  // merged-unactivated: the work facet is complete, release is not.
  const merged = deliveryStages(passport({ closure: { work: facet("complete", "demo-merge") } }));
  assert.equal(stageOf(merged, "merged").state, "complete");
  assert.equal(stageOf(merged, "merged").evidence_ref, "demo-merge");
  assert.equal(stageOf(merged, "activated").state, "unknown");
  assert.notEqual(stageOf(merged, "activated").state, "complete");

  // active-unproven: closure complete and released, consumer proof still open.
  const active = deliveryStages(passport({
    closure_state: "complete",
    closure: { work: facet("complete", "demo-merge"), release: facet("complete", "demo-release") },
  }));
  assert.equal(stageOf(active, "activated").state, "complete");
  assert.equal(stageOf(active, "consumer_proven").state, "unknown");
  assert.notEqual(stageOf(active, "consumer_proven").state, "complete");

  // The operational token is `complete` ONLY, and every complete carries a ref.
  for (const cells of [built, merged, active]) {
    for (const cell of cells) {
      assert.ok(["complete", "not reached", "unknown"].includes(cell.state));
      if (cell.state === "complete") assert.ok(cell.evidence_ref, `${cell.stage} claims complete with no reference`);
    }
  }
});

test("an unfinished slice is not reached, and no passport is unknown everywhere", () => {
  const blocked = deliveryStages(passport({ slices: [slice("SL-1", "verified_complete"), slice("SL-2", "blocked")] }));
  assert.equal(stageOf(blocked, "source_verified").state, "not reached");
  assert.match(stageOf(blocked, "source_verified").reason, /SL-2 is blocked/);

  const none = deliveryStages(null);
  assert.equal(none.length, STAGES.length);
  assert.ok(none.every((cell) => cell.state === "unknown"));
  assert.equal(stageOf(none, "approved").reason, "no passport has been read for this record");
});

test("a stale plan renders every stage unknown and no percentage is offered", () => {
  const stale = deliveryStages(passport({
    stale_conflict: { state: "stale", reason: "the plan no longer matches the accepted source" },
    closure_state: "complete",
    closure: { work: facet("complete", "demo"), proof: facet("complete", "demo"), release: facet("complete", "demo") },
  }));
  assert.ok(stale.every((cell) => cell.state === "unknown"), "a stale passport proves nothing about today");
  assert.ok(stale.every((cell) => cell.reason === STALE_REASON));
  assert.ok(stale.every((cell) => cell.evidence_ref === null));
  // Nothing complete means nothing to count, and the count says so in words.
  const proven = stale.filter((cell) => cell.state === "complete").length;
  assert.equal(renderCount(proven, { known: false, total: null, reason: STALE_REASON }), "unknown");
});

test("approval is read only from a portfolio that was actually read", () => {
  assert.equal(stageOf(deliveryStages(passport()), "approved").reason, NO_PORTFOLIO_REASON);
  const accepted = { ok: true, portfolio_ref: "PF-DEMO-1", exists: true, accepted: true, accepted_revision_id: "PF-DEMO-1-R2", reviews: [] };
  assert.equal(validPortfolioPayload(accepted), true);
  assert.equal(stageOf(deliveryStages(passport(), accepted), "approved").state, "complete");
  assert.equal(stageOf(deliveryStages(passport(), accepted), "approved").evidence_ref, "PF-DEMO-1-R2");
  // exists:false inside an ok answer is UNKNOWN, not absent and not refused.
  const missing = { ...accepted, exists: false, accepted: false, accepted_revision_id: null };
  assert.equal(stageOf(deliveryStages(passport(), missing), "approved").state, "unknown");
  // A positive "nobody accepted it" is the only not-reached this cell has.
  assert.equal(stageOf(deliveryStages(passport(), { ...accepted, accepted: false }), "approved").state, "not reached");
});

test("dispositionOptions marks the four verb-less C27 items unavailable", () => {
  const options = dispositionOptions(card());
  assert.deepEqual(options.map((option) => option.choice), ["continue", "finish_shipping", "combine", "supersede", "shelve", "investigate"]);
  const unavailable = options.filter((option) => option.available === false).map((option) => option.choice);
  assert.deepEqual(unavailable.sort(), ["combine", "finish_shipping", "investigate", "shelve"]);
  for (const choice of unavailable) {
    assert.equal(options.find((option) => option.choice === choice).verb, null);
  }
  assert.equal(options.find((option) => option.choice === "supersede").verb, "supersede-work-request");
  // Shelving is not declining, and the page says so rather than mapping one to the other.
  assert.match(options.find((option) => option.choice === "shelve").reason, /Shelving is not declining/);
  // A record past captured offers no withdrawal at all.
  assert.equal(dispositionOptions(card({ state: "ready" })).find((option) => option.choice === "supersede").available, false);
  const ready = availableActions(card({ state: "ready", human_ref: "WR-000901" }));
  assert.deepEqual(ready.filter((action) => action.available).map((action) => action.choice), ["shape"]);
  assert.deepEqual(availableActions(card({ state: "declined" })).filter((action) => action.available), []);
});

test("verb arguments are built from the fresh card and refuse a missing part in words", () => {
  const fresh = card({ version: 6 });
  assert.deepEqual(dispositionArgs({ card: fresh, choice: "decline", reason: "captured twice" }),
    { human_ref: "WR-000904", base_version: 6, exit_reason: "captured twice" });
  assert.deepEqual(dispositionArgs({ card: fresh, choice: "supersede", reason: "replaced", successor: "WR-000910" }),
    { human_ref: "WR-000904", base_version: 6, exit_reason: "replaced", superseded_by: "WR-000910" });
  assert.deepEqual(dispositionArgs({ card: fresh, choice: "shape", disposition: "not_required", reason: "the surface is fixed", fixedSurfaceRef: "work-inventory.html" }),
    { work_request: "WR-000904", base_version: 6, disposition: "not_required", rationale: "the surface is fixed", fixed_surface_ref: "work-inventory.html" });
  assert.throws(() => dispositionArgs({ card: fresh, choice: "decline", reason: "  " }), /1 to 500 characters/);
  assert.throws(() => dispositionArgs({ card: fresh, choice: "supersede", reason: "x", successor: "wr-1" }), /work request reference/);
  assert.throws(() => dispositionArgs({ card: fresh, choice: "shape", disposition: "not_required", reason: "x" }), /name that surface/);
  assert.throws(() => dispositionArgs({ card: card({ state: "ready" }), choice: "decline", reason: "x" }), /captured only/);
  assert.throws(() => dispositionArgs({ card: { ok: true }, choice: "decline", reason: "x" }), /read fresh/);
  assert.throws(() => dispositionArgs({ card: fresh, choice: "combine", reason: "x" }), /No supported disposition command/);
  // The popup says the exact canonical state the action yields.
  assert.equal(dispositionEffect("decline", "WR-000904"), "This records WR-000904 as declined; nothing is deleted and its history stays.");
  assert.match(dispositionEffect("supersede", "WR-000904", { successor: "WR-000910" }), /nothing merges/);
  assert.equal(validWorkRequestCard({ ok: true, human_ref: "WR-1", state: "captured", version: 0 }), false);
});

test("a refused write keeps the draft, a re-read moves the base, and the replay is confirmed", async () => {
  const fixture = await createFixtureClient({ seedUrl: await seedUrl() });
  let state = createCommandState();
  const operationKey = operationKeys.decline("WR-000904");
  const run = (args) => performCommand({
    operationKey, args,
    getState: () => state, setState: (next) => { state = next; },
    newKey: uuidv4, call: (request) => fixture.declineWorkRequest(request),
  });

  // The draft a person typed, sent against a version that is not the one there is.
  const draft = "captured twice by the intake";
  const stale = await run({ human_ref: "WR-000904", base_version: 99, exit_reason: draft });
  assert.equal(stale.status, "conflict");
  assert.equal(stale.reason, "version_conflict");
  assert.match(refusalMessage("version_conflict", { ref: "WR-000904" }), /read again/);
  // The draft is still the caller's; nothing in the kernel consumed or changed it.
  assert.equal(draft, "captured twice by the intake");

  // Re-read, then decide from what the record holds now.
  const fresh = await fixture.workRequestCard({ work_request: "WR-000904" });
  assert.equal(validWorkRequestCard(fresh), true);
  assert.equal(fresh.state, "captured");
  const args = dispositionArgs({ card: fresh, choice: "decline", reason: draft });
  const ok = await run(args);
  assert.equal(ok.status, "ok");
  assert.equal(ok.response.state, "declined");
  assert.equal(ok.replayed, false);

  // The same key and the same arguments replay the stored answer: confirmed,
  // and the record moved exactly once.
  const replay = await fixture.declineWorkRequest(ok.request);
  assert.deepEqual(replay, ok.response);
  const after = await fixture.workRequestCard({ work_request: "WR-000904" });
  assert.equal(after.state, "declined");
  assert.equal(after.version, fresh.version + 1);

  // And a declined record offers no second withdrawal.
  assert.deepEqual(availableActions(after).filter((action) => action.available), []);
});

test("the fixture carries the three delivery examples plus a stale plan, and refuses a miss", async () => {
  const fixture = await createFixtureClient({ seedUrl: await seedUrl() });
  const stages = async (ref, portfolioRef = null) => {
    const held = await fixture.engineeringPassport({ work_request: ref });
    assert.equal(validPassportPayload(held), true, `${ref} passport shape`);
    const portfolio = portfolioRef ? await fixture.readPortfolio({ portfolio_ref: portfolioRef }) : null;
    return deliveryStages(held, portfolio);
  };
  assert.equal(stageOf(await stages("WR-000901"), "merged").state, "unknown");
  assert.equal(stageOf(await stages("WR-000902"), "merged").state, "complete");
  assert.equal(stageOf(await stages("WR-000902"), "activated").state, "unknown");
  assert.equal(stageOf(await stages("WR-000903"), "activated").state, "complete");
  assert.equal(stageOf(await stages("WR-000903"), "consumer_proven").state, "unknown");
  assert.ok((await stages("WR-000905", "PF-DEMO-1")).every((cell) => cell.state === "unknown"), "a stale plan proves nothing");
  assert.equal(stageOf(await stages("WR-000901", "PF-DEMO-1"), "approved").state, "complete");
  assert.equal(stageOf(await stages("WR-000902", "PF-DEMO-2"), "approved").state, "not reached");

  // A captured record has no passport, and the read REFUSES rather than
  // answering an empty one: an empty answer would paint as "no evidence".
  await assert.rejects(() => fixture.engineeringPassport({ work_request: "WR-000904" }),
    (error) => error.payload.error === "engineering_work_request_not_found");
  await assert.rejects(() => fixture.workRequestCard({ work_request: "WR-000999" }),
    (error) => error.payload.error === "work_request_not_found");
  await assert.rejects(() => fixture.readPortfolio({ portfolio_ref: "PF-NONE" }),
    (error) => error.payload.error === "portfolio_readback_unavailable");
});

test("the page offers no command it cannot send, and stays inside the accessibility floor", async () => {
  const html = await readFile(`${ROOT}/work-inventory.html`, "utf8");
  const css = await readFile(`${ROOT}/css/work-inventory.css`, "utf8");
  const js = await readFile(`${ROOT}/js/work-inventory.js`, "utf8");
  const carr = JSON.parse(await readFile(`${ROOT}/contracts/carr-interface.v1.json`, "utf8"));
  const routes = JSON.parse(await readFile(`${ROOT}/contracts/app-routes.v1.json`, "utf8"));

  // NO new page and NO new route: this slice lives on the surface that already
  // reads the census, at the route the census already owns.
  assert.equal(routes.routes["/work-inventory"], "work-inventory.html");
  assert.equal(routes.version, "1.12.0", "the Control Room route moved this additive contract on");
  assert.equal(carr.version, "1.24.0", "an added HTTP surface is a minor bump of the interface contract");
  for (const verb of ["engineering-passport", "read-portfolio", "work-request-card", "decline-work-request", "supersede-work-request", "set-work-shape-disposition"]) {
    assert.ok(carr.mcp_operations.includes(verb), `the interface must pin ${verb}`);
  }
  assert.deepEqual(carr.mcp_operations, [...carr.mcp_operations].sort(), "the pinned operations stay sorted");

  // The four verb-less dispositions are a sentence, never a button.
  for (const word of ["combine", "shelve", "investigate", "finish shipping"]) {
    assert.doesNotMatch(html, new RegExp(`<button[^>]*>[^<]*${word}`, "i"), `${word} must not be a control`);
  }
  assert.match(html, /No supported disposition command exists for combine, shelve, investigate or finish shipping\./);
  assert.match(html, /Independent review is recorded by the reviewing seat, not from this page\./);

  // Both popups are real dialog elements, and the dock is on the page.
  for (const id of ["evidenceDialog", "dispositionDialog", "receiptDock", "stageRows", "dispositionRows", "stageDenominatorLine"]) {
    assert.ok(html.includes(`id="${id}"`), `the page must carry #${id}`);
  }
  assert.equal((html.match(/<dialog /g) || []).length, 2);
  assert.match(html, /Counts have a known denominator; N\/A carries a reason\./, "the prototype's caption travels with the table");

  // Titles only under a card title, and the 44px floor on every new control.
  assert.match(css, /#dispositionRows \.btn,\n\.dialog \.row-wrap \.btn \{ min-height: var\(--touch\); \}/);
  assert.match(css, /\.stage-table td \.btn,/);
  assert.doesNotMatch(html, /<h2 id="stagesTitle">Delivery stages<\/h2><\/div><p class="small">/, "no lede sits under a card title");

  // The page never invents a positive: every unverified value is the word unknown.
  assert.match(js, /deliveryStages\(null\)/);
  assert.match(js, /stageDenominator\(/);
  assert.doesNotMatch(js, /review-engineering-slice/, "independent review is not a browser write");

  // Nine columns cannot be a table on a phone: the header hides and each cell
  // carries its own caption, so nothing is read by counting across.
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.stage-table thead \{ display: none; \}/);
  assert.match(css, /\.stage-table td\[data-stage-label\]::before \{\n\s*content: attr\(data-stage-label\);/);
  assert.match(js, /data-stage-label="\$\{escapeHtml\(STAGE_LABEL\[row\.stage\]/, "every stage cell carries its column caption");
  assert.match(js, /data-stage-label="Record"/);
  assert.match(js, /data-stage-label="Evidence"/);
  // The state colours are keyed to the cell, not to the table layout.
  assert.match(css, /\.stage-cell\[data-state="complete"\]/);

  // The disposition row shows the census status before any card is read, and
  // marks it as the census's word rather than the card's.
  assert.match(js, /dispositionState\(item, card\)/);
  assert.match(js, /from the census read/);
});

test("a disposition row states what it knows, and says which read it came from", () => {
  const item = { kind: "work_request", id: "WR-000901", status: "in_progress" };

  // No card: the census already answered, so the row is not "unknown" — but the
  // word is marked as the census's, not the card's.
  assert.deepEqual({ ...dispositionState(item, null) }, { state: "in_progress", source: "census" });

  // A card is authority and needs no marker.
  assert.deepEqual({ ...dispositionState(item, { state: "triaged" }) }, { state: "triaged", source: "card" });

  // Neither: the literal word unknown, never an invented state.
  assert.deepEqual({ ...dispositionState({ kind: "work_request", id: "WR-000902" }, null) },
    { state: "unknown", source: "none" });
  assert.deepEqual({ ...dispositionState({ status: "   " }, null) }, { state: "unknown", source: "none" });
});

/** file: URLs are not fetchable in node, so the seed travels as a data: URL. */
async function seedUrl() {
  const text = await readFile(`${ROOT}/data/board-seed.json`, "utf8");
  return `data:application/json;base64,${Buffer.from(text).toString("base64")}`;
}
