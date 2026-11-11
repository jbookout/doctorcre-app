import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";

test("all package-dependent jobs require the selected image and verification without acquisition", () => {
  for (const [file, names] of Object.entries({
    ci: ["shards", "performance", "live"],
    checks: ["checks"],
    e2e: ["journeys"],
    "staging-e2e": ["staging"],
    release: ["build"],
    "deploy-production": ["production"],
  })) {
    const source = readFileSync(`.github/workflows/${file}.yml`, "utf8");
    const workflow = parse(source);
    assert.equal(workflow.jobs["ci-image"].uses, "./.github/workflows/ci-image.yml");
    assert.doesNotMatch(source, /playwright install|apt-mirrors|ci-postgres\.sh|ci-zsh\.sh|ZSH_ARCHIVE_DIR/);
    for (const name of names) {
      const job = workflow.jobs[name];
      assert.equal(job.needs, "ci-image");
      assert.equal(job.container.image, "$" + "{{ needs.ci-image.outputs.image }}");
      assert.equal(job.container.options, "--init --user 1001:1001");
      assert.equal(job.defaults.run.shell, "bash");
      assert.equal(job.env.HOME, "/home/ci");
      assert.ok(job.steps.some((step: { run?: string }) => step.run === "python3 /opt/ci/capabilities.py verify app"));
    }
  }
});

test("selector rejects pending, floating and zero pins and emits only a published digest shape", (t) => {
  const root = temporaryDirectory("ci-image-selector-", t);
  mkdirSync(join(root, ".github"));
  const selector = parse(readFileSync(".github/workflows/ci-image.yml", "utf8"));
  const command = selector.jobs.select.steps.find((step: { id?: string }) => step.id === "pin").run;
  for (const [image, valid] of [
    [null, false],
    ["ghcr.io/jbookout/software-factory/ci-app:latest", false],
    [`ghcr.io/jbookout/software-factory/ci-app@sha256:${"0".repeat(64)}`, false],
    [`ghcr.io/jbookout/software-factory/ci-app@sha256:${"a".repeat(64)}`, true],
  ] as const) {
    writeFileSync(join(root, ".github/action-pins.json"), JSON.stringify({ ci_app_image: { image } }));
    const output = join(root, "output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-e", "-c", command], {
      cwd: root,
      env: { ...process.env, GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    assert.equal(result.status === 0, valid, result.stderr);
    assert.equal(readFileSync(output, "utf8"), valid ? `image=${image}\n` : "");
  }
});

test("producer Python verification refuses a different minor without repair", async () => {
  const { verifyProducerPython } = await import("../scripts/verify-ci-image.ts");
  verifyProducerPython("3.14", "Python 3.14.4");
  assert.throws(() => verifyProducerPython("3.14", "Python 3.12.3"));
  assert.throws(() => verifyProducerPython("3.14", "not python"));
});
