/**
 * Deal Room Call Mode, restored by decision 7dc47eea (Joe, 2026-09-23), which
 * supersedes the V5-J101 "Calls inert in the first release" exclusion.
 *
 * What it is for: Joe and Dell press a button on the Deal Room, the call they
 * have about their pipeline is recorded and transcribed on their own Mac, and
 * what was said comes back as a review pack of proposed deal updates, each
 * partner's actions and draft emails. It is not a meeting tool for clients or
 * vendors.
 *
 * The claims pinned here are about BEHAVIOUR, so most of this file drives the
 * real controller (js/call-mode.js) against a small DOM and fake transports:
 *
 *   1. nothing reaches the recorder before a partner presses a control, and
 *      building the controller starts no request and no timer;
 *   2. a recording starts only from a Start button with the consent box ticked;
 *   3. the review pack is displayed, never acted on: every item is approved or
 *      skipped by a partner, one item per press, and an Outlook draft is created
 *      only from its own approve button;
 *   4. the weekly call's context index reaches the companion in batches the
 *      verb accepts and in the shape the companion accepts, and a session left
 *      in awaiting_context is supplied again (the 2026-08-17 stall).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createCallMode, shapeCallContextDeals, readCallContextIndex, CALL_CONTEXT_BATCH,
  CALL_MODE_URL, CALL_MODE_HEADER,
} from "../js/call-mode.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const file = (path) => readFile(ROOT + path, "utf8");
const APP = new URL("../js/app.js", import.meta.url).href;

// --------------------------------------------------------------- a tiny DOM

class StubElement {
  constructor(tag, attributes = {}) {
    this.tagName = tag.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.textContent = "";
    this.innerHTML = "";
    this.open = false;
    this.focused = 0;
    const classes = new Set();
    this.classList = {
      toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name),
    };
    this.dataset = {};
    for (const [name, value] of this.attributes) {
      if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
    }
  }

  get id() { return this.attributes.get("id") || ""; }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  focus() { this.focused += 1; }
  showModal() { this.open = true; }
  close() { this.open = false; }

  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    const exact = selector.match(/^\[([\w-]+)="([^"]*)"\]$/);
    if (exact) return this.attributes.get(exact[1]) === exact[2];
    if (selector.startsWith("[")) return this.attributes.has(selector.slice(1, -1));
    return this.tagName === selector.toUpperCase();
  }

  /** A pressed control is its own closest match, as in the real delegated listener. */
  closest(selector) { return this.matches(selector) ? this : null; }
}

class StubDocument {
  constructor(nodes) { this.nodes = nodes; }
  querySelector(selector) { return this.nodes.find((node) => node.matches(selector)) || null; }
  getElementById(id) { return this.querySelector(`#${id}`); }
}

/** The Call Mode dialog exactly as index.html declares it (ids and data attributes). */
function callModeDocument() {
  const ids = ["callModeButton", "callModeDialog", "callModeClose", "callModeStage", "callModeState", "callModeTimer",
    "callModeDetail", "callModeSpeakers", "callModeConsentRow", "callModeConsent", "callModeStarts", "callModeStop",
    "callModePermission", "postCallPanel", "postCallRefresh", "postCallStatus", "postCallReport"];
  const nodes = ids.map((id) => new StubElement(id === "callModeConsent" ? "input" : "div", { id }));
  nodes.push(new StubElement("button", { "data-call-mode-start": "weekly_deal_call" }));
  nodes.push(new StubElement("button", { "data-call-mode-start": "other_call" }));
  const doc = new StubDocument(nodes);
  doc.getElementById("postCallPanel").hidden = true;
  doc.getElementById("callModeStop").hidden = true;
  return doc;
}

/** A button the review pack drew, rebuilt from its own markup so a press carries its real data attributes. */
function drawnButton(html, attribute, value) {
  const tag = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0])
    .find((candidate) => candidate.includes(`${attribute}="${value}"`));
  assert.ok(tag, `no drawn button with ${attribute}="${value}"`);
  const attributes = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const button = new StubElement("button", attributes);
  button.disabled = /\sdisabled(\s|>)/.test(tag);
  return button;
}

