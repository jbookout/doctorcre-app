import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
