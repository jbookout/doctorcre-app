import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

type Node = Record<string, unknown>;
function node(value: unknown): Node | undefined {
  return typeof value === "object" && value !== null && "type" in value ? value : undefined;
}
function visit(value: unknown, inspect: (value: Node) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, inspect);
    return;
  }
  const current = node(value);
  if (!current) return;
  inspect(current);
  for (const [key, child] of Object.entries(current)) if (key !== "loc") visit(child, inspect);
}

export function cdpFixtureViolations(source: string, path: string): string[] {
  if (path === "test/cdp-negative-corpus.ts") return [];
  const file = parse(source, {
    sourceType: "unambiguous",
    plugins: [["typescript", { dts: path.endsWith(".d.ts") || path.endsWith(".d.mts") }], "jsx"],
  });
  const bindings = new Map<string, Node>();
  visit(file, (current) => {
    const name = node(current.id),
      initializer = node(current.init);
    if (current.type === "VariableDeclarator" && typeof name?.name === "string" && initializer)
      bindings.set(name.name, initializer);
  });
  function value(current: Node | undefined, seen = new Set<string>()): string | undefined {
    if (!current) return undefined;
    if (current.type === "StringLiteral" && typeof current.value === "string") return current.value;
    if (current.type === "Identifier" && typeof current.name === "string" && !seen.has(current.name))
      return value(bindings.get(current.name), new Set([...seen, current.name]));
    if (current.type === "BinaryExpression" && current.operator === "+") {
      const left = value(node(current.left), seen),
        right = value(node(current.right), seen);
      if (left !== undefined && right !== undefined) return left + right;
    }
    if (current.type === "TemplateLiteral" && Array.isArray(current.quasis) && Array.isArray(current.expressions)) {
      let text = "";
      for (let i = 0; i < current.quasis.length; i++) {
        const quasi = node(current.quasis[i]),
          data = quasi?.value;
        if (typeof data !== "object" || data === null || !("cooked" in data) || typeof data.cooked !== "string")
          return undefined;
        text += data.cooked;
        if (i < current.expressions.length) text += value(node(current.expressions[i]), seen) ?? "<dynamic>";
      }
      return text;
    }
    return undefined;
  }
  // Keep the detector outside the literal source marker it rejects.
  const profileMarker = ["DevTools", "ActivePort"].join("");
  const issues = new Set<string>(source.includes(profileMarker) ? ["profile-file endpoint discovery is retired"] : []);
  visit(file, (current) => {
    if (
      current.type === "ImportDeclaration" &&
      node(current.source)?.value === "@puppeteer/browsers" &&
      current.importKind !== "type"
    ) {
      const imports = current.specifiers;
      if (
        Array.isArray(imports) &&
        imports.some((item) => {
          const specifier = node(item);
          return (
            specifier?.importKind !== "type" &&
            (specifier?.type !== "ImportSpecifier" || node(specifier.imported)?.name === "launch")
          );
        }) &&
        !["test/owned-cdp-fixture.ts", "test/owned-cdp-fixture.browser.ts"].includes(path)
      )
        issues.add("public process launcher belongs to the owned fixture");
    }
    const text = value(current);
    if (text?.includes(profileMarker)) issues.add("profile-file endpoint discovery is retired");
    if (text && /--remote-debugging-port/.test(text) && path !== "test/owned-cdp-fixture.ts")
      issues.add("debugging port belongs to owned-cdp-fixture.ts");
    if (text && /(?:^|\/)cdp-fixture(?:\.[cm]?[jt]s)?$/.test(text))
      issues.add("retired cdp-fixture import or reexport");
  });
  return [...issues];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  }).split("\0");
  for (const path of new Set(paths)) {
    if (!/\.[cm]?[jt]sx?$/.test(path) || !existsSync(path) || /(?:^|\/)(?:vendor|node_modules|dist)\//.test(path))
      continue;
    for (const issue of cdpFixtureViolations(readFileSync(path, "utf8"), path)) {
      console.error(`${path}: ${issue}`);
      process.exitCode = 1;
    }
  }
}
