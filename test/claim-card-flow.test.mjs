import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const response = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });
const tool = (payload, isError = false) => response({ result: { isError, content: [{ type: "text", text: JSON.stringify(payload) }] } });

function surface(fetchImpl) {
  const nodes = new Map();
  class Node {
    constructor(id) { this.id = id; this.listeners = {}; this.innerHTML = ""; this.textContent = ""; this.hidden = false; this.open = false; this.classList = { toggle() {} }; this.attributes = {}; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close?.(); }
    querySelector(selector) { return selector === "form" ? this.form : { focus() {} }; }
  }
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Node(id)); return nodes.get(id); }, activeElement: null };
  const previous = { document: globalThis.document, fetch: globalThis.fetch, FormData: globalThis.FormData };
  globalThis.document = document;
  globalThis.fetch = (path, init) => JSON.parse(init.body).params.name === "deal-room-board"
    ? tool({ actor: "joe" }) : fetchImpl(path, init);
  globalThis.FormData = class { constructor(form) { this.form = form; } *entries() { yield ["reason", this.form.reason]; } };
  return { nodes, node: id => document.getElementById(id), restore() { globalThis.document = previous.document; globalThis.fetch = previous.fetch; globalThis.FormData = previous.FormData; } };
}

function declineForm() {
  const button = { disabled: false, textContent: "Decline", type: "submit", focus() {} };
  return { dataset: { claimAction: "decline", poolId: "synthetic-pool" }, reason: "Outside our territory", elements: [button], querySelector() { return button; }, button };
}

async function load(surfaceId) {
  await import(`../js/leads-app.js?synthetic=${surfaceId}`);
  await tick();
}
function submit(node, form) {
  node.listeners.submit({ target: { closest: () => form }, preventDefault() {} });
}
function open(view, form) {
  view.node("claimDialogBody").form = form;
  const trigger = { dataset: { claimOpen: "decline", poolId: "synthetic-pool" }, focused: false, focus() { this.focused = true; } };
  view.node("claimCards").listeners.click({ target: { closest: () => trigger } });
  return trigger;
}

for (const [label, result] of [
  ["broken outer JSON", { ok: true, status: 200, json: async () => { throw new Error("broken JSON"); } }],
  ["missing result", response({ jsonrpc: "2.0", id: 3 })],
  ["HTTP 503", response({ error: "carr_unavailable" }, 503)],
  ["null nested content", response({ result: { content: [null] } })],
  ["nonfunction content find", response({ result: { content: { find: 1 } } })],
]) {
  test(`app keeps exact pending decline after ${label}`, async () => {
    const writes = [];
    const view = surface(async (_path, init) => {
      const { name, arguments: args } = JSON.parse(init.body).params;
      if (name === "lead-board") return tool({ generated_at: "2026-09-27T12:00:00Z", stages: [], leads: [] });
      if (name === "claim-card") return tool({ claimable: 1, needs_contact_count: 0, candidates: [{ pool_id: "synthetic-pool", base_version: 2 }] });
      writes.push(args);
      return writes.length === 1 ? result : tool({ ok: true });
    });
    try {
      await load(label.replaceAll(" ", "-"));
      const form = declineForm();
      open(view, form);
      submit(view.node("claimDialog"), form);
      await tick();
      assert.equal(view.node("moveAnnouncement").textContent, "", "unknown result cannot announce success");
      assert.equal(form.button.textContent, "Retry same request");
      submit(view.node("claimDialog"), form);
      await tick();
      assert.equal(writes.length, 2);
      assert.deepEqual(writes[1], writes[0], "retry reuses the exact request and idempotency key");
    } finally { view.restore(); }
  });
}

test("late candidate read cannot hide an unknown decision or remove its retry", async () => {
  let resolveLate;
  let cardReads = 0;
  const writes = [];
  const view = surface(async (_path, init) => {
    const { name, arguments: args } = JSON.parse(init.body).params;
    if (name === "lead-board") return tool({ generated_at: "2026-09-27T12:00:00Z", stages: [], leads: [] });
    if (name === "claim-card") {
      cardReads++;
      if (cardReads === 2) return new Promise(resolve => { resolveLate = resolve; });
      return tool({ claimable: 1, needs_contact_count: 0, candidates: [{ pool_id: "synthetic-pool", base_version: 2 }] });
    }
    writes.push(args);
    return writes.length === 1 ? { ok: true, status: 200, json: async () => { throw new Error("lost response"); } } : tool({ ok: true });
  });
  try {
    await load("late-refresh");
    view.node("refreshClaims").listeners.click();
    const form = declineForm();
    open(view, form);
    submit(view.node("claimDialog"), form);
    await tick();
    resolveLate(tool({ claimable: 0, needs_contact_count: 0, candidates: [] }));
    await tick();
    assert.equal(view.node("claimError").hidden, false);
    assert.match(view.node("claimCards").innerHTML, /synthetic-pool/);
    submit(view.node("claimDialog"), form);
    await tick();
    assert.equal(writes.length, 2, "retry remains callable after the late read");
    assert.deepEqual(writes[1], writes[0]);
  } finally { view.restore(); }
});

test("Claim Card uses title-only heading and focused popup forms", async () => {
  const html = await readFile(new URL("../leads.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../js/leads-app.js", import.meta.url), "utf8");
  assert.match(html, /<h2 id="claimHeading">Claim Card<\/h2><\/div>/);
  assert.match(html, /<dialog id="claimDialog"/);
  assert.doesNotMatch(app, /<details>/);
  assert.match(app, /showModal\(\)/);
  assert.match(app, /\.focus\(\)/);
});

test("closing the decision popup returns keyboard focus to its candidate action", async () => {
  const view = surface(async (_path, init) => {
    const { name } = JSON.parse(init.body).params;
    return name === "lead-board" ? tool({ generated_at: "2026-09-27T12:00:00Z", stages: [], leads: [] }) : tool({ claimable: 1, needs_contact_count: 0, candidates: [{ pool_id: "synthetic-pool", base_version: 2 }] });
  });
  try {
    await load("focus-return");
    const trigger = open(view, declineForm());
    assert.equal(view.node("claimDialog").open, true);
    view.node("closeClaimDialog").listeners.click();
    assert.equal(view.node("claimDialog").open, false);
    assert.equal(trigger.focused, true);
  } finally { view.restore(); }
});
