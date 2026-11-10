import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Scope = { vendorExceptions: string[]; legacyJavaScript: string[] };

function scope(): Scope {
  const value: unknown = JSON.parse(readFileSync(new URL("./typescript-migration.json", import.meta.url), "utf8"));
  if (typeof value !== "object" || value === null || !("vendorExceptions" in value) || !("legacyJavaScript" in value)) {
    throw Error("Invalid JavaScript migration scope");
  }
  const { vendorExceptions, legacyJavaScript } = value;
  if (
    !Array.isArray(vendorExceptions) ||
    !vendorExceptions.every((item: unknown) => typeof item === "string") ||
    !Array.isArray(legacyJavaScript) ||
    !legacyJavaScript.every((item: unknown) => typeof item === "string")
  ) {
    throw Error("Migration paths must be strings");
  }
  return { vendorExceptions, legacyJavaScript };
}

export function unexpectedJavaScript(paths: string[], allowed: Scope): string[] {
  const exceptions = new Set([...allowed.vendorExceptions, ...allowed.legacyJavaScript]);
  return paths.filter((path) => /\.(?:js|mjs|cjs|jsx)$/.test(path) && !exceptions.has(path));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path.length > 0 && existsSync(path));
  const unexpected = unexpectedJavaScript(paths, scope());
  const migration: unknown = JSON.parse(readFileSync(new URL("./typescript-migration.json", import.meta.url), "utf8"));
  assert.ok(typeof migration === "object" && migration !== null && "legacyTypeScript" in migration);
  assert.ok(typeof migration.legacyTypeScript === "object" && migration.legacyTypeScript !== null);
  const legacy = new Map(Object.entries(migration.legacyTypeScript));
  const gated = new Set<string>();
  for (const config of [
    "../tsconfig.node.generated.json",
    "../tsconfig.browser.generated.json",
    "../tsconfig.worker.json",
  ]) {
    const value: unknown = JSON.parse(readFileSync(new URL(config, import.meta.url), "utf8"));
    assert.ok(typeof value === "object" && value !== null && "files" in value && Array.isArray(value.files));
    for (const file of value.files) {
      assert.equal(typeof file, "string");
      if (typeof file === "string") gated.add(file);
    }
  }
  for (const path of paths.filter((path) => /\.[cm]?tsx?$/.test(path))) {
    if (gated.has(path)) continue;
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (legacy.get(path) !== hash) unexpected.push(`${path} must join a strict tsconfig before it changes`);
  }
  if (unexpected.length) {
    process.stderr.write(`New first-party JavaScript must be TypeScript:\n${unexpected.join("\n")}\n`);
    process.exitCode = 1;
  }
}
