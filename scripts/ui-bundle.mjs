import { build } from 'vite';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

// React islands: strict TypeScript under src/ui/, shipped as one generated
// browser module that a page imports on demand or while its flag is on. The island
// sources are read through readSource, so an artifact verified from committed
// bytes compiles committed bytes; React itself resolves from the lockfile's
// install in this checkout.
export const UI_SOURCE = 'src/ui';
export const UI_ENTRY = `${UI_SOURCE}/index.tsx`;
export const UI_OUTPUT = 'js/ui.generated.js';
const INSTALL = fileURLToPath(new URL('../', import.meta.url));

export async function uiBundle(readSource) {
  const prefix = '\0doctorcre:';
  const result = await build({
    root: INSTALL, configFile: false, envFile: false, publicDir: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: { write: false, target: 'es2022', minify: true,
      lib: { entry: UI_ENTRY, formats: ['es'], fileName: () => 'ui.generated.js' },
      rolldownOptions: { output: { codeSplitting: false } },
    },
    plugins: [{ name: 'committed-ui-source', enforce: 'pre',
      async resolveId(source, importer) {
        if (source !== UI_ENTRY && !importer?.startsWith(prefix)) return;
        if (source !== UI_ENTRY && !source.startsWith('.')) return;
        const base = source === UI_ENTRY ? source : posix.normalize(posix.join(posix.dirname(importer.slice(prefix.length)), source));
        // Island imports name an admitted .tsx or .ts file under src/ui/, or the shared read budget.
        if (base === 'js/read-budget.mjs') { try { if (await readSource(base) != null) return prefix + base; } catch {} }
        for (const path of [base, `${base}.tsx`, `${base}.ts`]) {
          if (!path.startsWith(`${UI_SOURCE}/`) || !/\.tsx?$/.test(path)) continue;
          try { if (await readSource(path) != null) return prefix + path; } catch {}
        }
        throw Error(`UI import is not admitted: ${source}`);
      },
      async load(id) { if (id.startsWith(prefix)) return String(await readSource(id.slice(prefix.length))); },
    }],
  });
  const output = Array.isArray(result) && result.length === 1 ? result[0] : result;
  if (!output || Array.isArray(output) || !('output' in output)) throw Error('Expected one Vite build output');
  const chunks = output.output.filter(chunk => chunk.type === 'chunk');
  if (chunks.length !== 1 || output.output.length !== 1) throw Error('Expected one self-contained UI module');
  return Buffer.from(chunks[0].code);
}
