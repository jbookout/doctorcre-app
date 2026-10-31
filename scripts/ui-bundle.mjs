import { build } from "esbuild";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

// React islands: strict TypeScript under src/ui/, shipped as one generated
// browser module that a page imports on demand or while its flag is on. The island
// sources are read through readSource, so an artifact verified from committed
// bytes compiles committed bytes; React itself resolves from the lockfile's
// install in this checkout.
export const UI_SOURCE = "src/ui";
export const UI_ENTRY = `${UI_SOURCE}/index.tsx`;
export const UI_OUTPUT = "js/ui.generated.js";
const INSTALL = fileURLToPath(new URL("../", import.meta.url));

export async function uiBundle(readSource) {
  const read = async (path) => {
    try {
      const source = await readSource(path);
      return source == null ? null : String(source);
    } catch { return null; }
  };
  const result = await build({
    entryPoints: [UI_ENTRY], absWorkingDir: INSTALL, bundle: true, write: false, format: "esm",
    platform: "browser", target: "es2022", minify: true, legalComments: "eof", jsx: "automatic",
    tsconfigRaw: "{}", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "ui-source", setup(builder) {
      // Island imports are relative and extensionless; each must name an
      // admitted .tsx or .ts file under src/ui/.
      builder.onResolve({ filter: /^\.|^src\/ui\// }, async (args) => {
        if (args.kind !== "entry-point" && args.namespace !== "ui-source") return undefined;
        const base = args.kind === "entry-point" ? posix.normalize(args.path)
          : posix.normalize(posix.join(posix.dirname(args.importer), args.path));
        for (const path of [base, `${base}.tsx`, `${base}.ts`]) {
          if (!path.startsWith(`${UI_SOURCE}/`) || !/\.tsx?$/.test(path)) continue;
          const contents = await read(path);
          if (contents !== null) return { path, namespace: "ui-source", pluginData: contents };
        }
        throw new Error(`UI import is not an admitted ${UI_SOURCE} source: ${args.path}`);
      });
      builder.onLoad({ filter: /.*/, namespace: "ui-source" }, (args) => ({
        contents: args.pluginData, loader: args.path.endsWith(".tsx") ? "tsx" : "ts", resolveDir: INSTALL,
      }));
    } }],
  });
  return Buffer.from(result.outputFiles[0].contents);
}
