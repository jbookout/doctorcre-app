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
import { readFile, mkdir } from "node:fs/promises";
import { chromium, fixtureServer } from "./browser-harness.mjs";
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

class StubDocument extends EventTarget {
  constructor(nodes) { super(); this.nodes = nodes; this.visibilityState = "visible"; this.defaultView = new EventTarget(); }
  querySelector(selector) { return this.nodes.find((node) => node.matches(selector)) || null; }
  getElementById(id) { return this.querySelector(`#${id}`); }
}

/** The Call Mode dialog exactly as index.html declares it (ids and data attributes). */
function callModeDocument() {
  const ids = ["callModeButton", "callModeDialog", "callModeClose", "callModeStage", "callModeState", "callModeTimer",
    "callModeDetail", "callModeSpeakers", "callModeConsentRow", "callModeConsent", "callModeStarts", "callModeStop",
    "callModePermission", "postCallPanel", "postCallRefresh", "postCallStatus", "postCallOutcomes", "postCallReport"];
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

function harness({ agenda = [], state = { state: "idle" }, statuses = [], contextDeals, withAgenda = true, agendaResult, now = () => Date.parse("2026-09-23T15:01:05Z") } = {}) {
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
    ...(withAgenda ? { startAgenda: async () => { calls.startAgenda += 1; return agendaResult; } } : {}),
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: (handle) => { if (timers[handle - 1]) timers[handle - 1].cleared = true; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (handle) => { if (timers[handle - 1]) timers[handle - 1].cleared = true; },
    now,
  });
  // These baseline recorder/review tests run against a reachable companion.
  // Unknown, failed and pending eligibility are exercised in app-honest-controls.
  controller.state.eligibility = 'available';
  return { doc, controller, requests, timers, calls, client, postCallClient };
}

const agendaOf = (count) => Array.from({ length: count }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `Deal ${i}` }));

test('opening an active weekly call restores its session and publishes exact agenda context', async () => {
  const h = harness({ agenda: agendaOf(2), state: {
    state: 'recording', mode: 'weekly_deal_call', session: 'synthetic-active-call', started_at: '2026-09-23T15:00:00Z',
  } });
  try {
    await h.controller.open();
    assert.equal(h.controller.state.postCall.session, 'synthetic-active-call');
    assert.equal(h.calls.publishCallContext.length, 1);
    assert.equal(h.calls.publishCallContext[0].session, 'synthetic-active-call');
    assert.equal(h.calls.publishCallContext[0].deals.length, 2);
    assert.equal(h.doc.getElementById('callModeStop').hidden, false);
    assert.deepEqual(h.calls.toasts, []);
  } finally { h.controller.dispose(); }
});

test('opening a completed weekly call restores status and displays the review panel', async () => {
  const h = harness({ state: { state: 'ready_to_extract', mode: 'weekly_deal_call', session: 'synthetic-completed-call' },
    statuses: [{ status: { state: 'ready_review' }, report: { report: { summary: 'Synthetic call summary' } } }],
  });
  try {
    await h.controller.open();
    assert.deepEqual(h.calls.getStatus, ['synthetic-completed-call']);
    assert.equal(h.doc.getElementById('postCallPanel').hidden, false);
    assert.match(h.doc.getElementById('postCallReport').innerHTML, /Synthetic call summary/);
    assert.equal(h.calls.publishCallContext.length, 0);
    assert.deepEqual(h.calls.toasts, []);
  } finally { h.controller.dispose(); }
});

test('refresh without a supplied snapshot reads and recovers the companion session', async () => {
  const h = harness({ state: { state: 'ready_to_extract', mode: 'weekly_deal_call', session: 'synthetic-refresh-call' } });
  try {
    await h.controller.refresh();
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.calls.getStatus, ['synthetic-refresh-call']);
    assert.deepEqual(h.calls.toasts, []);
  } finally { h.controller.dispose(); }
});

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
  // The next read is armed once the first post-call read settles.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(timers.some((t) => t.ms === 1600 && !t.cleared), "the review is followed after Stop");
});

