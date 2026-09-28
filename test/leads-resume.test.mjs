import test from "node:test";
import assert from "node:assert/strict";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const tool = (payload) => ({ ok: true, status: 200, json: async () => ({ result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }) });

function surface(fetchImpl, { actor = () => "joe" } = {}) {
  const nodes = new Map();
  const listeners = new Map();
  class Node {
    constructor(id) {
      this.id = id; this.listeners = {}; this.innerHTML = ""; this.textContent = "";
      this.hidden = false; this.open = false; this.value = ""; this.attributes = {};
      this.classList = { toggle() {} };
    }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    querySelector(selector) { return selector === "form" ? this.form : { focus() {} }; }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close?.(); }
  }
  const document = {
    visibilityState: "visible",
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Node(id)); return nodes.get(id); },
    addEventListener(name, fn) { listeners.set(`document:${name}`, fn); },
  };
  const window = { addEventListener(name, fn) { listeners.set(`window:${name}`, fn); } };
  const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, FormData: globalThis.FormData };
  globalThis.document = document; globalThis.window = window;
  globalThis.fetch = (path, init) => JSON.parse(init.body).params.name === "deal-room-board"
    ? Promise.resolve(actor()).then((value) => tool({ actor: value })) : fetchImpl(path, init);
  globalThis.FormData = class { constructor(form) { this.form = form; } *entries() { yield ["reason", this.form.reason]; } };
  return {
    node: (id) => document.getElementById(id),
    visibility(value) { document.visibilityState = value; listeners.get("document:visibilitychange")(); },
    pageshow(persisted) { listeners.get("window:pageshow")({ persisted }); },
    restore() { Object.assign(globalThis, previous); },
  };
}

function board(name) {
  return { generated_at: "2026-09-28T03:00:00Z", stages: [{ slug: "new", label: "New", sort: 1 }], leads: [{ id: `lead-${name}`, name, stage: "new" }] };
}
function claims(name) {
  return { claimable: 1, needs_contact_count: 0, candidates: [{ pool_id: `pool-${name}`, display_name: name, base_version: 1 }] };
}

test("returning to Lead Board reads fresh leads and candidates once, preserving the search filter", async () => {
  let boardReads = 0; let claimReads = 0;
  const view = surface(async (_path, init) => {
    const { name } = JSON.parse(init.body).params;
    if (name === "lead-board") return tool(board(++boardReads === 1 ? "Old" : "New"));
    if (name === "claim-card") return tool(claims(++claimReads === 1 ? "Old" : "New"));
    throw new Error(`Unexpected ${name}`);
  });
  try {
    await import(`../js/leads-app.js?return=reads`);
    await tick();
    view.node("leadSearch").value = "New";
    view.node("leadSearch").listeners.input({ target: view.node("leadSearch") });
    view.visibility("hidden"); view.visibility("visible"); view.pageshow(true);
    await tick(); await tick();
    assert.equal(boardReads, 2);
    assert.equal(claimReads, 2);
    assert.match(view.node("leadBoard").innerHTML, /New/);
    assert.match(view.node("claimCards").innerHTML, /New/);
    assert.equal(view.node("leadSearch").value, "New");
  } finally { view.restore(); }
});

test("an open candidate decision is hidden during recheck and restored only from the fresh card", async () => {
  let reads = 0;
  const view = surface(async (_path, init) => {
    const { name } = JSON.parse(init.body).params;
    reads++;
    return tool(name === "lead-board" ? board("One") : claims("One"));
  });
  try {
    await import(`../js/leads-app.js?return=dialog`);
    await tick();
    const trigger = { dataset: { claimOpen: "decline", poolId: "pool-One" }, focus() {} };
    view.node("claimCards").listeners.click({ target: { closest: () => trigger } });
    const draft = view.node("claimDialogBody").innerHTML;
    assert.equal(view.node("claimDialog").open, true);
    view.visibility("hidden"); view.visibility("visible");
    await tick(); await tick();
    assert.equal(reads, 4, "the board and candidate card are reread immediately");
    assert.equal(view.node("claimDialog").open, true, "only the matching fresh candidate restores the draft");
    assert.equal(view.node("claimDialogBody").innerHTML, draft);
  } finally { view.restore(); }
});

