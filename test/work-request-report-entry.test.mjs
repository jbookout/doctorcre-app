import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { autoRefreshScript } from './auto-refresh-script.mjs';
import { createRetainedCommands } from '../js/retained-commands.mjs';
import test from "node:test";

const page = await readFile(new URL("../system-work.html", import.meta.url), "utf8");

test("Work Requests lets a partner record a concern and open its returned request", async () => {
  assert.match(page, /<button[^>]*id="reportProblemButton"[^>]*>Report a system problem<\/button>/);

  const selectors = ["systemWorkActor", "reportProblemButton", "openWorkRequest", "systemWorkStage",
    "systemWorkDialog", "systemWorkEyebrow", "systemWorkTitle", "systemWorkSubmit",
    "systemWorkFields", "systemWorkFormError", "systemWorkForm", "systemWorkAlert", "workRequestRef"];
  const nodes = Object.fromEntries(selectors.map((id) => [id, {
    innerHTML: "", textContent: "", hidden: false, value: "", disabled: false,
    showModal() { this.open = true; }, close() { this.open = false; },
  }]));
  const requests = [];
  const previous = Object.fromEntries(["document", "fetch", "FormData", "location", "history"]
    .map((key) => [key, globalThis[key]]));
  try {
    globalThis.document = {
      querySelector: (selector) => nodes[selector.slice(1)] || null,
      querySelectorAll: () => [],
    };
    globalThis.location = { search: "" };
    globalThis.history = { replaceState(_state, _title, path) { this.path = path; } };
    globalThis.FormData = class {
      constructor(form) { this.values = form.values; }
      get(key) { return this.values[key]; }
    };
    globalThis.fetch = async (path, init = {}) => {
      requests.push({ path, init });
      const data = path === "/api/system-work/session"
        ? { actor: { slug: "joe" }, csrf_token: "csrf" }
        : path === "/api/system-work/current" ? { items: [] }
          : path === "/api/system-work/report" ? { data: { human_ref: "WR-000123" } }
            : { data: { human_ref: "WR-000123", title: "Recovery concern", state: "captured", version: 1,
              source: { freshness: "current" }, acceptance_criteria: [] } };
      return new Response(JSON.stringify(data), { status: 200 });
    };
    await import(`../js/system-work-app.js?report-entry=${Date.now()}`);
    await new Promise((resolve) => setImmediate(resolve));

    nodes.reportProblemButton.onclick();
    assert.equal(nodes.systemWorkDialog.open, true);
    assert.match(nodes.systemWorkFields.innerHTML, /name="situation"/);
    assert.match(nodes.systemWorkFields.innerHTML, /name="criteria"/);
    nodes.systemWorkForm.values = {
      situation: "The recovery receipt cannot be read", title: "Recovery concern",
      desired_outcome: "The receipt reads back", criteria: "A safe receipt opens\nA partner can verify it",
    };
    await nodes.systemWorkForm.onsubmit({ preventDefault() {} });

    const report = requests.find(({ path }) => path === "/api/system-work/report");
    assert.ok(report, "the page submits the concern to the governed report route");
    assert.deepEqual(JSON.parse(report.init.body).acceptance_criteria, [
      { id: "CRITERION-1", text: "A safe receipt opens" },
      { id: "CRITERION-2", text: "A partner can verify it" },
    ]);
    assert.equal(globalThis.history.path, "/work-requests?work_request=WR-000123");
    assert.equal(nodes.systemWorkDialog.open, false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const card = { human_ref: 'WR-000123', version: 1, state: 'captured', title: 'Synthetic concern',
  source: { freshness: 'current' }, acceptance_criteria: [] };

async function setup(t, { session, read = () => card, current = () => ({ items: [card] }), search = '' } = {}) {
  const dom = new JSDOM(readFileSync(new URL('../system-work.html', import.meta.url), 'utf8'), {
    url: `http://localhost/work-requests${search}`, runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document, calls = [];
  w.structuredClone = structuredClone;
  w.createRetainedCommands = createRetainedCommands;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.fetch = async (path, init = {}) => {
    calls.push({ path, method: init.method || 'GET' });
    const result = path.endsWith('/session') ? await session()
      : path.endsWith('/current') ? await current() : await read(path);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result));
  };
  const files = ['doc-context-model.js', 'doc-context.js', 'uuid.js', 'system-work-view.js', 'system-work-client.js', 'system-work-app.js'];
  w.eval(autoRefreshScript + '\n' + files.map(name => {
    const raw = readFileSync(new URL('../js/' + name, import.meta.url), 'utf8');
    const names = [...raw.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map(match => match[1]);
    return '(function(){' + raw.replace(/^import [^\n]*\n/gm, '').replace(/^export /gm, '')
      + ';Object.assign(window,{' + names.join(',') + '});})();';
  }).join('\n'));
  return { w, d, calls };
}

const readySession = () => ({ actor: { display: 'Synthetic partner' }, csrf_token: 'synthetic' });
const unavailable = () => new Response(JSON.stringify({ error: 'DEPENDENCY_UNAVAILABLE' }), { status: 503 });

test('finding 02: handlers exist while session is pending; Open never submits natively', async t => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const h = await setup(t, { session: () => pending });
  assert.equal(typeof h.d.querySelector('#reportProblemButton').onclick, 'function');
  assert.equal(h.d.querySelector('#reportProblemButton').disabled, true);
  h.d.querySelector('#workRequestRef').value = card.human_ref;
  const event = new h.w.Event('submit', { bubbles: true, cancelable: true });
  h.d.querySelector('#openWorkRequest').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.calls.filter(call => call.path.endsWith('/session')).length, 1);
  resolve(readySession());
  await settle();
  assert.match(h.d.querySelector('#systemWorkStage').textContent, /Synthetic concern/);
  assert.equal(h.d.querySelector('#reportProblemButton').disabled, false);
});

for (const failure of ['service', 'network', 'auth']) {
  test(`finding 02: ${failure} session failure paints unavailable and Retry restores Report and the requested card`, async t => {
    let failed = true;
    const h = await setup(t, { search: `?work_request=${card.human_ref}`, session: () => {
      if (!failed) return readySession();
      if (failure === 'network') throw Error('Synthetic outage');
      if (failure === 'auth') return new Response('{}', { status: 401 });
      return unavailable();
    } });
    await settle();
    assert.match(h.d.querySelector('#systemWorkActor').textContent, /unavailable/i);
    assert.match(h.d.querySelector('#systemWorkStage').textContent, /unavailable/i);
    assert.doesNotMatch(h.d.querySelector('#systemWorkStage').textContent, /No eligible/);
    assert.equal(h.d.querySelector('#reportProblemButton').disabled, true);
    assert.equal(typeof h.d.querySelector('#reportProblemButton').onclick, 'function');
    h.d.querySelector('#workRequestRef').value = card.human_ref;
    const event = new h.w.Event('submit', { bubbles: true, cancelable: true });
    h.d.querySelector('#openWorkRequest').dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    await settle();
    assert.equal(h.calls.some(call => call.method === 'POST'), false);
    failed = false;
    h.d.querySelector('[data-system-retry]').click();
    await settle();
    assert.match(h.d.querySelector('#systemWorkStage').textContent, /Synthetic concern/);
    assert.equal(h.d.querySelector('#systemWorkAlert').hidden, true);
    assert.equal(h.d.querySelector('[data-system-retry]'), null);
    h.d.querySelector('#reportProblemButton').click();
    assert.equal(h.d.querySelector('#systemWorkDialog').open, true);
    h.d.querySelector('[data-system-cancel]').click();
    assert.equal(h.d.querySelector('#systemWorkDialog').open, false);
  });
}

test('finding 02: failed card read offers Retry instead of an empty success state', async t => {
  let failed = true;
  const h = await setup(t, { search: `?work_request=${card.human_ref}`, session: readySession,
    read: () => failed ? unavailable() : card });
  await settle();
  assert.match(h.d.querySelector('#systemWorkStage').textContent, /unavailable/i);
  assert.doesNotMatch(h.d.querySelector('#systemWorkStage').textContent, /No eligible/);
  failed = false;
  h.d.querySelector('[data-system-retry]').click();
  await settle();
  assert.match(h.d.querySelector('#systemWorkStage').textContent, /Synthetic concern/);
  assert.equal(h.calls.filter(call => call.path.endsWith('/session')).length, 1);
});

test('finding 02: failed collection read offers Retry and recovers the request list', async t => {
  let failed = true;
  const h = await setup(t, { session: readySession,
    current: () => failed ? unavailable() : { items: [card] } });
  await settle();
  assert.match(h.d.querySelector('#systemWorkStage').textContent, /unavailable/i);
  assert.doesNotMatch(h.d.querySelector('#systemWorkStage').textContent, /No eligible/);
  failed = false;
  h.d.querySelector('[data-system-retry]').click();
  await settle();
  assert.ok(h.d.querySelector('[data-open-work-request]'));
  assert.equal(h.d.querySelector('#systemWorkAlert').hidden, true);
  assert.equal(h.calls.filter(call => call.path.endsWith('/session')).length, 1);
});

test('finding 02: Open on a nonexistent reference keeps the not-found refusal without Retry', async t => {
  const h = await setup(t, { session: readySession,
    read: () => new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404 }) });
  await settle();
  h.d.querySelector('#workRequestRef').value = 'WR-000999';
  h.d.querySelector('#openWorkRequest').dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.match(h.d.querySelector('#systemWorkAlert').textContent, /That Work Request was not found\./);
  assert.equal(h.d.querySelector('[data-system-retry]'), null);
});
