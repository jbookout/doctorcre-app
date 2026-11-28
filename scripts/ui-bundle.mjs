import { build } from "esbuild";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

// React islands compile to browser modules with a shared runtime. The island
// sources are read through readSource, so an artifact verified from committed
// bytes compiles committed bytes; React itself resolves from the lockfile's
// install in this checkout.
export const UI_SOURCE = "src/ui";
const UI_ENTRY = `${UI_SOURCE}/index.tsx`;
const INSTALL = fileURLToPath(new URL("../", import.meta.url));

export const FORM_ENTRY = `${UI_SOURCE}/deal-room-forms.tsx`;
export const UI_ENTRIES = {
  'ui-lead-reachability': 'lead-reachability',
  'ui-tour-coordinate-review': 'tour-coordinate-review',
  'ui-tour-navigation': 'tour-navigation',
  'ui-tour-stop-drag': 'tour-stop-drag',
  'ui-broker-cheat-sheet': 'broker-cheat-sheet',
  'ui-phone-push': 'phone-push',
  'ui-phone-call-recovery': 'phone-call-recovery',
  'ui-doc-link-settings': 'doc-link-settings',
  'ui-action-session-return': 'action-session-return',
  'ui-watches': 'watches/control',
  'ui-relationship-kind-filter': 'relationship-kind-filter',
  'ui-client-anniversaries': 'client-anniversaries',
  'ui-client-anniversaries-entry': 'client-anniversaries-entry',
  'ui-activity-attribution': 'activity-attribution',
  'ui-portal': 'portal/shell-home-sources',
  'ui-answers': 'answer-blocks',
  'ui-keyboard-input': 'keyboard-input',
  'ui-keyboard-shortcuts': 'keyboard-shortcuts',
  'ui-record-links': 'record-links',
  'ui-relationship-shapes': 'relationship-shapes',
  'ui-card-menu': 'card-quick-menu',
  'ui-scroll-thumb': 'scroll-thumb',
  'ui-new-version': 'new-version',
  'ui-quick-switcher': 'quick-switcher',
  'ui-switcher-history': 'switcher-history',
  'ui-email-actions': 'email-followup-actions',
  'ui-host': 'host-node',
  'ui-zoom': 'workspace-zoom',
  'ui-limit': 'home-list-limit',
  'ui-reasons': 'contact-reasons',
  'ui-action': 'action-link',
  'ui-call': 'call-review',
  'ui-board': 'deal-room-board',
  'ui-automatic-phase-undo': 'automatic-phase-undo',
  'ui-agenda': 'deal-room-agenda',
  'ui-monday-review': 'monday-review',
  'ui-lead-opportunity-timing': 'lead-opportunity-timing',
  'ui-lead-research': 'lead-research',
  'ui-lead': 'lead-guidance',
  'ui-ideal-client-profile': 'ideal-client-profile',
  'ui-vendor-meetings': 'vendor-meetings',
  'ui-deal-prospects': 'deal-prospects',
  'ui-deal-documents': 'deal-documents',
  'ui-doc-chat': 'doc-chat',
  'ui-checklist': 'deal-checklist',
  'ui-deal-suggestion-email': 'deal-suggestion-email',
  'ui-deal-path': 'deal-path',
  'ui-deal-diagram': 'deal-diagram',
  'ui-client-deals': 'client-deals',
  'ui-vendor-relationships': 'vendor-relationships',
  'ui-deal-client-portal': 'deal-client-portal',
  'ui-timeline': 'timeline',
  'ui-deal-plan': 'deal-plan',
  'ui-deal-tours': 'deal-tours',
  'ui-deal-tour-plans': 'deal-tour-plans',
  'ui-inbox': 'inbox-entry',
  'ui-email-fold': 'home/email-signature',
  'ui-deal-activity': 'deal-activity',
  'ui-deal-overview-side': 'deal-overview-side',
  'ui-home-today': 'home/today-panel',
  'ui-next-step': 'home/missing-next-step',
  'ui-task-done': 'home/task-done',
  'ui-deal-reviews': 'home/deal-update-reviews',
  'ui-deal-room-forms': 'deal-room-forms',
  'ui-name-match': 'name-match',
  'ui-party-editor': 'party-editor',
};
export const isUiAsset = path => path === 'public-shell/sw.js' || /^js\/ui-[^/]*\.generated\.js$/.test(path);

export async function uiBundle(readSource, entry = UI_ENTRY) {
  const result = await buildUi(readSource, { entryPoints: [entry] });
  return Buffer.from(result.outputFiles[0].contents);
}

export async function uiAssets(readSource) {
  const result = await buildUi(readSource, {
    entryPoints: Object.fromEntries(Object.entries(UI_ENTRIES).map(([name, path]) => [
      name, `${UI_SOURCE}/${path}`,
    ])),
    splitting: true, outdir: 'js', entryNames: '[name].generated', chunkNames: 'ui-shared-[hash].generated',
  });
  const assets = new Map(result.outputFiles.map(file => [posix.relative(INSTALL, file.path), Buffer.from(file.contents)]));
  const worker = await buildUi(readSource, { entryPoints: [`${UI_SOURCE}/worker/service-worker.ts`], format: 'iife' });
  assets.set('public-shell/sw.js', Buffer.from(worker.outputFiles[0].contents));
  return assets;
}

async function buildUi(readSource, options) {
  const read = async (path) => {
    try {
      const source = await readSource(path);
      return source == null ? null : String(source);
    } catch { return null; }
  };
  const result = await build({
    absWorkingDir: INSTALL, bundle: true, write: false, format: "esm",
    platform: "browser", target: "es2022", minify: true, legalComments: "eof", jsx: "automatic",
    tsconfigRaw: "{}", define: { "process.env.NODE_ENV": '"production"' },
    ...options,
    plugins: [{ name: "ui-source", setup(builder) {
      // Island imports are relative and extensionless; each must name an
      // admitted .tsx or .ts file under src/ui/, or the shared read budget.
      builder.onResolve({ filter: /^\.|^src\/ui\// }, async (args) => {
        if (args.kind !== "entry-point" && args.namespace !== "ui-source") return undefined;
        const base = args.kind === "entry-point" ? posix.normalize(args.path)
          : posix.normalize(posix.join(posix.dirname(args.importer), args.path));
        if (['js/boot-mode.js', 'js/business-date.js', 'js/routes.js', 'js/read-budget.mjs', 'js/email-action-receipt.mjs', 'js/visibility-poll.mjs', 'js/read-on-resume.mjs', 'js/toast.js', 'js/touch-layout.js', 'contracts/client-needs.v1.json'].includes(base)) {
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
        contents: args.pluginData, loader: args.path.endsWith('.json') ? 'json' : args.path.endsWith(".tsx") ? "tsx" : "ts", resolveDir: INSTALL,
      }));
    } }],
  });
  return result;
}