test("older Lead Board reads cannot repaint a newer manual refresh", async () => {
  let resolveOld; let boardReads = 0;
  const view = surface(async (_path, init) => {
    const { name } = JSON.parse(init.body).params;
    if (name === "claim-card") return tool(claims("One"));
    boardReads++;
    if (boardReads === 2) return new Promise((resolve) => { resolveOld = resolve; });
    return tool(board(boardReads === 1 ? "Initial" : "Newest"));
  });
  try {
    await import(`../js/leads-app.js?return=race`);
    await tick();
    view.visibility("hidden"); view.visibility("visible");
    await tick();
    view.node("refreshBoard").listeners.click();
    await tick();
    resolveOld(tool(board("Stale")));
    await tick();
    assert.match(view.node("leadBoard").innerHTML, /Newest/);
    assert.doesNotMatch(view.node("leadBoard").innerHTML, /Stale/);
  } finally { view.restore(); }
});

test("failed return reads clear previous lead and candidate cards", async () => {
  let calls = 0;
  const view = surface(async (_path, init) => {
    const { name } = JSON.parse(init.body).params;
    calls++;
    if (calls > 2) throw new Error("synthetic network outage");
    return tool(name === "lead-board" ? board("Previous") : claims("Previous"));
  });
  try {
    await import(`../js/leads-app.js?return=failure`);
    await tick();
    assert.match(view.node("leadBoard").innerHTML, /Previous/);
    assert.match(view.node("claimCards").innerHTML, /Previous/);
    view.visibility("hidden"); view.visibility("visible");
    await tick(); await tick();
    assert.doesNotMatch(view.node("leadBoard").innerHTML, /Previous/);
    assert.doesNotMatch(view.node("claimCards").innerHTML, /Previous/);
    assert.doesNotMatch(view.node("leadCount").textContent, /Previous|1 total/);
    assert.doesNotMatch(view.node("filterSummary").textContent, /Previous|1 of 1/);
    assert.doesNotMatch(view.node("ownerFilter").innerHTML, /Previous/);
    assert.equal(view.node("pipelineNodes").innerHTML, "");
    assert.equal(view.node("leadBoardError").hidden, false);
    assert.equal(view.node("claimError").hidden, false);
  } finally { view.restore(); }
});

test("a candidate removed while away cannot reopen its prior decision popup", async () => {
  let claimReads = 0;
  const view = surface(async (_path, init) => {
    const { name } = JSON.parse(init.body).params;
    if (name === "lead-board") return tool(board("Current"));
    claimReads++;
    return tool(claimReads === 1 ? claims("Previous") : { claimable: 0, needs_contact_count: 0, candidates: [] });
  });
  try {
    await import(`../js/leads-app.js?return=changed-candidate`);
    await tick();
    const trigger = { dataset: { claimOpen: "decline", poolId: "pool-Previous" }, focus() {} };
    view.node("claimCards").listeners.click({ target: { closest: () => trigger } });
    assert.equal(view.node("claimDialog").open, true);
    view.visibility("hidden"); view.visibility("visible");
    await tick(); await tick();
    assert.equal(view.node("claimDialog").open, false);
    assert.doesNotMatch(view.node("claimCards").innerHTML, /Previous/);
    assert.match(view.node("claimError").textContent, /changed or left/);
  } finally { view.restore(); }
});

test("an unknown decision does not prevent a safe return read or lose its exact retry", async () => {
  let reads = 0; let writes = 0;
  const view = surface(async (_path, init) => {
    const { name } = JSON.parse(init.body).params;
    if (name === "lead-board") { reads++; return tool(board("One")); }
    if (name === "claim-card") { reads++; return tool(claims("One")); }
    writes++;
    throw new Error("synthetic lost response");
  });
  try {
    await import(`../js/leads-app.js?return=unknown-decision`);
    await tick();
    const trigger = { dataset: { claimOpen: "decline", poolId: "pool-One" }, focus() {} };
    view.node("claimCards").listeners.click({ target: { closest: () => trigger } });
    const button = { disabled: false, textContent: "Decline", type: "submit", focus() {} };
    const form = { dataset: { claimAction: "decline", poolId: "pool-One" }, reason: "Synthetic reason", elements: [button], querySelector() { return button; } };
    view.node("claimDialogBody").form = form;
    view.node("claimDialog").listeners.submit({ target: { closest: () => form }, preventDefault() {} });
    await tick();
    assert.equal(button.textContent, "Retry same request");
    view.visibility("hidden"); view.visibility("visible");
    await tick(); await tick();
    assert.equal(reads, 4, "pending outcome cannot stop authorized read-only refresh");
    assert.equal(view.node("claimDialog").open, true);
    assert.equal(button.textContent, "Retry same request");
    assert.equal(writes, 1, "return never resends the mutation");
  } finally { view.restore(); }
});