// ------------------------------------------------------------ fakes

function harness({ agenda = [], state = { state: "idle" }, statuses = [], contextDeals } = {}) {
  const doc = callModeDocument();
  const requests = [];
  const timers = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, method: init.method || "GET", headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    const path = url.replace(`${CALL_MODE_URL}/api/`, "");
    const answer = path === "state" ? state
      : path === "start" ? { state: "recording", mode: requests.at(-1).body.mode, session: "2026.09.23-1500", started_at: "2026-09-23T15:00:00Z" }
        : path === "stop" ? { state: "transcribing", mode: "weekly_deal_call", session: "2026.09.23-1500" } : {};
    return { ok: true, json: async () => answer };
  };
  const calls = { getCallContext: [], resolvePostCallCandidate: [], resolveConfirm: [], publishCallContext: [],
    getStatus: [], syncStatus: [], createOutlookDraft: [], startAgenda: 0, toasts: [] };
  const client = {
    async getCallContext({ deal_ids }) {
      calls.getCallContext.push(deal_ids);
      if (deal_ids.length > CALL_CONTEXT_BATCH) throw new Error("invalid_call_context_deals");
      return { deals: deal_ids.map((id) => contextDeals?.[id] || { id, name: `Deal ${id}`, owner: null, operating_state: "active",
        participants: [{ party_id: null, ref: null, name: null, email: null, role: "lead" }] }) };
    },
    async resolvePostCallCandidate(args) { calls.resolvePostCallCandidate.push(args); return { ok: true }; },
    async resolveConfirm(args) { calls.resolveConfirm.push(args); return { ok: true }; },
  };
  let statusIndex = 0;
  const postCallClient = {
    async publishCallContext(context) { calls.publishCallContext.push(context); return { ok: true, session: context.session }; },
    async getStatus(session) {
      calls.getStatus.push(session);
      return statuses[Math.min(statusIndex++, statuses.length - 1)] || { status: { state: "waiting_for_transcript" } };
    },
    async syncStatus(session) { calls.syncStatus.push(session); return {}; },
    async createOutlookDraft(session, draftId, hash) { calls.createOutlookDraft.push({ session, draftId, hash }); return { status: "created" }; },
  };
  const controller = createCallMode({
    root: doc, client: () => client, postCallClient, fetchImpl,
    agendaDeals: () => agenda,
    scope: () => ({ workspace_kind: "team" }),
    toast: (message) => calls.toasts.push(message),
    startAgenda: async () => { calls.startAgenda += 1; },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: (handle) => { if (timers[handle - 1]) timers[handle - 1].cleared = true; },
    now: () => Date.parse("2026-09-23T15:01:05Z"),
  });
  return { doc, controller, requests, timers, calls, client, postCallClient };
}

const agendaOf = (count) => Array.from({ length: count }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `Deal ${i}` }));

// ---------------------------------------------- 1. nothing before a click

test("importing the Deal Room shell with no page around it starts nothing", async () => {
  assert.equal(typeof globalThis.document, "undefined");
  const saved = globalThis.fetch;
  const seen = [];
  globalThis.fetch = (...args) => { seen.push(args); throw new Error("the shell reached fetch"); };
  try { await import(APP); } finally { globalThis.fetch = saved; }
  assert.deepEqual(seen, [], "importing the shell must make no request");
});

test("building the controller sends nothing and starts no timer", () => {
  const { requests, timers, calls, doc } = harness({ agenda: agendaOf(3) });
  assert.deepEqual(requests, [], "no request before a partner presses anything");
  assert.equal(timers.length, 0, "no poll or clock before a partner presses anything");
  assert.equal(calls.getCallContext.length + calls.publishCallContext.length + calls.getStatus.length, 0);
  assert.equal(doc.getElementById("callModeConsent").checked, false, "consent is never pre-ticked");
});

test("opening Call Mode reads the recorder's state and does nothing else", async () => {
  const { controller, requests, doc, calls } = harness();
  await controller.open();
  assert.equal(doc.getElementById("callModeDialog").open, true);
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), [`GET ${CALL_MODE_URL}/api/state`]);
  assert.equal(calls.publishCallContext.length, 0);
  assert.equal(doc.getElementById("callModeStop").hidden, true, "Stop is offered only while recording");
});