test("an active call keeps following its report while the tab is hidden, and stops when it settles", async () => {
  const { controller, doc, timers, calls } = harness({ agenda: agendaOf(1) });
  doc.getElementById("callModeConsent").checked = true;
  await controller.start("weekly_deal_call");
  await controller.stop();
  await new Promise((resolve) => setImmediate(resolve));
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  const live = () => timers.filter((t) => t.ms === 1600 && !t.cleared);
  assert.equal(live().length, 1, "hiding the tab does not stop the post-call poll");
  const before = calls.getStatus.length;
  live()[0].fired = true; live()[0].cleared = true;
  timers.filter((t) => t.fired)[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.getStatus.length, before + 1, "the hidden tick still reads the report");
  assert.equal(live().length, 1, "and re-arms exactly one timer");
  controller.stopPolling();
  assert.equal(live().length, 0, "once the call's report is done, nothing polls");
});

test("Close Call Mode only closes the dialog, as on main; the follow-through stops with stopPolling and never reads after", async () => {
  const { controller, doc, timers, calls } = harness({ agenda: agendaOf(1) });
  doc.getElementById("callModeConsent").checked = true;
  await controller.start("weekly_deal_call");
  await controller.stop();
  await new Promise((resolve) => setImmediate(resolve));
  const dialog = doc.getElementById("callModeDialog"); dialog.open = true;
  const live = () => timers.filter((t) => t.ms === 1600 && !t.cleared);
  assert.equal(await controller.handleClick(doc.getElementById("callModeClose")), true);
  assert.equal(dialog.open, false, "the declared observation: the dialog closes");
  assert.equal(live().length, 1, "closing leaves the post-call follow-through running, exactly as main's setInterval did");
  const armed = timers.filter((t) => t.ms === 1600);
  controller.stopPolling();
  assert.equal(live().length, 0, "stopping the follow-through clears its timer");
  const before = calls.getStatus.length;
  armed.forEach((t) => t.fn());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.getStatus.length, before, "a stale tick after stop reads nothing");
  assert.equal(live().length, 0, "and arms nothing");
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
  // The companion has not reported the automatic apply yet, so nothing is claimed as applied.
  assert.match(doc.getElementById("postCallStatus").innerHTML, /Call processed\. Applying the changes stated plainly/);
  assert.doesNotMatch(doc.getElementById("postCallStatus").innerHTML, /applied and listed/);
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

// The real sequence: the companion says ready_review first, then files the
// candidates and applies the plain ones; report.automatic marks the end.
function applyingThenApplied() {
  const update = { deal_id: "deal-a", deal_name: "Demo Bayside", summary: "LOI signed.", candidate_id: "note-a", candidate_status: "pending",
    next_step: { text: "Send the lease draft", next_date: "2026-11-06", candidate_id: null },
    phase_move: { value: "legal", started_on: null, needs_review: "Joe said legal and Dell said keep it.", candidate_id: null } };
  const first = { status: { state: "ready_review" }, report: { report: { summary: "Pipeline review." }, deal_updates: [update] } };
  const applied = structuredClone(first);
  Object.assign(applied.report.deal_updates[0].next_step, { candidate_id: "step-a", candidate_status: "confirmed", applied_automatically: true, apply: "automatic" });
  Object.assign(applied.report.deal_updates[0].phase_move, { candidate_id: "phase-a", candidate_status: "pending", apply: "review",
    review_reason: "Joe said legal and Dell said keep it." });
  applied.report.automatic = { finished_at: "2026-09-23T15:01:30Z", applied: 1, kept_for_review: 1 };
  return [first, applied];
}

test("Call Mode waits for the automatic apply before it claims or lists anything as applied", async () => {
  const h = harness({ statuses: applyingThenApplied() });
  const reads = [];
  h.client.readCallOutcomes = async () => { reads.push(1); return { calls: [{ session_id: "2026.09.23-1500", call_date: "2026-09-23",
    applied: [{ candidate_id: "step-a", kind: "next_step", deal_id: "deal-a", deal_name: "Demo Bayside", deal_version: 4,
      payload: { text: "Send the lease draft", next_date: "2026-11-06" }, evidence_quote: "send the lease draft by November 6", undone_at: null }],
    open_cards: [{ candidate_id: "phase-a", kind: "phase_move", deal_id: "deal-a" }] }] }; };
  try {
    h.controller.startPolling("2026.09.23-1500", { weekly: true });
    await new Promise((resolve) => setImmediate(resolve));
    const status = () => h.doc.getElementById("postCallStatus").innerHTML.replace(/<[^>]*>/g, "");
    assert.match(status(), /Applying the changes stated plainly/);
    assert.ok(h.controller.state.pollTimer, "still reading until the apply finishes");
    assert.equal(reads.length, 0, "no outcome read before candidates exist");
    await h.controller.refreshPostCall({ quiet: true });
    assert.equal(status(), "Call processed. 1 change applied and listed with Undo; 1 held change waits for Joe or Dell below.");
    assert.equal(h.controller.state.pollTimer, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads.length, 1);
    const outcomes = h.doc.getElementById("postCallOutcomes");
    assert.equal(outcomes.hidden, false);
    assert.match(outcomes.innerHTML, /Applied from the Sep 23 pipeline call/);
    assert.match(outcomes.innerHTML, /due Nov 6/);
    const report = h.doc.getElementById("postCallReport").innerHTML;
    assert.doesNotMatch(report, /Send the lease draft/, "the applied step is listed once, in the applied section");
    assert.match(report, /Proposed phase/, "the held phase move is shown with its reason");
    assert.match(report, /Move to Legal/);
    assert.match(report, /Joe said legal and Dell said keep it\./);
    assert.match(report, /data-post-call-confirm="phase-a"/);
    // Undo inside Call Mode goes through its own click routing with the deal version.
    const undone = [];
    h.client.undoCallChange = async (args) => { undone.push(args); };
    await h.controller.handleClick(drawnButton(outcomes.innerHTML, "data-call-undo", "step-a"));
    assert.deepEqual(undone, [{ candidate_id: "step-a", base_version: 4 }]);
    assert.ok(h.calls.toasts.includes("Change undone."));
  } finally { h.controller.dispose(); }
});

test("deal cards drop the companion's raw change lines and show each change once, formatted", async () => {
  // The exact summary carr-system's report_for_deal_room sends: the change is
  // appended to the summary as raw lines.
  const held = { status: { state: "ready_review" }, report: { report: { summary: "Pipeline review." },
    automatic: { finished_at: "2026-09-23T15:01:30Z", applied: 0, kept_for_review: 2 },
    deal_updates: [{ deal_id: "deal-a", deal_name: "Demo Bayside", candidate_id: "note-a", candidate_status: "confirmed",
      summary: "LOI signed.\nMove phase to: due_diligence (started 2026-10-20)\nReplace next step with: Send the lease draft\nNext date: 2026-11-03",
      phase_move: { value: "due_diligence", started_on: "2026-10-20", candidate_id: "phase-a", candidate_status: "pending", apply: "review", review_reason: "Dell did not agree." },
      next_step: { text: "Send the lease draft", next_date: "2026-11-03", candidate_id: "step-a", candidate_status: "pending", apply: "review", review_reason: "Dell did not agree." } }] } };
  const h = harness({ statuses: [held] });
  try {
    h.controller.startPolling("2026.09.23-1500", { weekly: true });
    await new Promise((resolve) => setImmediate(resolve));
    const report = h.doc.getElementById("postCallReport").innerHTML;
    assert.doesNotMatch(report, /due_diligence|2026-10-20|2026-11-03|Move phase to:|Replace next step with:/);
    assert.match(report, /<p>LOI signed\.<\/p>/);
    assert.match(report, /Move to Diligence, started Sep 20|Move to Diligence, started Oct 20/);
    assert.match(report, /Next date: Nov 3/);
    assert.equal(report.split("Send the lease draft").length - 1, 1, "the step appears once");
  } finally { h.controller.dispose(); }
});

test("Call Mode stops waiting after three minutes and still claims nothing", async () => {
  let at = Date.parse("2026-09-23T15:01:05Z");
  const [first] = applyingThenApplied();
  const h = harness({ statuses: [first], now: () => at });
  try {
    h.controller.startPolling("2026.09.23-1500", { weekly: true });
    await new Promise((resolve) => setImmediate(resolve));
    at += 3 * 60 * 1000;
    await h.controller.refreshPostCall({ quiet: true });
    assert.equal(h.controller.state.pollTimer, null);
    assert.match(h.doc.getElementById("postCallStatus").innerHTML, /not been confirmed as applied yet\. Press ↻ to check again\./);
  } finally { h.controller.dispose(); }
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

test('uncertain candidate approval replays one retained request and blocks a changed decision', async () => {
  const { html, calls, controller, client } = await reviewReady();
  const sent = []; let lost = true;
  client.resolvePostCallCandidate = async args => {
    sent.push(structuredClone(args));
    if (lost) { lost = false; throw new Error('reply lost after commit'); }
    return { ok: true, replayed: true };
  };
  try {
    await controller.handleClick(drawnButton(html, 'data-post-call-confirm', 'cand-joe'));
    await controller.handleClick(drawnButton(html, 'data-post-call-skip', 'cand-joe'));
    assert.equal(sent.length, 1, 'an uncertain yes cannot become a new no');
    await controller.handleClick(drawnButton(html, 'data-post-call-confirm', 'cand-joe'));
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0], sent[1]);
    assert.match(calls.toasts[0], /unknown|confirmed|reply lost/i);
  } finally { controller.dispose(); }
});

test('a call next step has its own decision after the note is confirmed', async () => {
  const report = structuredClone(REPORT);
  report.report.deal_updates[0] = {
    candidate_id: 'note-candidate', candidate_status: 'confirmed', summary: 'Landlord follow-up agreed.',
    deal_name: 'Demo Deal', next_step: { text: 'Call Vendor A', next_date: '2028-02-29', candidate_id: 'step-candidate', candidate_status: 'pending' },
  };
  const h = harness({ statuses: [report] });
  try {
    h.controller.startPolling('synthetic-call', { weekly: true });
    await new Promise(setImmediate);
    const html = h.doc.getElementById('postCallReport').innerHTML;
    assert.match(html, /Call Vendor A/);
    assert.match(html, /Next date: Feb 29/);
    assert.doesNotMatch(html, /data-post-call-confirm="note-candidate"/);
    assert.deepEqual(h.calls.resolveConfirm, []);
    await h.controller.handleClick(drawnButton(html, 'data-post-call-confirm', 'step-candidate'));
    assert.deepEqual(h.calls.resolveConfirm.map(({ proposal_id, accept }) => ({ proposal_id, accept })), [{ proposal_id: 'step-candidate', accept: true }]);
    assert.deepEqual(h.calls.resolvePostCallCandidate, []);
    assert.deepEqual(h.calls.createOutlookDraft, []);
  } finally { h.controller.dispose(); }
});

test('call next-step retries retain the original decision and stale refusals leave the proposal pending', async () => {
  const report = structuredClone(REPORT);
  report.report.deal_updates[0].next_step = { text: 'Call Vendor A', next_date: null, candidate_id: 'step-candidate' };
  const h = harness({ statuses: [report] });
  const sent = [];
  h.client.resolveConfirm = async args => {
    sent.push(structuredClone(args));
    if (sent.length === 1) throw new Error('Reply lost');
    throw Object.assign(new Error('Deal changed. Refresh before confirming.'), { payload: { error: 'field_conflict' } });
  };
  try {
    h.controller.startPolling('synthetic-call', { weekly: true });
    await new Promise(setImmediate);
    const html = h.doc.getElementById('postCallReport').innerHTML;
    assert.match(html, /Confirming clears the current date/);
    await h.controller.handleClick(drawnButton(html, 'data-post-call-confirm', 'step-candidate'));
    await h.controller.handleClick(drawnButton(html, 'data-post-call-skip', 'step-candidate'));
    assert.equal(sent.length, 1);
    await h.controller.handleClick(drawnButton(html, 'data-post-call-confirm', 'step-candidate'));
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0], sent[1]);
    assert.match(sent[0].idempotency_key, /^[0-9a-f-]{36}$/);
    assert.match(h.calls.toasts.at(-1), /Deal changed/);
    assert.match(h.doc.getElementById('postCallReport').innerHTML, /data-post-call-confirm="step-candidate"/);
    assert.deepEqual(h.calls.syncStatus, []);
  } finally { h.controller.dispose(); }
});