test("an unresolved decision remains recoverable without exposing an old candidate", async () => {
  let claimReads = 0;
  const writes = [];
  const view = surface(async (_path, init) => {
    const { name, arguments: args } = JSON.parse(init.body).params;
    if (name === "lead-board") return tool(board("Current"));
    if (name === "claim-card") return tool(++claimReads === 1 ? claims("Previous") : { claimable: 0, needs_contact_count: 0, candidates: [] });
    writes.push(args);
    if (writes.length === 1) throw new Error("synthetic lost response");
    return tool({ ok: true });
  });
  try {
    await import(`../js/leads-app.js?return=pending-removed`);
    await tick();
    const trigger = { dataset: { claimOpen: "decline", poolId: "pool-Previous" }, focus() {} };
    view.node("claimCards").listeners.click({ target: { closest: () => trigger } });
    const button = { disabled: false, textContent: "Decline", type: "submit", focus() {} };
    const form = { dataset: { claimAction: "decline", poolId: "pool-Previous" }, reason: "Synthetic reason", elements: [button], querySelector() { return button; } };
    view.node("claimDialogBody").form = form;
    view.node("claimDialog").listeners.submit({ target: { closest: () => form }, preventDefault() {} });
    await tick();
    view.visibility("hidden"); view.visibility("visible");
    await tick(); await tick();
    assert.equal(view.node("claimDialog").open, false);
    assert.doesNotMatch(view.node("claimCards").innerHTML, /Previous/);
    assert.match(view.node("claimCards").innerHTML, /Retry unresolved decision/);
    const recovery = { dataset: { retryPending: "" }, disabled: false, textContent: "Retry unresolved decision" };
    view.node("claimCards").listeners.click({ target: { closest: (selector) => selector === "[data-retry-pending]" ? recovery : null } });
    await tick(); await tick();
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1], writes[0], "recovery uses the original idempotency key and request");
    assert.doesNotMatch(view.node("claimCards").innerHTML, /Retry unresolved decision/);
  } finally { view.restore(); }
});

test("another signed-in actor cannot see or replay an unresolved prior decision", async () => {
  let actor = "joe";
  let claimReads = 0;
  const writes = [];
  const view = surface(async (_path, init) => {
    const { name, arguments: args } = JSON.parse(init.body).params;
    if (name === "lead-board") return tool(board("Current"));
    if (name === "claim-card") return tool(++claimReads === 1 ? claims("Previous") : { claimable: 0, needs_contact_count: 0, candidates: [] });
    writes.push(args);
    throw new Error("synthetic lost response");
  }, { actor: () => actor });
  try {
    await import(`../js/leads-app.js?return=actor-switch`);
    await tick();
    const trigger = { dataset: { claimOpen: "decline", poolId: "pool-Previous" }, focus() {} };
    view.node("claimCards").listeners.click({ target: { closest: () => trigger } });
    const button = { disabled: false, textContent: "Decline", type: "submit", focus() {} };
    const form = { dataset: { claimAction: "decline", poolId: "pool-Previous" }, reason: "Synthetic reason", elements: [button], querySelector() { return button; } };
    view.node("claimDialogBody").form = form;
    view.node("claimDialog").listeners.submit({ target: { closest: () => form }, preventDefault() {} });
    await tick();
    assert.equal(writes.length, 1);
    actor = "dell";
    view.visibility("hidden"); view.visibility("visible");
    await tick(); await tick();
    assert.equal(view.node("claimDialog").open, false);
    assert.doesNotMatch(view.node("claimCards").innerHTML, /Previous|Retry unresolved decision/);
    assert.match(view.node("claimError").textContent, /account changed/);
    assert.equal(writes.length, 1, "return never retries the previous actor's request");
  } finally { view.restore(); }
});