// ------------------------------------------- 2. click AND consent to start

test("a Start press without the consent box ticked records nothing", async () => {
  for (const mode of ["weekly_deal_call", "other_call"]) {
    const { controller, requests, doc, calls } = harness({ agenda: agendaOf(2) });
    const pressed = doc.querySelector(`[data-call-mode-start="${mode}"]`);
    assert.equal(await controller.handleClick(pressed), true);
    assert.deepEqual(requests, [], `${mode}: no request without consent`);
    assert.equal(calls.getCallContext.length, 0);
    assert.match(calls.toasts.at(-1), /everyone has been told/);
    assert.equal(doc.getElementById("callModeConsent").focused, 1, "focus goes to the consent box");
  }
});

test("consent without a Start press records nothing, and an unknown mode is refused", async () => {
  const { controller, requests, doc } = harness();
  doc.getElementById("callModeConsent").checked = true;
  assert.equal(await controller.start("teams_meeting"), false);
  assert.deepEqual(requests, []);
});

test("Start with consent records once, sends consent_confirmed, then asks again next time", async () => {
  const { controller, requests, doc, calls } = harness({ agenda: agendaOf(2) });
  doc.getElementById("callModeConsent").checked = true;
  await controller.handleClick(doc.querySelector('[data-call-mode-start="other_call"]'));
  const starts = requests.filter((r) => r.url.endsWith("/api/start"));
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].body, { mode: "other_call", consent_confirmed: true });
  assert.equal(starts[0].headers[Object.keys(CALL_MODE_HEADER)[0]], CALL_MODE_HEADER["X-CARR-Call-Mode"],
    "the companion's non-simple header is sent, so no other site's form can start a recording");
  assert.equal(calls.publishCallContext.length, 0, "another call carries no weekly deal context");
  assert.equal(doc.getElementById("callModeConsent").checked, false, "the next recording needs a fresh confirmation");
  assert.equal(doc.getElementById("callModeStop").hidden, false, "Stop is offered while recording");
});

test("the weekly call supplies the deal context in batches and opens the agenda", async () => {
  const agenda = agendaOf(56); // measured live 2026-09-23: 56 active team deals, over the verb's 50
  const { controller, doc, calls } = harness({ agenda });
  doc.getElementById("callModeConsent").checked = true;
  await controller.handleClick(doc.querySelector('[data-call-mode-start="weekly_deal_call"]'));
  assert.deepEqual(calls.getCallContext.map((ids) => ids.length), [50, 6]);
  assert.equal(calls.publishCallContext.length, 1);
  const context = calls.publishCallContext[0];
  assert.equal(context.session, "2026.09.23-1500");
  assert.equal(context.workspace_kind, "team");
  assert.equal(context.deals.length, 56);
  assert.deepEqual(context.deals[0], { id: agenda[0].id, name: "Deal " + agenda[0].id, owner: "", operating_state: "active", participants: [] },
    "owner null becomes \"\" and the partner's own lead row (no party) is dropped");
  assert.equal(calls.startAgenda, 1);
  assert.equal(controller.state.postCall.status, "context_ready");
});

test("Stop sends one stop and starts following the weekly review", async () => {
  const { controller, requests, doc, timers } = harness({ agenda: agendaOf(1) });
  doc.getElementById("callModeConsent").checked = true;
  await controller.start("weekly_deal_call");
  await controller.stop();
  assert.equal(requests.filter((r) => r.url.endsWith("/api/stop")).length, 1);
  assert.ok(timers.some((t) => t.ms === 1600 && !t.cleared), "the review is followed after Stop");
});

// ----------------------------------------------- 3. approval, item by item

