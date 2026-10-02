import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { claimEvidence, confidenceInfo, errorMessage, freshness, isDncStage, isTerminal, stageChoices } from "../js/leads-app.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");

test("Leads shell exposes named filters, accessible dialogs and discreet freshness", async () => {
 const html=await read("leads.html");
 for(const id of ["leadSearch","ownerFilter","stageFilter","marketFilter","leadDetail","stageDialog","boardUpdated","refreshBoard","searchUpdated","territoryMap","hotLeads"]) assert.match(html,new RegExp(`id="${id}"`));
 assert.match(html,/aria-live="polite"/);assert.match(html,/aria-busy="true"/);assert.match(html,/5 hottest leads to claim/);
 assert.doesNotMatch(html,/Compact|Comfortable|claimCards|pipelineArrow|Read again|retry read/);
 assert.match(html,/js\/leads-workspace-app.js/);
});
test("Leads motion and responsive grid honor reduced motion and never require a wide canvas", async () => {
 const css=await read("css/leads.css");assert.match(css,/repeat\(6,minmax\(0,1fr\)\)/);assert.match(css,/translateY\(-2px\)/);
 assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);assert.match(css,/animation:none!important/);assert.match(css,/transition:none!important/);
 assert.match(css,/width:min\(1120px/);assert.doesNotMatch(css,/min-width:760px/);
});
test("confidence and terminal helpers preserve production values and lock suppression instructions", () => {
  assert.deepEqual(confidenceInfo("high"), { text: "High confidence", verify: false });
  assert.deepEqual(confidenceInfo("medium"), { text: "Medium confidence", verify: true });
  assert.deepEqual(confidenceInfo("low"), { text: "Low confidence", verify: true });
  assert.deepEqual(confidenceInfo(null), { text: "Confidence missing", verify: true });
  assert.deepEqual(confidenceInfo(0.82), { text: "82% confidence", verify: false });
  assert.deepEqual(confidenceInfo(0.35), { text: "35% confidence", verify: true });
  assert.equal(isDncStage("do_not_contact"), true);
  assert.equal(isDncStage("contacted"), false);
  const stages = [{ slug: "new" }, { slug: "do_not_contact" }, { slug: "contacted" }];
  assert.deepEqual(stageChoices(stages, { stage: "new" }).map((stage) => stage.slug), ["new", "contacted"]);
  assert.deepEqual(stageChoices(stages, { stage: "do_not_contact" }).map((stage) => stage.slug), ["new", "do_not_contact", "contacted"]);
  assert.equal(isTerminal({ suppressed: true, stage: "new" }), true);
  assert.equal(isTerminal({ suppressed: false, stage: "do_not_contact" }), true);
  assert.equal(isTerminal({ do_not_contact: true, stage: "new" }), true);
  assert.equal(freshness({ suppressed: true, stage: "new" }).key, "terminal");
  assert.deepEqual(freshness({ suppressed: false, stage: "do_not_contact" }),
    { key: "terminal", text: "Do not contact" });
  assert.equal(freshness({ do_not_contact: true, stage: "new" }).key, "terminal");
  assert.match(errorMessage({ code: "unauthorized" }), /session has ended/i);
});

test("Claim Card demands typed source links and preserves stated discrepancies", async () => {
  const html = await read("leads.html");
  const app = await read("js/leads-app.js");
  const contract = JSON.parse(await read("contracts/carr-interface.v1.json"));
  assert.match(html, /id="hotLeads"[^>]+aria-busy="true"/);
  assert.match(html, /id="leadBoardError"[^>]+role="alert"/);
  assert.match(app, /Possible duplicate/);
  assert.match(app, /Retry same request/);
  for (const verb of ["claim-card", "promote-pool", "decline-candidate"]) assert.ok(contract.mcp_operations.includes(verb));
  const values = { name: "https://example.test/n", company: "https://example.test/c", phone: "https://example.test/p", specialty: "https://example.test/s", market: "https://example.test/m", discrepancies: "Phone differs" };
  const evidence = claimEvidence(values, "2026-09-27T12:00:00Z");
  assert.deepEqual(Object.keys(evidence.field_evidence), ["name", "company", "phone", "specialty", "market"]);
  assert.deepEqual(evidence.field_evidence.phone, [2]);
  assert.deepEqual(evidence.discrepancies, ["Phone differs"]);
  assert.deepEqual(evidence.sources.map(item => item.observed_at), Array(5).fill("2026-09-27T12:00:00Z"));
  assert.throws(() => claimEvidence({ ...values, phone: "http://example.test/p" }, "2026-09-27T12:00:00Z"), /HTTPS/);
  assert.throws(() => claimEvidence({ ...values, phone: "https://user:secret@example.test/p" }, "2026-09-27T12:00:00Z"), /credentials/);
  assert.throws(() => claimEvidence({ ...values, phone: "" }, "2026-09-27T12:00:00Z"));
});
