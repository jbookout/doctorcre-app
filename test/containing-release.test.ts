import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { classifyRelease, requireContainingRelease } from "../scripts/containing-release.ts";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";

test("containing release accepts equal and descendant, refuses older unrelated and unknown commits", async (t) => {
  const cwd = temporaryDirectory("containing-release-", t);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.test");
  git("commit", "--allow-empty", "-qm", "older");
  const older = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "merge");
  const merge = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "descendant");
  const descendant = git("rev-parse", "HEAD");
  git("checkout", "--orphan", "unrelated");
  git("commit", "--allow-empty", "-qm", "unrelated");
  const unrelated = git("rev-parse", "HEAD");
  for (const [observed, expected] of [
    [merge, "containing"],
    [descendant, "containing"],
    [older, "older"],
    [unrelated, "unrelated"],
    ["a".repeat(40), "unknown"],
  ])
    assert.equal(await classifyRelease(merge, String(observed), { cwd }), expected);
  await requireContainingRelease(merge, merge, { cwd });
  await requireContainingRelease(merge, descendant, { cwd });
  for (const observed of [older, unrelated, "a".repeat(40)]) {
    await assert.rejects(requireContainingRelease(merge, observed, { cwd }), { exitCode: 78 });
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(requireContainingRelease(merge, descendant, { cwd, signal: controller.signal }), {
    exitCode: 78,
  });
});

test("legacy release and browser declarations match consumed runtime shapes", async () => {
  const { proofFetch, readAppRelease, launchProofBrowser } = await import("../scripts/app-release-reader.mjs");
  const { CHROMIUM_SAFETY_ARGS } = await import("../scripts/chromium-safety-args.mjs");
  const { startWorkerFixture } = await import("../scripts/fixture-http.mjs");
  const source_commit = "1".repeat(40);
  const release = { service: "doctorcre-app", environment: "production", source_commit };
  const server = await startWorkerFixture({
    routes: new Map([
      [
        "/app-release",
        {
          body: JSON.stringify(release),
          contentType: "application/json",
        },
      ],
    ]),
  });
  try {
    assert.equal(typeof server.origin, "string");
    const response = await proofFetch(new URL("/app-release", server.origin));
    assert.ok(response instanceof Response);
    assert.deepEqual(await response.json(), release);
    assert.deepEqual(await readAppRelease(server.origin), release);
    assert.deepEqual(
      await readAppRelease(server.origin, async (url) => {
        const response = await proofFetch(url);
        return { type: response.headers.get("content-type") || "", body: Buffer.from(await response.arrayBuffer()) };
      }),
      release,
    );
    await assert.rejects(
      readAppRelease(server.origin, async () => ({ type: "application/json", body: Buffer.from("{}") })),
      { exitCode: 78 },
    );
    assert.equal(server.requests.length, 3);
    for (const request of server.requests) {
      assert.equal(request.method, "GET");
      assert.equal(request.path, "/app-release");
      assert.equal(request.target, "/app-release");
      assert.equal(request.headers["x-doctorcre-release-reader"], "1");
    }
    assert.deepEqual(server.rejectedRequests, []);
    server.release("unused");
  } finally {
    await server.close();
  }
  assert.deepEqual(CHROMIUM_SAFETY_ARGS, ["--use-mock-keychain", "--password-store=basic"]);
  assert.ok(Object.isFrozen(CHROMIUM_SAFETY_ARGS));
  let closed = false;
  const browser = await launchProofBrowser(
    {
      async launch(options) {
        assert.deepEqual(options.args, [...CHROMIUM_SAFETY_ARGS]);
        return {
          async close() {
            closed = true;
          },
          async newPage() {
            return { title: "synthetic" };
          },
        };
      },
    },
    { args: [...CHROMIUM_SAFETY_ARGS] },
  );
  try {
    assert.equal((await browser.newPage()).title, "synthetic");
  } finally {
    await browser.close();
  }
  assert.equal(closed, true);
});

test("app asset snapshot returns byte bodies and content types consumed by Worker fixtures", async (t) => {
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { appAssetSnapshot } = await import("../scripts/fixture-app-assets.mjs");
  const { startWorkerFixture } = await import("../scripts/fixture-http.mjs");
  const root = temporaryDirectory("asset-declaration-", t);
  await writeFile(join(root, "index.html"), "<p>fixture</p>");
  await writeFile(join(root, "artifact-manifest.json"), JSON.stringify({ files: [{ path: "index.html" }] }));
  const assets = await appAssetSnapshot(root);
  assert.ok(assets instanceof Map);
  assert.deepEqual([...assets.keys()], ["/index.html", "/artifact-manifest.json"]);
  for (const asset of assets.values()) {
    assert.ok(Buffer.isBuffer(asset.body));
    assert.equal(typeof asset.contentType, "string");
  }
  const server = await startWorkerFixture({ routes: assets });
  try {
    const response = await fetch(`${server.origin}/index.html`);
    assert.equal(response.headers.get("content-type"), "text/html");
    assert.equal(await response.text(), "<p>fixture</p>");
  } finally {
    await server.close();
  }
});
