import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { temporaryDirectory } from "./temp-directory.mjs";

const root = resolve(".");
const directory = temporaryDirectory(resolve("out/shared-project-merge-"));
const base = process.argv[2] ?? "HEAD";
function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function register(config: string, key: "entry" | "files", paths: string[]): void {
  const file = resolve(directory, config);
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(typeof value === "object" && value !== null && key in value);
  const list = Reflect.get(value, key);
  assert.ok(Array.isArray(list));
  list.push(...paths);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
try {
  const archive = execFileSync("git", ["archive", base], { maxBuffer: 100 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", directory], { input: archive });
  git("init", "-b", "main");
  git("config", "user.name", "jbookout");
  git("config", "user.email", "jbookout@users.noreply.github.com");
  const source = git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
  git("add", "--", ...source);
  writeFileSync(resolve(directory, ".git/message"), "Synthetic source snapshot\n");
  git("commit", "-F", ".git/message");
  for (const name of ["one", "two"]) {
    git("switch", "-c", name, "main");
    const ui = `src/ui/shared-list-${name}.ts`;
    const script = `scripts/prove-shared-list-${name}.ts`;
    writeFileSync(resolve(directory, ui), "export {};\n");
    writeFileSync(resolve(directory, script), `import "../${ui}";\n`);
    const paths = [ui, script];
    if (!existsSync(resolve(directory, "scripts/strict-projects.ts"))) {
      register("tsconfig.browser.json", "files", [ui]);
      register("tsconfig.node.json", "files", [script]);
      register("knip.json", "entry", [script]);
      paths.push("tsconfig.browser.json", "tsconfig.node.json", "knip.json");
    }
    git("add", "--", ...paths);
    writeFileSync(resolve(directory, ".git/message"), `Synthetic independent ${name} feature\n`);
    git("commit", "-F", ".git/message");
  }
  git("switch", "main");
  git("merge", "--no-edit", "one");
  git("merge", "--no-edit", "two");
  symlinkSync(resolve(root, "node_modules"), resolve(directory, "node_modules"), "dir");
  const prepare = spawnSync(process.execPath, ["scripts/prepare-offline-tour.mjs"], {
    cwd: directory,
    stdio: "inherit",
  });
  assert.equal(prepare.status, 0);
  const check = spawnSync("npm", ["run", "check"], { cwd: directory, stdio: "inherit", timeout: 600_000 });
  assert.equal(check.status, 0, "Merged tree npm run check");
  console.log("Independent branches merged and npm run check passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