test("another actor can decide a fresh candidate while the prior actor's retry stays sealed", async () => {
  let actor = "joe";
  const writes = [];
  const view = surface(async (_path, init) => {
    const { name, arguments: args } = JSON.parse(init.body).params;
    if (name === "lead-board") return tool(board("Current"));
    if (name === "claim-card") return tool(claims(actor === "joe" ? "Old" : "New"));
    writes.push(args);
    if (writes.length === 1) throw new Error("synthetic lost response");
    return tool({ ok: true });
  }, { actor: () => actor });
  try {
    await import(`../js/leads-app.js?return=actor-new-decision`);
    await tick();
    const open = (name) => view.node("claimCards").listeners.click({ target: { closest: () => ({ dataset: { claimOpen: "decline", poolId: `pool-${name}` }, focus() {} }) } });
    const submit = (name) => {
      const button = { disabled: false, textContent: "Decline", type: "submit", focus() {} };
      const form = { dataset: { claimAction: "decline", poolId: `pool-${name}` }, reason: "Synthetic reason", elements: [button], querySelector() { return button; } };
      view.node("claimDialogBody").form = form;
      view.node("claimDialog").listeners.submit({ target: { closest: () => form }, preventDefault() {} });
    };
    open("Old"); submit("Old"); await tick();
    actor = "dell";
    view.visibility("hidden"); view.visibility("visible"); await tick(); await tick();
    assert.doesNotMatch(view.node("claimCards").innerHTML, /Old|Retry unresolved decision/);
    open("New"); submit("New"); await tick(); await tick();
    assert.equal(writes.length, 2);
    assert.equal(writes[1].pool_id, "pool-New");
    assert.equal(view.node("claimDialog").open, false);
  } finally { view.restore(); }
});

test("a return fences a prior actor verification before any decision is sent", async () => {
  let actor = "joe"; let actorReads = 0; let resolveOldActor;
  const writes = [];
  const view = surface(async (_path, init) => {
    const { name, arguments: args } = JSON.parse(init.body).params;
    if (name === "lead-board") return tool(board(actor));
    if (name === "claim-card") return tool(claims(actor));
    writes.push(args); return tool({ ok: true });
  }, { actor: () => ++actorReads === 2 ? new Promise((resolve) => { resolveOldActor = resolve; }) : actor });
  try {
    await import(`../js/leads-app.js?return=actor-read-race`);
    await tick();
    view.node("claimCards").listeners.click({ target: { closest: () => ({ dataset: { claimOpen: "decline", poolId: "pool-joe" }, focus() {} }) } });
    const button = { disabled: false, textContent: "Decline" };
    const form = { dataset: { claimAction: "decline", poolId: "pool-joe" }, reason: "Synthetic reason", elements: [button], querySelector() { return button; } };
    view.node("claimDialogBody").form = form;
    view.node("claimDialog").listeners.submit({ target: { closest: () => form }, preventDefault() {} });
    await tick();
    actor = "dell";
    view.visibility("hidden"); view.visibility("visible");
    resolveOldActor("joe");
    await tick(); await tick();
    assert.equal(writes.length, 0, "old identity completion cannot send under the new cookie");
    assert.doesNotMatch(view.node("claimCards").innerHTML, /joe/);
  } finally { view.restore(); }
});

test("a prior actor's in-flight result cannot close the new actor's decision", async () => {
  let actor = "joe"; let resolveOldDecision;
  const view = surface(async (_path, init) => {
    const { name } = JSON.parse(init.body).params;
    if (name === "lead-board") return tool(board(actor));
    if (name === "claim-card") return tool(claims(actor));
    return new Promise((resolve) => { resolveOldDecision = resolve; });
  }, { actor: () => actor });
  try {
    await import(`../js/leads-app.js?return=decision-result-race`);
    await tick();
    const open = (name) => view.node("claimCards").listeners.click({ target: { closest: () => ({ dataset: { claimOpen: "decline", poolId: `pool-${name}` }, focus() {} }) } });
    open("joe");
    const button = { disabled: false, textContent: "Decline" };
    const form = { dataset: { claimAction: "decline", poolId: "pool-joe" }, reason: "Synthetic reason", elements: [button], querySelector() { return button; } };
    view.node("claimDialogBody").form = form;
    view.node("claimDialog").listeners.submit({ target: { closest: () => form }, preventDefault() {} });
    await tick();
    actor = "dell";
    view.visibility("hidden"); view.visibility("visible");
    await tick(); await tick();
    open("dell");
    assert.equal(view.node("claimDialog").open, true);
    resolveOldDecision(tool({ ok: true }));
    await tick(); await tick();
    assert.equal(view.node("claimDialog").open, true, "A's completion cannot close B's popup");
    assert.match(view.node("claimDialogTitle").textContent, /dell/);
    assert.doesNotMatch(view.node("moveAnnouncement").textContent, /joe|Candidate declined/);
  } finally { view.restore(); }
});
