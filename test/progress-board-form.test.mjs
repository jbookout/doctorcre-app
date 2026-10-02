import assert from "node:assert/strict";
import test from "node:test";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const tool = payload => new Response(JSON.stringify({ result: { content: [{ text: JSON.stringify(payload) }] } }),
  { headers: { "content-type": "application/json" } });
let loadNumber = 0;

class Node {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this._textContent = "";
  }
  set textContent(value) { this._textContent = String(value); this.children = []; }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join(""); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this._textContent = ""; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this[name] = String(value); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
}

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

async function board(answers = []) {
  const nodes = new Map();
  const writes = [];
  const old = Object.fromEntries(["document", "location", "matchMedia", "setInterval", "fetch"]
    .map(key => [key, globalThis[key]]));
  globalThis.document = {
    title: "",
    activeElement: null,
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); },
    createElement: tag => new Node(tag),
    createElementNS: (_ns, tag) => new Node(tag),
  };
  globalThis.location = { search: "?board=project-one" };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.setInterval = () => 0;
  globalThis.fetch = async (_path, init) => {
    const { name, arguments: args } = JSON.parse(init.body).params;
    if (name === "read-progress-board") return tool({
      snapshot: { board_id: "project-one", version: 1, snapshot_json: { title: "Test board", tasks: {} } },
      questions: [{ question_id: "color", revision: 2, prompt: "Choose a color",
        choices: ["Blue", "Green"], allow_free_text: true, status: null }],
    });
    assert.equal(name, "answer-board-question");
    writes.push(args);
    return answers.length ? answers.shift() : tool({ ok: true });
  };
  const {mountProgressBoard}=await import(`../js/progress-board.js?form-test=${++loadNumber}`);
  mountProgressBoard();
  await tick();
  const question = nodes.get("board-questions");
  const form = descendants(question).find(node => node.tagName === "FORM");
  assert.ok(form, "question form rendered");
  const all = descendants(form);
  const radios = all.filter(node => node.type === "radio");
  const textarea = all.find(node => node.tagName === "TEXTAREA");
  const preview = all.find(node => node.className === "answer-preview");
  const button = all.find(node => node.type === "submit");
  const select = index => {
    radios.forEach((radio, radioIndex) => { radio.checked = radioIndex === index; });
    radios[index].listeners.change?.();
  };
  const type = value => { textarea.value = value; textarea.listeners.input?.(); };
  return {
    form, radios, textarea, preview, button, writes, select, type,
    submit: () => form.listeners.submit({ preventDefault() {} }),
    restore: () => { for (const [key, value] of Object.entries(old)) globalThis[key] = value; },
  };
}

for (const [name, actions, expected] of [
  ["choice only", [["select", 0]], "Blue"],
  ["text only", [["type", "Custom"]], "Custom"],
  ["text then choice", [["type", "Custom"], ["select", 1]], "Green"],
  ["choice then text", [["select", 0], ["type", "Custom"]], "Custom"],
  ["text then choice then text", [["type", "First"], ["select", 1], ["type", "Last"]], "Last"],
  ["choice then text then choice", [["select", 0], ["type", "Custom"], ["select", 1]], "Green"],
]) {
  test(`answer form sends its visible value after ${name}`, async () => {
    const view = await board();
    try {
      for (const [action, value] of actions) view[action](value);
      assert.equal(view.preview.textContent, `Will send: ${expected}`);
      assert.equal(view.radios.filter(radio => radio.checked).length + Number(Boolean(view.textarea.value.trim())), 1,
        "only one answer mode is filled");
      await view.submit();
      assert.equal(view.writes.length, 1);
      assert.equal(view.writes[0].answer_text, expected);
    } finally { view.restore(); }
  });
}

test("typing whitespace after a choice clears it and previews no answer", async () => {
  const view = await board();
  try {
    view.select(0);
    view.type("   ");
    assert.equal(view.radios.some(radio => radio.checked), false);
    assert.equal(view.preview.textContent, "Will send: —");
    await view.submit();
    assert.equal(view.writes.length, 0);
  } finally { view.restore(); }
});

test("an unconfirmed send locks the shown answer until the identical retry", async () => {
  const view = await board([new Response("unavailable", { status: 503 }), tool({ ok: true })]);
  try {
    view.type("Custom");
    await view.submit();
    assert.equal(view.preview.textContent, "Will send: Custom");
    assert.equal(view.textarea.disabled, true);
    assert.ok(view.radios.every(radio => radio.disabled));
    await view.submit();
    assert.equal(view.writes.length, 2);
    assert.deepEqual(view.writes[1], view.writes[0]);
  } finally { view.restore(); }
});
