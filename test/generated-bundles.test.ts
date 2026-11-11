import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { UI_ENTRIES, uiAssets } from "../scripts/ui-bundle.mjs";

const root = new URL("../", import.meta.url);
const readSource = (path: string) => readFile(new URL(path, root), "utf8");

test("a new screen emits ignored bundles without editing gitignore and preserves handwritten JavaScript", async (t) => {
  const scratch = temporaryDirectory("generated-bundles-", t);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: scratch, encoding: "utf8" }).trim();
  await writeFile(join(scratch, ".gitignore"), await readSource(".gitignore"));
  git("init", "-q");
  const handwritten = execFileSync("git", ["ls-files", "js"], { cwd: root, encoding: "utf8" }).trim().split("\n");
  for (const path of handwritten) {
    await mkdir(dirname(join(scratch, path)), { recursive: true });
    await writeFile(join(scratch, path), await readSource(path));
  }
  git("add", "--", ...handwritten);
  assert.deepEqual(git("ls-files", "js").split("\n"), handwritten);
  UI_ENTRIES["ui-synthetic-new-screen"] = "synthetic-new-screen";
  let assets: Awaited<ReturnType<typeof uiAssets>>;
  try {
    assets = await uiAssets((path: string) =>
      path === "src/ui/synthetic-new-screen.tsx" ? Promise.resolve("export const synthetic = 1;") : readSource(path),
    );
  } finally {
    delete UI_ENTRIES["ui-synthetic-new-screen"];
  }
  for (const [path, bytes] of assets) {
    await mkdir(dirname(join(scratch, path)), { recursive: true });
    await writeFile(join(scratch, path), bytes);
  }
  const generated = [...assets.keys()].filter((path) => path.startsWith("js/"));
  const ignored = git("check-ignore", "--no-index", "--", ...generated).split("\n");
  assert.deepEqual(
    ignored.sort(),
    generated.sort(),
    "every emitted bundle, including the synthetic screen, is ignored",
  );
  const paths = (await readdir(join(scratch, "js"), { recursive: true })).map((path) => `js/${path}`);
  const allIgnored = git("check-ignore", "--no-index", "--", ...paths).split("\n");
  assert.deepEqual(allIgnored.sort(), generated.sort(), "only emitted bundles are ignored across the whole js tree");
  assert.equal(git("status", "--porcelain", "--untracked-files=all", "--", "js").includes("??"), false);
  assert.equal(
    spawnSync("git", ["check-ignore", "--no-index", "--", "js/ui-handwritten.js", "js/handwritten.js"], {
      cwd: scratch,
    }).status,
    1,
  );
});
