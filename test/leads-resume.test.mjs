import test from "node:test";
import assert from "node:assert/strict";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const tool = (payload) => ({ ok: true, status: 200, json: async () => ({ result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }) });

function surface(fetchImpl) {
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
    querySelector() { return { focus() {} }; }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close?.(); }
  }
  const document = {
    visibilityState: "visible",
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Node(id)); return nodes.get(id); },
    addEventListener(name, fn) { listeners.set(`document:${name}`, fn); },
  };
  const window = { addEventListener(name, fn) { listeners.set(`window:${name}`, fn); } };
  const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  globalThis.document = document; globalThis.window = window; globalThis.fetch = fetchImpl;
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

test("an open candidate decision defers return reads until the dialog closes", async () => {
  let reads = 0;
  const view = surface(async (_path, init) => {
    const { name } = JSON.parse(init.body).params;
    reads++;
    return tool(name === "lead-board" ? board("One") : claims("One"));
  });
  try {
    await import(`../js/leads-app.js?return=dialog`);
    await tick();
    view.node("claimDialog").open = true;
    view.visibility("hidden"); view.visibility("visible");
    await tick();
    assert.equal(reads, 2, "the open decision remains stable");
    view.node("claimDialog").close();
    await tick(); await tick();
    assert.equal(reads, 4, "the deferred return reads after the decision closes");
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
    assert.equal(view.node("leadBoardError").hidden, false);
    assert.equal(view.node("claimError").hidden, false);
  } finally { view.restore(); }
});