for (const status of ['confirmed', 'skipped', 'rejected', 'unfiled', 'needs_review']) {
  test(`a ${status} call next step stays visible without decision controls`, async () => {
    const report = structuredClone(REPORT);
    report.report.deal_updates[0].next_step = { text: '<Call Vendor A>', next_date: null, candidate_status: status,
      ...(status === 'needs_review' ? {} : { candidate_id: 'step-candidate' }) };
    const h = harness({ statuses: [report] });
    try {
      h.controller.startPolling('synthetic-call', { weekly: true });
      await new Promise(setImmediate);
      const html = h.doc.getElementById('postCallReport').innerHTML;
      assert.match(html, /&lt;Call Vendor A&gt;/);
      assert.match(html, new RegExp(`>${status.replaceAll('_', ' ')}<`));
      assert.doesNotMatch(html, /data-post-call-(?:confirm|skip)="step-candidate"/);
      assert.deepEqual(h.calls.resolveConfirm, []);
    } finally { h.controller.dispose(); }
  });
}

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
  assert.match((await import("../js/navigation.js")).appShellMarkup("/"), /id="callModeButton"[^>]*aria-label="Call mode"[^>]*aria-haspopup="dialog"[^>]*hidden/);
  assert.match(html, /<dialog id="callModeDialog"[^>]*aria-labelledby="callModeTitle"/);
  assert.match(html, /<input type="checkbox" id="callModeConsent">/, "consent is an unticked checkbox");
  assert.match(html, /I have told everyone on this call that it will be recorded\./);
  assert.match(html, /data-call-mode-start="weekly_deal_call">Start weekly Joe \+ Dell deal call</);
  assert.match(html, /data-call-mode-start="other_call">Start another call</);
  assert.match(html, /id="callModeStop" hidden>Stop and process</);
  assert.match(html, /<section class="post-call" id="postCallPanel"[^>]*hidden>/);
  assert.match(html, /stated plainly on a weekly pipeline call are applied to the deal and listed with Undo; anything unsettled waits for Joe or Dell\. No email draft is created until Joe or Dell approves it\./);
  assert.doesNotMatch(html, /id="callsButton"|not part of this release/, "the inert Calls notice is gone");
  assert.match(html, /<tbody id="rows">/, "the sentinel the shell boots on");
  assert.equal((html.match(/<script/g) || []).length, 3, "theme boot, app, and shared shell scripts are self-hosted");
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