const REPORT = {
  status: { state: "ready_review" },
  report: {
    report: { summary: "Pipeline review." },
    joe_tasks: [{ candidate_id: "cand-joe", action: "Call the landlord", deal_id: "d1", deal_name: "Deal One" }],
    dell_tasks: [{ candidate_id: "cand-dell", action: "Send the LOI", deal_id: "d2", deal_name: "Deal Two" }],
    deal_updates: [{ candidate_id: "cand-update", summary: "Terms agreed in principle", deal_id: "d1", deal_name: "Deal One", candidate_kind: "assigned_action" }],
    draft_proposals: [
      { draft_id: "draft-1", candidate_id: "cand-draft", deal_name: "Deal One", recipient_name: "Vendor A", subject: "Next steps", body: "Thanks.", content_hash: "h".repeat(64) },
      { draft_id: "draft-2", deal_name: "Deal Two", recipient_name: "Vendor B", subject: "Hold", body: "Soon.", content_hash: "g".repeat(64) },
    ],
    review_questions: [{ question: "Which suite?" }],
  },
};

async function reviewReady() {
  const h = harness({ statuses: [REPORT] });
  h.controller.startPolling("2026.09.23-1500", { weekly: true });
  await new Promise((resolve) => setImmediate(resolve));
  return { ...h, html: h.doc.getElementById("postCallReport").innerHTML };
}

test("the review pack is shown deal by deal with each partner's actions and drafts, and nothing is approved for them", async () => {
  const { html, calls, doc } = await reviewReady();
  assert.equal(doc.getElementById("postCallPanel").hidden, false);
  for (const heading of ["Deal by deal", "Joe this week", "Dell this week", "Questions to resolve", "What clients and vendors need to know"]) {
    assert.match(html, new RegExp(heading), `${heading} section`);
  }
  assert.match(doc.getElementById("postCallStatus").innerHTML, /Nothing is saved until Joe or Dell approves each item/);
  // One Confirm and one Skip per pending item, and nothing resolved on arrival.
  for (const id of ["cand-joe", "cand-dell", "cand-update"]) {
    assert.equal(html.split(`data-post-call-confirm="${id}"`).length - 1, 1, `${id} has exactly one Confirm`);
    assert.equal(html.split(`data-post-call-skip="${id}"`).length - 1, 1, `${id} has exactly one Skip`);
  }
  assert.deepEqual(calls.resolvePostCallCandidate, [], "no item is approved by displaying it");
  assert.deepEqual(calls.resolveConfirm, []);
  assert.deepEqual(calls.createOutlookDraft, [], "no Outlook draft exists before a partner approves it");
  assert.deepEqual(calls.syncStatus, []);
  // A draft with no matched candidate cannot be approved at all yet.
  assert.equal(drawnButton(html, "data-create-outlook-draft", "draft-2").disabled, true);
  assert.equal(drawnButton(html, "data-create-outlook-draft", "draft-1").disabled, false);
  assert.match(html, /Creates a draft only\. Joe or Dell reviews and sends it in Outlook\./);
  assert.doesNotMatch(html, /data-send|>Send</, "there is no send control");
});

test("confirming one item resolves that item only; skipping records a no", async () => {
  const { html, calls, controller } = await reviewReady();
  await controller.handleClick(drawnButton(html, "data-post-call-confirm", "cand-joe"));
  assert.equal(calls.resolvePostCallCandidate.length, 1);
  assert.equal(calls.resolvePostCallCandidate[0].candidate_id, "cand-joe");
  assert.equal(calls.resolvePostCallCandidate[0].accept, true);
  assert.match(calls.resolvePostCallCandidate[0].idempotency_key, /^[0-9a-f-]{36}$/);
  await controller.handleClick(drawnButton(html, "data-post-call-skip", "cand-dell"));
  assert.deepEqual(calls.resolvePostCallCandidate.map((c) => [c.candidate_id, c.accept]), [["cand-joe", true], ["cand-dell", false]]);
  assert.deepEqual(calls.createOutlookDraft, [], "approving a task creates no draft");
});

