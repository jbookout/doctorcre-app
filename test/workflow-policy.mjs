import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

// A deliberately bounded reader for the scalar policy fields, not a YAML loader.
// Unknown expressions fail closed. GitHub's scheduler owns actual cancellation;
// this replay executes the policy expressions read from the deployed workflows.
export function expression(value, github, success = true) {
  if (value === undefined) return success;
  const raw = String(value).replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  assert.match(raw, /^(?:github\.(?:workflow|ref|run_id|event_name|event\.action|event\.pull_request\.number)|always\(\)|'[^']*'|[\s()=!&|]|true|false)+$/, `unsupported expression: ${raw}`);
  const result = runInNewContext(raw, { github, always: () => true }, { timeout: 1000 });
  // Actions implicitly adds success() unless a status function is present.
  return raw.includes("always()") || success ? result : false;
}
export function context(event_name = "pull_request", action = "synchronize", number = 9, run_id = 1) {
  return { event_name, run_id, ref: event_name === "pull_request" ? `refs/pull/${number}/merge` : "refs/heads/main",
    event: { action, pull_request: event_name === "pull_request" ? { number } : {} } };
}
export function policy(source, event, success = true) {
  const workflow = source.match(/^name: (.+)$/m)?.[1];
  const types = source.match(/^  pull_request:\n(?:    #.*\n)*    types: \[(.+)\]/m)?.[1].split(/,\s*/)
    ?? ["opened", "synchronize", "reopened"];
  const triggers = event.event_name !== "pull_request" || types.includes(event.event.action);
  const concurrency = source.match(/^concurrency:\n((?:  .+\n)+)/m)?.[1];
  const group = concurrency?.match(/^  group: (.+)$/m)?.[1].replace(/\$\{\{(.*?)\}\}/g,
    (_, expr) => expression(expr.trim(), { ...event, workflow }));
  const cancel = concurrency ? Boolean(expression(concurrency.match(/^  cancel-in-progress: (.+)$/m)?.[1], event)) : false;
  const jobText = source.split(/^jobs:\n/m)[1];
  assert.ok(jobText, "jobs must be readable");
  const jobs = [...jobText.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/gm)];
  assert.ok(jobs.length, "jobs must be collected");
  const runnable = triggers ? jobs.filter(([, , body]) => expression(body.match(/^    if: (.+)$/m)?.[1], event, success)).map(([, name]) => name) : [];
  return { triggers, group, cancel, runnable, jobs: jobs.map(([, name]) => name) };
}
