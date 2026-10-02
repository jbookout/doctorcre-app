import { readFile } from "node:fs/promises";
export const autoRefreshScript = (await Promise.all(["read-on-resume.mjs", "auto-refresh.mjs"].map(name => readFile(new URL(`../js/${name}`, import.meta.url), "utf8")))).map(s => s.replace(/^import [^\n]*\n/gm, "").replace(/^export /gm, "")).join("\n");
