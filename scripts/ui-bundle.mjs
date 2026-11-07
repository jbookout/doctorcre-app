import { build } from "esbuild";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

// React islands compile to browser modules with a shared runtime. The island
// sources are read through readSource, so an artifact verified from committed
// bytes compiles committed bytes; React itself resolves from the lockfile's
// install in this checkout.
export const UI_SOURCE = "src/ui";
export const UI_ENTRY = `${UI_SOURCE}/index.tsx`;
const INSTALL = fileURLToPath(new URL("../", import.meta.url));

export const FORM_ENTRY = `${UI_SOURCE}/deal-room-forms.tsx`;
const UI_ENTRIES = {
  'ui-portal': 'portal/shell-home-sources',
  'ui-answers': 'answer-blocks',
  'ui-keyboard-input': 'keyboard-input',
  'ui-quick-switcher': 'quick-switcher',
  'ui-switcher-history': 'switcher-history',
  'ui-email-actions': 'email-followup-actions',
  'ui-host': 'host-node',
  'ui-zoom': 'workspace-zoom',
  'ui-facts': 'fact-review',
  'ui-market': 'market-terms',
  'ui-limit': 'home-list-limit',
  'ui-reasons': 'contact-reasons',
  'ui-queue': 'brief-queues',
  'ui-action': 'action-link',
  'ui-call': 'call-review',
  'ui-board': 'deal-room-board',
  'ui-agenda': 'deal-room-agenda',
  'ui-lead': 'lead-guidance',
  'ui-ideal-client-profile': 'ideal-client-profile',
  'ui-territory-evidence': 'territory-evidence',
  'ui-quiet-leads': 'quiet-leads',
  'ui-quiet-vendors': 'quiet-vendors',
  'ui-calendar-panels': 'calendar-panels',
  'ui-deal-documents': 'deal-documents',
  'ui-deal-tours': 'deal-tours',
  'ui-inbox': 'inbox-entry',
  'ui-next-step': 'home/missing-next-step',
  'ui-task-done': 'home/task-done',
  'ui-deal-reviews': 'home/deal-update-reviews',
  'deal-room-forms.generated': 'deal-room-forms',
};
export const UI_ASSET_PATTERNS = [...Object.keys(UI_ENTRIES).map(name => `js/${name}.js`), 'js/ui-shared-*.generated.js'];
const UI_OUTPUTS = new Set(UI_ASSET_PATTERNS.slice(0, -1));
export const isUiAsset = path => UI_OUTPUTS.has(path) || /^js\/ui-shared-[A-Z0-9]+\.generated\.js$/.test(path);

export async function uiBundle(readSource, entry = UI_ENTRY) {
  const result = await buildUi(readSource, { entryPoints: [entry] });
  return Buffer.from(result.outputFiles[0].contents);
}

export async function uiAssets(readSource) {
  const result = await buildUi(readSource, {
    entryPoints: Object.fromEntries(Object.entries(UI_ENTRIES).map(([name, path]) => [
      name, `${UI_SOURCE}/${path}`,
    ])),
    splitting: true, outdir: 'js', chunkNames: 'ui-shared-[hash].generated',
  });
  return new Map(result.outputFiles.map(file => [posix.relative(INSTALL, file.path), Buffer.from(file.contents)]));
}

async function buildUi(readSource, options) {
  const read = async (path) => {
    try {
      const source = await readSource(path);
      return source == null ? null : String(source);
    } catch { return null; }
  };
  const result = await build({
    ...options, absWorkingDir: INSTALL, bundle: true, write: false, format: "esm",
    platform: "browser", target: "es2022", minify: true, legalComments: "eof", jsx: "automatic",
    tsconfigRaw: "{}", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "ui-source", setup(builder) {
      // Island imports are relative and extensionless; each must name an
      // admitted .tsx or .ts file under src/ui/, or the shared read budget.
      builder.onResolve({ filter: /^\.|^src\/ui\// }, async (args) => {
        if (args.kind !== "entry-point" && args.namespace !== "ui-source") return undefined;
        const base = args.kind === "entry-point" ? posix.normalize(args.path)
          : posix.normalize(posix.join(posix.dirname(args.importer), args.path));
        if (['js/read-budget.mjs', 'js/email-action-receipt.mjs'].includes(base)) {
          const contents = await read(base);
          if (contents !== null) return { path: base, namespace: 'ui-source', pluginData: contents };
        }
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
  return result;
}
