// A sign-out that removes the toolbar while the recorder probe is in flight must not throw when the probe settles.
import test from "node:test";
import assert from "node:assert/strict";
import { CALL_MODE_STATES } from "../js/post-call-client.js";
import { mountGlobalCallMode } from "../js/global-call-mode.js";

test("a recorder probe that settles after the toolbar is removed leaves the page quiet", async () => {
  const elements = new Map(["callModeButton", "callModeAvailability", "callModeRetry"].map(id => [id, { hidden: false, disabled: false, textContent: "" }]));
  const root = { getElementById: id => elements.get(id) ?? null };
  let answer;
  const saved = globalThis.fetch;
  globalThis.fetch = () => new Promise(resolve => { answer = resolve; });
  try {
    const mounting = mountGlobalCallMode(root);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof answer, "function", "the probe is in flight");
    elements.clear();
    const idle = CALL_MODE_STATES.find(state => state !== "recording");
    answer(new Response(JSON.stringify({ state: idle }), { headers: { "content-type": "application/json" } }));
    await assert.doesNotReject(mounting);
  } finally { globalThis.fetch = saved; }
});
