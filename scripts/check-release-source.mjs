import { execFileSync } from "node:child_process";

const cwd = new URL("../", import.meta.url);
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA || "") || head !== process.env.GITHUB_SHA) throw new Error("release source identity mismatch");
// A tag can point anywhere. Admit only commits already in canonical main.
execFileSync("git", ["merge-base", "--is-ancestor", head, "origin/main"], { cwd, stdio: "pipe" });
