import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

type Node = { type: string; [key: string]: unknown };
function node(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}
function walk(value: unknown, visit: (value: Node) => void): void {
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit);
  } else if (node(value)) {
    visit(value);
    for (const [key, entry] of Object.entries(value)) if (key !== "loc") walk(entry, visit);
  }
}
function text(value: unknown, bindings: Map<string, unknown>, seen = new Set<string>()): string | undefined {
  if (!node(value)) return;
  if (value.type === "StringLiteral") return String(value.value);
  if (value.type === "Identifier" && typeof value.name === "string" && !seen.has(value.name)) {
    return text(bindings.get(value.name), bindings, new Set(seen).add(value.name));
  }
  if (value.type === "BinaryExpression" && value.operator === "+") {
    const left = text(value.left, bindings, seen),
      right = text(value.right, bindings, seen);
    if (left !== undefined && right !== undefined) return left + right;
  }
  if (value.type === "TemplateLiteral" && Array.isArray(value.quasis) && Array.isArray(value.expressions)) {
    let result = "";
    for (let index = 0; index < value.quasis.length; index++) {
      const quasi: unknown = value.quasis[index];
      if (!node(quasi) || typeof quasi.value !== "object" || quasi.value === null || !("cooked" in quasi.value)) return;
      result += String(quasi.value.cooked);
      if (index < value.expressions.length) {
        const part = text(value.expressions[index], bindings, seen);
        if (part === undefined) return;
        result += part;
      }
    }
    return result;
  }
}
const fixtureModule = /(?:fixture-server\.mjs|browser-harness\.mjs|fixture-probe\.ts)$/;
const owners = new Set(["test/fixture-probe.ts", "test/fixture-probe-child.ts", "test/fixture-probe.test.ts"]);