test("an Outlook draft is created only from its own approve button, and never sent", async () => {
  const { html, calls, controller } = await reviewReady();
  await controller.handleClick(drawnButton(html, "data-create-outlook-draft", "draft-1"));
  assert.deepEqual(calls.resolvePostCallCandidate.map((c) => [c.candidate_id, c.accept]), [["cand-draft", true]]);
  assert.deepEqual(calls.createOutlookDraft, [{ session: "2026.09.23-1500", draftId: "draft-1", hash: "h".repeat(64) }]);
  assert.match(calls.toasts.at(-1), /Nothing was sent/);
});

// --------------------------------------------- 3b. Jev checks (008d682a)

test("an item Jev flagged shows the flag and its plain-English reasons, without hiding the item", async () => {
  const flaggedReport = {
    ...REPORT,
    report: {
      ...REPORT.report,
      joe_tasks: [{
        ...REPORT.report.joe_tasks[0],
        checks: {
          deal: { pass: false }, speaker: { pass: true }, details: { pass: true },
          flagged: true,
          reasons: ["Right deal: Jev matched a different deal ('d9')."],
        },
      }],
    },
  };
  const h = harness({ statuses: [flaggedReport] });
  h.controller.startPolling("2026.09.23-1500", { weekly: true });
  await new Promise((resolve) => setImmediate(resolve));
  const html = h.doc.getElementById("postCallReport").innerHTML;
  assert.match(html, /post-call-checks-flagged/);
  assert.match(html, /Flagged for review/);
  assert.match(html, /Right deal: Jev matched a different deal/);
  // The item itself is still shown and still actionable, never dropped.
  assert.match(html, /data-post-call-confirm="cand-joe"/);
  assert.match(html, /Call the landlord/);
});

test("an item Jev never reached shows a neutral unavailable note, not a flag", async () => {
  const unavailableReport = {
    ...REPORT,
    report: {
      ...REPORT.report,
      dell_tasks: [{ ...REPORT.report.dell_tasks[0], checks: { unavailable: true } }],
    },
  };
  const h = harness({ statuses: [unavailableReport] });
  h.controller.startPolling("2026.09.23-1500", { weekly: true });
  await new Promise((resolve) => setImmediate(resolve));
  const html = h.doc.getElementById("postCallReport").innerHTML;
  assert.match(html, /post-call-checks-unavailable/);
  assert.match(html, /Automatic Jev checks did not run for this item\./);
  assert.doesNotMatch(html, /post-call-checks-flagged/);
});

test("an item with no checks at all (Jev never ran) renders exactly as it did before", async () => {
  const { html } = await reviewReady();
  assert.doesNotMatch(html, /post-call-checks/);
});

// ------------------------------------- 4. the awaiting_context stall, closed

