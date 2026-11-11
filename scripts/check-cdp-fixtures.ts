import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import { profileMarker } from "../test/cdp-negative-corpus.ts";

export function cdpFixtureViolations(source: string, path: string): string[] {
  if (path === "test/cdp-negative-corpus.ts") return [];
  const file = parse(source, {
    sourceType: "unambiguous",
    plugins: [["typescript", { dts: /\.d\.[cm]?ts$/.test(path) }], "jsx"],
  });
  const issues = new Set<string>(source.includes(profileMarker) ? ["profile-file endpoint discovery is retired"] : []);
  function inspect(value: string) {
    if (value.includes(profileMarker)) issues.add("profile-file endpoint discovery is retired");
    if (/--remote-debugging-port/.test(value) && path !== "test/owned-cdp-fixture.ts")
      issues.add("debugging port belongs to owned-cdp-fixture.ts");
    if (/(?:^|\/)cdp-fixture(?:\.[cm]?[jt]s)?$/.test(value)) issues.add("retired cdp-fixture import or reexport");
  }
  traverse(file, {
    ImportDeclaration(importPath) {
      const declaration = importPath.node;
      if (declaration.source.value !== "@puppeteer/browsers" || declaration.importKind === "type") return;
      const launches = declaration.specifiers.some(
        (specifier) =>
          specifier.type !== "ImportSpecifier" ||
          (specifier.importKind !== "type" &&
            (specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value) ===
              "launch"),
      );
      if (launches && !["test/owned-cdp-fixture.ts", "test/owned-cdp-fixture.browser.ts"].includes(path)) {
        issues.add("public process launcher belongs to the owned fixture");
      }
    },
    Expression(expression) {
      if (expression.isTemplateLiteral()) {
        const values = expression.get("expressions");
        let text = "";
        for (const [index, quasi] of expression.node.quasis.entries()) {
          text += quasi.value.cooked ?? quasi.value.raw;
          const part = values[index];
          if (!part) continue;
          const evaluated = part.evaluate();
          const value: unknown = evaluated.value;
          text +=
            evaluated.confident && (typeof value === "string" || typeof value === "number")
              ? String(value)
              : "<dynamic>";
        }
        inspect(text);
        return;
      }
      if (
        !expression.isStringLiteral() &&
        !expression.isBinaryExpression({ operator: "+" }) &&
        !expression.isIdentifier()
      )
        return;
      const evaluated = expression.evaluate();
      const value: unknown = evaluated.value;
      if (evaluated.confident && typeof value === "string") inspect(value);
    },
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