export function checkFixtureProbes(sources: Map<string, string>): string[] {
  const parsed = new Map<string, { nodes: Node[]; bindings: Map<string, unknown>; imports: string[] }>();
  const errors: string[] = [];
  for (const [file, source] of sources) {
    const nodes: Node[] = [],
      bindings = new Map<string, unknown>();
    try {
      walk(parse(source, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] }), (value) => {
        nodes.push(value);
        if (
          value.type === "VariableDeclarator" &&
          node(value.id) &&
          value.id.type === "Identifier" &&
          typeof value.id.name === "string"
        )
          bindings.set(value.id.name, value.init);
      });
    } catch {
      if (source.includes("fixture-probe")) errors.push(`${file}: cannot parse fixture probe source`);
      continue;
    }
    const imports: string[] = [];
    for (const value of nodes) {
      const name = text(value.source, bindings);
      if (name) imports.push(name);
    }
    parsed.set(file, { nodes, bindings, imports });
  }
  const sensitive = new Set<string>();
  for (const [file, data] of parsed) if (data.imports.some((name) => fixtureModule.test(name))) sensitive.add(file);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [file, data] of parsed)
      if (
        !sensitive.has(file) &&
        data.imports.some((name) => sensitive.has(relative("/", resolve("/", dirname(file), name))))
      ) {
        sensitive.add(file);
        changed = true;
      }
  }
  for (const [file, data] of parsed) {
    if (owners.has(file)) continue;
    const hasOwner = data.imports.some((name) => /fixture-probe\.ts$/.test(name));
    const acquisitionNames = new Set(["fixtureServer", "startFixtureServer", "fixtureProbe"]);
    for (const value of data.nodes)
      if (
        value.type === "ImportSpecifier" &&
        node(value.imported) &&
        node(value.local) &&
        acquisitionNames.has(String(value.imported.name))
      )
        acquisitionNames.add(String(value.local.name));
    let readinessChanged = true;
    while (readinessChanged) {
      readinessChanged = false;
      for (const [name, init] of data.bindings) {
        let acquires = false;
        walk(init, (entry) => {
          if (entry.type === "Identifier" && acquisitionNames.has(String(entry.name))) acquires = true;
        });
        if (acquires && !acquisitionNames.has(name)) {
          acquisitionNames.add(name);
          readinessChanged = true;
        }
      }
    }
    const processNames = new Set(["spawn", "fork"]);
    const timerNames = new Set(["setTimeout", "setInterval", "delay"]);
    for (const value of data.nodes) {
      if (value.type === "ImportSpecifier" && node(value.imported) && node(value.local)) {
        if (processNames.has(String(value.imported.name))) processNames.add(String(value.local.name));
        if (timerNames.has(String(value.imported.name))) timerNames.add(String(value.local.name));
      }
    }
    let aliasesChanged = true;
    while (aliasesChanged) {
      aliasesChanged = false;
      for (const [alias, init] of data.bindings) {
        const name = node(init)
          ? init.type === "Identifier"
            ? String(init.name)
            : node(init.property)
              ? String(init.property.name ?? init.property.value)
              : ""
          : "";
        for (const names of [processNames, timerNames])
          if (names.has(name) && !names.has(alias)) {
            names.add(alias);
            aliasesChanged = true;
          }
      }
    }
    for (const value of data.nodes) {
      if (value.type !== "CallExpression") continue;
      const callee = value.callee;
      const name = node(callee)
        ? callee.type === "Identifier"
          ? String(callee.name)
          : node(callee.property)
            ? String(callee.property.name ?? callee.property.value)
            : ""
        : "";
      if (hasOwner && (timerNames.has(name) || name === "race" || name === "timeout"))
        errors.push(`${file}: caller deadline bypasses phase-aware fixture probe owner`);
      if (sensitive.has(file) && name === "race") {
        let readiness = false;
        walk(value.arguments, (entry) => {
          if (entry.type === "Identifier" && acquisitionNames.has(String(entry.name))) readiness = true;
        });
        if (readiness) errors.push(`${file}: caller readiness race bypasses phase-aware fixture probe owner`);
      }
      if (!processNames.has(name)) continue;
      let inlineFixture = false;
      walk(value.arguments, (entry) => {
        const source = text(entry, data.bindings);
        if (source && /fixture-server|browser-harness|fixture-probe/.test(source)) inlineFixture = true;
      });
      const args = Array.isArray(value.arguments) ? value.arguments : [];
      let input: unknown = name === "fork" ? args[0] : args[1];
      if (node(input) && input.type === "Identifier") input = data.bindings.get(String(input.name));
      const elements =
        node(input) && input.type === "ArrayExpression" && Array.isArray(input.elements) ? input.elements : [];
      const first = elements[0];
      let target = text(first, data.bindings);
      if (!target && node(first))
        walk(first, (entry) => {
          if (
            entry.type === "NewExpression" &&
            node(entry.callee) &&
            entry.callee.name === "URL" &&
            Array.isArray(entry.arguments)
          )
            target = text(entry.arguments[0], data.bindings);
        });
      const resolvedTarget = target
        ? relative("/", resolve("/", target.startsWith(".") ? dirname(file) : "", target))
        : undefined;
      const inline = elements.some(
        (entry) => text(entry, data.bindings) === "-e" || text(entry, data.bindings) === "--eval",
      );
      const program = inline
        ? text(
            elements[elements.findIndex((entry) => ["-e", "--eval"].includes(text(entry, data.bindings) ?? "")) + 1],
            data.bindings,
          )
        : undefined;
      if (
        inlineFixture ||
        (resolvedTarget && fixtureModule.test(resolvedTarget)) ||
        (sensitive.has(file) && ((!target && !inline) || (inline && program === undefined)))
      )
        errors.push(`${file}: fixture process probe must use fixtureProbe; dynamic process code cannot be verified`);
    }
  }
  return [...new Set(errors)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? ".");
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  }).split("\0");
  const sources = new Map(
    files
      .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
      .map((file) => [file, readFileSync(resolve(root, file), "utf8")]),
  );
  const errors = checkFixtureProbes(sources);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Fixture probe ownership check passed");
}
