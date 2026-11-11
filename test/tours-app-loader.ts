import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { build } from "esbuild";
import { UI_ENTRIES } from "../scripts/ui-bundle.mjs";

const appUrl = new URL("../tours/app.js", import.meta.url);

export async function buildToursAppScript(source?: string): Promise<string> {
  const result = await build({
    stdin: {
      contents: source ?? (await readFile(appUrl, "utf8")),
      resolveDir: fileURLToPath(new URL(".", appUrl)),
      sourcefile: "tours/app.js",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    target: "es2022",
    logLevel: "silent",
    define: { "import.meta.url": JSON.stringify("https://app.doctorcre.com/js/market-map-shell.js") },
    plugins: [
      {
        name: "isolated-tour-transport",
        setup(builder) {
          builder.onResolve({ filter: /\/js\/[^/]+\.js$/ }, async (args) => {
            const entry = Object.entries(UI_ENTRIES).find(([name]) => args.path.endsWith(`/js/${name}.js`));
            if (!entry) return undefined;
            return builder.resolve(fileURLToPath(new URL(`../src/ui/${entry[1]}`, import.meta.url)), {
              kind: args.kind,
              resolveDir: fileURLToPath(new URL("../", import.meta.url)),
            });
          });
          builder.onLoad({ filter: /[/\\]js[/\\](private-session|app-shell)\.js$/ }, (args) => ({
            contents: args.path.endsWith("private-session.js")
              ? "export const sessionFetch = (...args) => fetch(...args);"
              : "",
            loader: "js",
          }));
        },
      },
    ],
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("Tour fixture bundle is empty");
  return output.text;
}

export async function toursAppImports(): Promise<string> {
  const source = await readFile(appUrl, "utf8");
  const imports = parse(source, { sourceType: "module" }).program.body.filter(
    (node) => node.type === "ImportDeclaration",
  );
  const declarations = imports.map((node) => source.slice(node.start ?? 0, node.end ?? 0)).join("\n");
  const names = imports.flatMap((node) => node.specifiers.map((specifier) => specifier.local.name));
  return buildToursAppScript(`${declarations}\nObject.assign(globalThis, { ${names.join(",")} });`);
}