test("a weekly session still awaiting context gets the index once, then waits", async () => {
  const awaiting = { status: { state: "awaiting_context" } };
  const h = harness({ agenda: agendaOf(3), statuses: [awaiting, awaiting] });
  h.controller.startPolling("2026.08.17-0930", { weekly: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.publishCallContext.length, 1, "the late index is supplied");
  assert.equal(h.calls.publishCallContext[0].session, "2026.08.17-0930");
  await h.controller.refreshPostCall({ quiet: true });
  assert.equal(h.calls.publishCallContext.length, 1, "and not re-sent on every poll");
});

test("a context failure stays on screen with a Retry, and Retry supplies it", async () => {
  const awaiting = { status: { state: "awaiting_context" } };
  const h = harness({ agenda: [], statuses: [awaiting] });
  h.controller.startPolling("2026.09.23-1500", { weekly: true });
  await new Promise((resolve) => setImmediate(resolve));
  const status = h.doc.getElementById("postCallStatus").innerHTML;
  assert.match(status, /no active work records/);
  assert.match(status, /data-retry-call-context/);
  assert.ok(h.timers.every((t) => t.ms !== 1600 || t.cleared), "polling stops so the reason is not overwritten");
  // The partner opens the team pipeline, then presses Retry.
  const fixed = harness({ agenda: agendaOf(2), statuses: [awaiting] });
  fixed.controller.state.postCall = { ...h.controller.state.postCall };
  const retry = new StubElement("button", { "data-retry-call-context": "" });
  await fixed.controller.handleClick(retry);
  assert.equal(fixed.calls.publishCallContext.length, 1);
});

test("an other call is never given weekly deal context", async () => {
  const h = harness({ agenda: agendaOf(2), state: { state: "transcribing", mode: "other_call", session: "s-other" } });
  await h.controller.open();
  assert.equal(h.calls.getStatus.length, 0);
  assert.equal(h.calls.publishCallContext.length, 0);
});

// ----------------------------------------------------------- pure shaping

test("the context index is shaped to the companion's exact contract and never invents an id", async () => {
  const shaped = shapeCallContextDeals([{ id: "d1", name: "One", owner: null, operating_state: "active", participants: [
    { party_id: null, ref: null, name: null, email: null, role: "lead" },
    { party_id: "p1", ref: "P-0001", name: "Landlord", email: null, role: "listing_side" },
    { party_id: "p1", ref: "P-0001", name: "Landlord", email: null, role: "vendor" },
    { party_id: "p2", ref: null, name: "Half", email: "", role: "vendor" },
  ] }]);
  assert.deepEqual(shaped, [{ id: "d1", name: "One", owner: "", operating_state: "active", participants: [
    { party_id: "p1", ref: "P-0001", name: "Landlord", email: "", role: "listing_side, vendor" },
  ] }]);
  await assert.rejects(readCallContextIndex({ getCallContext: async () => ({ deals: [] }) }, agendaOf(1)), /no active agenda work/);
  await assert.rejects(readCallContextIndex({}, agendaOf(1)), /not available/);
});

// ------------------------------------------------------- the shipped shell

test("the shipped Deal Room carries Call Mode: button, consent, both call kinds, Stop and the review panel", async () => {
  const html = await file("index.html");
  assert.match(html, /<button type="button" class="call-mode-button" id="callModeButton" aria-haspopup="dialog" aria-label="Open Call Mode">/);
  assert.match(html, /<dialog id="callModeDialog"[^>]*aria-labelledby="callModeTitle"/);
  assert.match(html, /<input type="checkbox" id="callModeConsent">/, "consent is an unticked checkbox");
  assert.match(html, /I have told everyone on this call that it will be recorded\./);
  assert.match(html, /data-call-mode-start="weekly_deal_call">Start weekly Joe \+ Dell deal call</);
  assert.match(html, /data-call-mode-start="other_call">Start another call</);
  assert.match(html, /id="callModeStop" hidden>Stop and process</);
  assert.match(html, /<section class="post-call" id="postCallPanel"[^>]*hidden>/);
  assert.match(html, /Nothing is written to a deal and no email draft is created until Joe or Dell approves that item\./);
  assert.doesNotMatch(html, /id="callsButton"|not part of this release/, "the inert Calls notice is gone");
  assert.match(html, /<tbody id="rows">/, "the sentinel the shell boots on");
  assert.equal((html.match(/<script/g) || []).length, 1, "CSP is script-src 'self': one module tag");
});

test("the shell wires Call Mode to its own controls and boots only inside its own page", async () => {
  const app = await file("js/app.js");
  assert.match(app, /import \{ createCallMode, CALL_MODE_URL, CALL_MODE_HEADER \} from '\.\/call-mode\.js';/);
  assert.match(app, /\$\('#callModeButton'\)\.onclick = \(\) => state\.callModeUi\.open\(\);/);
  assert.match(app, /\$\('#callModeStop'\)\.onclick = \(\) => state\.callModeUi\.stop\(\);/);
  assert.match(app, /if \(typeof document !== 'undefined' && document\.getElementById\('rows'\)\) \{\s*boot\(\)\.catch/);
  // No path to the recorder except through the controller.
  assert.doesNotMatch(app, /\/api\/(start|stop)|consent_confirmed/);
  for (const match of app.matchAll(/localStorage\.\w+\('([^']+)'/g)) {
    assert.ok(["dealroom-theme", "dealroom-color-assist"].includes(match[1]),
      `no stored preference may start a recording; found localStorage key ${match[1]}`);
  }
  const worker = await file("src/worker.js");
  assert.match(worker, /connect-src 'self' http:\/\/127\.0\.0\.1:4682/, "the CSP admits exactly the loopback companion");
});
