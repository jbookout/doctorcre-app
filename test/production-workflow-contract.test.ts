import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { parse, stringify } from "yaml";
import { checkProductionWorkflow } from "../scripts/check-production-workflow.ts";

const directory = new URL("../.github/workflows/", import.meta.url);
const sources = Object.fromEntries(
  readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, readFileSync(new URL(name, directory), "utf8")]),
);
const production = sources["deploy-production.yml"];
assert.ok(production);
test("workflow lint rejects every broken deployment prerequisite and alternative publisher", () => {
  checkProductionWorkflow(sources);
  const mutations = [
    (text: string) => text.replace("  workflow_run:", "  push: {}\n  workflow_run:"),
    (text: string) => text.replace("github.event.workflow_run.conclusion == 'success' &&", ""),
    (text: string) => text.replace("github.event.workflow_run.status == 'completed' &&", ""),
    (text: string) => text.replace("github.event.workflow_run.head_branch == 'main' &&", ""),
    (text: string) => text.replace("github.event.workflow_run.event == 'push' &&", ""),
    (text: string) => text.replace("github.event.workflow_run.head_repository.full_name == github.repository", "true"),
    (text: string) => text.replace("ref: $" + "{{ github.event.workflow_run.head_sha }}", "ref: main"),
    (text: string) => text.replace("environment: production", "environment: staging"),
    (text: string) => text.replace("group: doctorcre-app-production", "group: per-run"),
    (text: string) => text.replace("cancel-in-progress: false", "cancel-in-progress: true"),
    (text: string) => text.replace("queue: max", "queue: single"),
    (text: string) =>
      text.replace(
        "DOCTORCRE_SOURCE_COMMIT: $" + "{{ steps.candidate.outputs.source_commit }}",
        "DOCTORCRE_SOURCE_COMMIT: main",
      ),
    (text: string) => text.replace("id: publication", "id: obsolete"),
    (text: string) => text.replace("node scripts/release-production.mjs", "echo skip"),
    (text: string) => text.replaceAll("readAppRelease", "wrongReader"),
    (text: string) => text.replace("verify-app-release.mjs", "wrongVerifier"),
    (text: string) => text.replace("production-release.json", "lost.json"),
    (text: string) => text.replace("if: always()", "if: failure()"),
  ];
  for (const mutate of mutations)
    assert.throws(() => checkProductionWorkflow({ ...sources, "deploy-production.yml": mutate(production) }));
  const duplicate = parse(production);
  duplicate.jobs.other = structuredClone(duplicate.jobs.production);
  assert.throws(() => checkProductionWorkflow({ ...sources, "deploy-production.yml": stringify(duplicate) }));
  assert.throws(() =>
    checkProductionWorkflow({
      ...sources,
      "bypass.yml": "on: push\njobs:\n  bypass:\n    steps:\n      - run: node scripts/release-production.mjs\n",
    }),
  );
});
