import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function strictProjectFiles(paths: string[], legacy: Set<string>): Record<"browser" | "node", string[]> {
  const files = paths.filter((path) => /\.[cm]?tsx?$/.test(path) && !legacy.has(path));
  return {
    browser: files.filter((path) => path.startsWith("src/ui/") && !path.startsWith("src/ui/worker/")),
    node: files.filter((path) => !path.startsWith("src/ui/")),
  };
}

export function writeStrictProjects(): void {
  const migration: unknown = JSON.parse(readFileSync("scripts/typescript-migration.json", "utf8"));
  if (typeof migration !== "object" || migration === null || !("legacyTypeScript" in migration)) {
    throw Error("Missing frozen TypeScript migration scope");
  }
  if (typeof migration.legacyTypeScript !== "object" || migration.legacyTypeScript === null) {
    throw Error("Invalid frozen TypeScript migration scope");
  }
  const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => existsSync(path));
  const projects = strictProjectFiles([...new Set(paths)].sort(), new Set(Object.keys(migration.legacyTypeScript)));
  for (const [name, files] of Object.entries(projects)) {
    writeFileSync(
      `tsconfig.${name}.generated.json`,
      `${JSON.stringify({ extends: `./tsconfig.${name}.json`, files }, null, 2)}\n`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) writeStrictProjects();