test('shared weekly Call mode records with consent without claiming a page agenda opened',async()=>{
 const {controller,doc,calls,requests}=harness({agenda:agendaOf(2),withAgenda:false});
 doc.getElementById('callModeConsent').checked=true;
 await controller.handleClick(doc.querySelector('[data-call-mode-start="weekly_deal_call"]'));
 assert.equal(requests.filter(request=>request.url.endsWith('/api/start')).length,1);
 assert.equal(calls.publishCallContext.length,1);assert.equal(calls.startAgenda,0);
 assert.ok(calls.toasts.includes('Weekly deal call is recording.'));assert.ok(calls.toasts.every(text=>!text.includes('agenda is open')));
 assert.equal(controller.state.postCall.status,'context_ready');
});


test('a handled agenda failure does not claim that the agenda opened while recording',async()=>{
 const h=harness({agenda:agendaOf(1),agendaResult:false});
 h.doc.getElementById('callModeConsent').checked=true;
 try{
  await h.controller.start('weekly_deal_call');
  assert.ok(h.calls.toasts.some(message=>message.includes('agenda could not open')));
  assert.ok(h.calls.toasts.every(message=>!message.includes('agenda is open')));
 }finally{h.controller.dispose();}
});

for (const width of [390, 1280]) test(`next-step decisions in the rendered call report at ${width}px`, async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 960 }, reducedMotion: 'reduce' });
  const dialog = (await file('index.html')).match(/<dialog id="callModeDialog"[\s\S]*?<\/dialog>/)[0];
  await page.route(`${server.origin}/next-step-review`, route => route.fulfill({ contentType: 'text/html',
    body: `<html data-theme="${width === 390 ? 'light' : 'dark'}"><head><meta charset="utf-8"><link rel="stylesheet" href="/css/app.css"><link rel="stylesheet" href="/css/app-shell.css"></head><body>${dialog}</body></html>` }));
  await page.goto(`${server.origin}/next-step-review`);
  await page.evaluate(async () => {
    const { createCallMode } = await import('/js/call-mode.js');
    const update = { deal_name: 'Demo Surgical Practice', summary: 'Landlord follow-up agreed.',
      candidate_id: 'note-candidate', candidate_status: 'pending',
      next_step: { text: 'Call Vendor A', next_date: null, candidate_id: 'step-candidate', candidate_status: 'pending' } };
    window.stepDecisions = [];
    const ui = createCallMode({ root: document,
      client: () => ({ selfActor: 'joe', resolveConfirm: async request => {
        window.stepDecisions.push(request);
        update.next_step.candidate_status = request.accept ? 'confirmed' : 'skipped';
        return { status: 'ok' };
      } }),
      postCallClient: { getStatus: async () => ({ status: 'ready_review', report: { deal_updates: [update] } }), syncStatus: async () => {} } });
    ui.state.eligibility = 'available'; ui.state.postCall.session = 'synthetic-call';
    await ui.refreshPostCall();
    document.querySelector('#callModeDialog').showModal();
    document.addEventListener('click', event => ui.handleClick(event.target));
  });
  const proposal = page.getByRole('region', { name: 'Proposed next step' });
  await proposal.getByRole('button', { name: 'Confirm next step', exact: true }).waitFor();
  assert.equal(await proposal.getByText('Call Vendor A', { exact: true }).isVisible(), true);
  assert.match(await proposal.textContent(), /Confirming clears the current date/);
  assert.deepEqual(await page.evaluate(() => window.stepDecisions), []);
  await mkdir('out/test-artifacts/call-next-step', { recursive: true });
  await proposal.locator('..').screenshot({ path: `out/test-artifacts/call-next-step/${width}-pending.png` });
  const accept = width === 390;
  await proposal.getByRole('button', { name: accept ? 'Confirm next step' : 'Skip next step', exact: true }).click();
  await proposal.getByText(accept ? 'confirmed' : 'skipped', { exact: true }).waitFor();
  assert.deepEqual((await page.evaluate(() => window.stepDecisions)).map(c => [c.proposal_id, c.accept]), [['step-candidate', accept]]);
  assert.equal(await proposal.getByRole('button').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Confirm update', exact: true }).isVisible(), true);
  assert.equal(await page.getByText('Landlord follow-up agreed.', { exact: true }).isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
