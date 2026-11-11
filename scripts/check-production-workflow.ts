import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
type Job = { if?: string; environment?: string; concurrency?: Record<string, unknown>; steps?: Step[] };
type Workflow = { on?: Record<string, unknown>; jobs: Record<string, Job>; concurrency?: unknown };
const admitted = (condition: string, run: Record<string, unknown>) =>
  Boolean(
    runInNewContext(
      condition,
      {
        github: { repository: "synthetic/app", event: { workflow_run: run } },
      },
      { timeout: 1000 },
    ),
  );

export function checkProductionWorkflow(sources: Record<string, string>) {
  const documents = Object.fromEntries(
    Object.entries(sources).map(([name, source]) => [
      name,
      // The assertions below reject malformed workflow structure and every required field.
      parse(source) as Workflow,
    ]),
  );
  const document = documents["deploy-production.yml"];
  assert.ok(document, "production workflow required");
  assert.deepEqual(document.on, { workflow_run: { workflows: ["CI"], types: ["completed"], branches: ["main"] } });
  assert.equal(document.concurrency, undefined, "only admitted jobs join production queue");
  let publishers = 0;
  for (const [file, workflow] of Object.entries(documents))
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const steps = job.steps ?? [];
      const calls = steps.filter((step) =>
        /(?:release|rollback)-production\.mjs|(?:release|rollback):production|(?:wrangler.*|versions\s+)(?:deploy|upload)/.test(
          step.run ?? "",
        ),
      );
      if (!calls.length && job.environment !== "production") continue;
      assert.equal(file, "deploy-production.yml", "all production writers use the approved workflow");
      assert.equal(name, "production", "one serialized writer");
      assert.equal(calls.length, 1, "existing publisher is the only production write");
      publishers += calls.length;
      assert.equal(job.environment, "production");
      assert.deepEqual(job.concurrency, {
        group: "doctorcre-app-production",
        "cancel-in-progress": false,
        queue: "max",
      });
      const success = {
        status: "completed",
        conclusion: "success",
        head_branch: "main",
        event: "push",
        head_repository: { full_name: "synthetic/app" },
      };
      assert.ok(job.if);
      assert.equal(admitted(job.if, success), true);
      for (const patch of [
        { status: "in_progress" },
        { conclusion: "failure" },
        { conclusion: "cancelled" },
        { conclusion: "timed_out" },
        { head_branch: "feature" },
        { event: "pull_request" },
        { event: "merge_group" },
        { head_repository: { full_name: "fork/app" } },
      ])
        assert.equal(admitted(job.if, { ...success, ...patch }), false, JSON.stringify(patch));
      const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      assert.equal(checkout?.with?.ref, "$" + "{{ github.event.workflow_run.head_sha }}");
      assert.equal(checkout?.with?.["fetch-depth"], 0);
      assert.equal(checkout?.with?.["persist-credentials"], false);
      const candidate = steps.findIndex((step) => step.id === "candidate");
      const build = steps.findIndex((step) => step.run === "npm run build");
      const artifact = steps.findIndex((step) => step.run === "npm run artifact:verify");
      const publication = steps.findIndex((step) => step.id === "publication");
      const publisher = calls[0];
      assert.ok(publisher);
      const at = (index: number) => {
        const step = steps[index];
        assert.ok(step);
        return step;
      };
      const publish = steps.indexOf(publisher);
      const proof = steps.findIndex((step) => step.name === "Verify production release identity");
      assert.ok(
        candidate > 0 &&
          candidate < build &&
          build < artifact &&
          artifact < publication &&
          publication + 1 === publish &&
          publish < proof,
      );
      for (const index of [candidate, publication]) {
        assert.equal(at(index).run, "python3 scripts/production-candidate.py");
        assert.equal(at(index).env?.GH_TOKEN, "$" + "{{ github.token }}");
      }
      assert.equal(at(build).env?.DOCTORCRE_SOURCE_COMMIT, "$" + "{{ steps.candidate.outputs.source_commit }}");
      for (const step of steps.slice(candidate + 1, publication + 1)) {
        assert.equal(step.if, "steps.candidate.outputs.ready == 'true'");
      }
      assert.equal(at(publication).if, "steps.candidate.outputs.ready == 'true'");
      assert.equal(publisher.if, "steps.publication.outputs.ready == 'true'");
      assert.ok(publisher.run?.trim().endsWith("node scripts/release-production.mjs"));
      assert.equal(at(proof).if, "steps.publication.outputs.ready == 'true'");
      assert.match(at(proof).run ?? "", /readAppRelease/);
      assert.match(at(proof).run ?? "", /verify-app-release\.mjs/);
      assert.match(at(proof).run ?? "", /production-release\.json/);
      const receipt = steps.find((step) => step.name === "Retain deployment receipt");
      assert.equal(receipt?.if, "always()");
      assert.equal(receipt?.with?.path, "$" + "{{ runner.temp }}/production-*.json");
    }
  assert.equal(publishers, 1, "exactly one production publisher");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const directory = resolve(process.argv[2] ?? ".github/workflows");
  checkProductionWorkflow(
    Object.fromEntries(
      readdirSync(directory)
        .filter((name) => /\.ya?ml$/.test(name))
        .map((name) => [name, readFileSync(resolve(directory, name), "utf8")]),
    ),
  );
  console.log("Production workflow contract passed");
}
