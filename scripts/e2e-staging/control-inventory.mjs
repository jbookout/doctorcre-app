// Offline source census. No browser, HTTP or control-handler executions.
// Static candidates are not a claim about live visibility or data-row counts.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { screens } from './screens.mjs';
import { inventory } from './controls.mjs';
import { canonicalIdentity } from './traversal.mjs';
import { validControlProof } from './control-proofs.mjs';
import { mountMorningBrief } from '../../js/morning-brief.js';
import currentCatalog from '../../contracts/e2e-staging-control-proofs.v1.json' with { type: 'json' };
import routes from '../../contracts/app-routes.v1.json' with { type: 'json' };
const root = fileURLToPath(new URL('../../', import.meta.url));
const catalog = process.argv[3] ? JSON.parse(await readFile(process.argv[3], 'utf8')) : currentCatalog;
// An explicit historical catalog reproduces its former admission coverage.
// Current coverage requires a complete observable-effect proof.
const covered = new Set(catalog.controls.filter(row => process.argv[3] || validControlProof(row)).map(row => canonicalIdentity(row.identity)));
const reviewedCandidates = new Set(catalog.controls.filter(row => row.review?.candidate && validControlProof(row))
  .map(row => JSON.stringify([row.review.path, row.review.source, row.review.candidate])));
const familyKey = row => JSON.stringify([row.source.split(':')[0], row.selector.startsWith('#') ? row.selector : row.role + '@' + (row.source.split(':')[1] || row.selector), row.inputType, row.optionValue ?? null]);
const escape = text => String(text).replaceAll('|', '&#124;').replaceAll('\n', ' ').replaceAll('`', '');
function pageFor(html, path) {
  const dom = new JSDOM(html, { url: 'https://staging.invalid' + path, runScripts: 'outside-only' });
  const { window } = dom;
  window.CSS = { escape: value => value };
  // This census includes hidden/disclosed static states. CSS/live visibility is unknown.
  window.Element.prototype.checkVisibility = () => true;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 });
  const page = { locator: selector => ({ evaluateAll: async (fn, arg) => {
    window.nodes = [...window.document.querySelectorAll(selector)]; window.argument = arg;
    return window.eval('(' + fn.toString() + ')(window.nodes, window.argument)');
  } }) };
  return { dom, page };
}
async function sourceGraph(entry) {
  const visited = new Map();
  async function visit(file) {
    if (visited.has(file) || !file.startsWith(root) || !/\.(?:html|m?js)$/.test(file)) return;
    const text = await readFile(file, 'utf8'); visited.set(file, text);
    const references = file.endsWith('.html') ? [...text.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map(row => row[1])
      : [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g)].map(row => row[1]);
    for (const ref of references) {
      if (!ref.startsWith('.') && !ref.startsWith('/') || ref.includes('://')) continue;
      const asset = ref === '/share.js' || ref === '/share-bootstrap.js' ? 'reports' + ref
        : ref.startsWith('/vendor/') ? 'reports' + ref : '.' + ref;
      await visit(ref.startsWith('/') ? resolve(root, asset) : resolve(dirname(file), ref));
    }
  }
  await visit(resolve(root, entry)); return visited;
}
const result = [];
for (const screen of await screens()) {
  const pathname = new URL(screen.path, 'https://staging.invalid').pathname;
  const asset = routes.routes[pathname] || (pathname.startsWith('/control-room/progress/board/') ? 'progress-board.html' : pathname.slice(1));
  const rows = new Map();
  const add = (control, source, conditional) => {
    if (control.disabled) return;
    const key = JSON.stringify([control.selector.startsWith('#') ? control.selector : source + ':' + control.selector,
      control.role, control.inputType, control.optionValue || null]);
    const old = rows.get(key);
    const entry = { selector: control.selector, name: control.name, role: control.role, inputType: control.inputType,
      optionValue: control.optionValue, source, conditional,
      identity: control.identity,
      covered: covered.has(control.identity) || reviewedCandidates.has(JSON.stringify([screen.path, source, control.selector])) };
    if (!old || entry.covered) rows.set(key, entry);
  };
  const graph = await sourceGraph(asset);
  for (const [file, text] of graph) {
    const source = relative(root, file);
    if (file.endsWith('.html')) {
      const { dom, page } = pageFor(text, screen.path);
      for (const row of await inventory(page)) add(row, source, false);
      dom.window.close();
    }
    const scripts = file.endsWith('.html')
      ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(row => ({ text: row[1], offset: row.index }))
      : [{ text, offset: 0 }];
    for (const script of scripts) {
      // Each literal opening tag represents a source control family. Interpolated
      // IDs/attributes remain symbolic; lists can generate unbounded instances.
      for (const tag of script.text.matchAll(/<[a-z][a-z0-9-]*\b[^>]*>/gi)) {
        if (!/<(?:button|input|textarea|a|select|summary)\b|\brole\s*=|\baria-(?:pressed|expanded)\s*=/.test(tag[0])) continue;
        const line = text.slice(0, script.offset + tag.index).split('\n').length;
        const selectEnd = /^<select\b/i.test(tag[0]) ? script.text.indexOf('</select>', tag.index) : -1;
        const literal = selectEnd >= 0 ? script.text.slice(tag.index, selectEnd + 9) : tag[0];
        const markup = literal.replace(/\$\{[^}]*\}/g, 'DYNAMIC');
        const { dom, page } = pageFor(markup, screen.path);
        for (const row of await inventory(page)) add(row, source + ':' + line, true);
        dom.window.close();
      }
      // Programmatically created controls are conditional families too. The
      // helper's arguments/name are unknown without execution; retain its line.
      for (const factory of script.text.matchAll(/\b(?:createElement|create)\(\s*["'`](button|input|textarea|a|select|summary)["'`]/g)) {
        const line = text.slice(0, script.offset + factory.index).split('\n').length;
        const tag = factory[1];
        const { dom, page } = pageFor(`<${tag}${tag === 'a' ? ' href="DYNAMIC"' : ''}></${tag}>`, screen.path);
        for (const row of await inventory(page)) add(row, source + ':' + line, true);
        dom.window.close();
      }
    }
  }
  // Verify the catalog identity against the app-owned local handler's DOM,
  // including its header ownership. Do not grant from a selector alone.
  if (graph.has(resolve(root, 'js/morning-brief.js'))) {
    const { dom, page } = pageFor('<body><button id="docMorning" hidden></button></body>', screen.path), { window } = dom;
    const brief = mountMorningBrief({ document: window.document, window, automatic: false,
      getClient: async () => { throw new Error('Offline source census'); } });
    for (const row of await inventory(page)) add(row, 'js/morning-brief.js', true);
    brief.dispose(); window.close();
  }
  result.push({ path: screen.path, asset, controls: [...rows.values()] });
}
const controls = result.flatMap(screen => screen.controls);
const totals = { paths: result.length, enabledCandidateFamilies: controls.length,
  covered: controls.filter(row => row.covered).length, uncovered: controls.filter(row => !row.covered).length,
  conditional: controls.filter(row => row.conditional).length };
const rankedFamilies = [...Map.groupBy(controls, familyKey)].map(([key, rows]) => ({
  key, source: rows[0].source, selector: rows[0].selector, name: rows[0].name, role: rows[0].role,
  controls: rows.length, covered: rows.filter(row => row.covered).length, uncovered: rows.filter(row => !row.covered).length,
  paths: result.filter(screen => screen.controls.some(row => familyKey(row) === key)).map(screen => screen.path),
})).sort((a, b) => b.controls - a.controls || a.key.localeCompare(b.key));
Object.assign(totals, { distinctFamilies: rankedFamilies.length,
  coveredFamilies: rankedFamilies.filter(row => row.covered > 0).length,
  fullyCoveredFamilies: rankedFamilies.filter(row => row.uncovered === 0).length,
  uncoveredFamilies: rankedFamilies.filter(row => row.uncovered > 0).length });
// Repeated shared controls are listed once, then referenced by each path. This
// keeps the exhaustive source-family table within GitHub's PR body limit.
const groups = new Map();
for (const screen of result) {
  const bySource = Map.groupBy(screen.controls, row => row.source.split(':')[0]);
  screen.groups = [...bySource].map(([source, rows]) => {
    const signature = JSON.stringify(rows.map(({ covered, identity, ...row }) => row));
    const key = source + '|' + signature;
    if (!groups.has(key)) {
      const siblings = [...groups.values()].filter(group => group.source === source);
      groups.set(key, { label: source + (siblings.length ? ' (variant ' + (siblings.length + 1) + ')' : ''), source, rows });
    }
    return groups.get(key).label;
  });
}
const describe = row => {
  const line = row.source.split(':')[1];
  const label = row.selector.startsWith('#') ? row.selector : row.role + (line ? '@' + line : ' ' + row.selector);
  return `${row.conditional ? '? ' : ''}${escape(label)}${row.inputType ? ' type=' + escape(row.inputType) : ''}${row.optionValue !== undefined ? ' option=' + escape(row.optionValue) : ''}${row.name ? ' (' + escape(row.name).slice(0, 55) + ')' : ''}`;
};
const table = ['## Control coverage', '',
  'Offline static-source census using the sweep inventory (no browser/staging requests). Every one of the 31 paths appears below. Disabled literals are excluded; hidden/disclosed markup states are included. The source groups enumerate every detected enabled candidate; each path references its complete groups. “?” means conditional JS markup or element factory; interpolated attributes stay DYNAMIC. Lists/options can expand to more instances. CSS visibility, factory attributes, runtime-composed markup and live data are not measured: these are source-family counts, not an exact live enabled-control denominator.', '',
  `Path/control candidate pairs: ${totals.enabledCandidateFamilies}; catalog-covered: ${totals.covered}; uncovered: ${totals.uncovered}; conditional: ${totals.conditional}. These source counts are per path. Viewport visibility is unmeasured, so they are not doubled for the two sweep viewports.`, '',
  `The catalog has ${catalog.controls.length} prepared identities across ${totals.coveredFamilies} covered source families. Candidate coverage means a checked-in proof exists for reviewed finite DOM states of the family; it does not mean every runtime variant matches. Live admission still requires the exact full identity and source pair. Every proof requires its named, causally attributed DOM transition or same-origin API operation. Visibility, conditional expansion and data-dependent ownership remain unmeasured; unsupported variants skip. There are ${result.length * 2} path/viewport pairs.`, '',
  '| Screen path | Covered | Uncovered | Complete source groups |', '|---|---:|---:|---|',
  ...result.map(screen => `| ${escape(screen.path)} | ${screen.controls.filter(row => row.covered).length} | ${screen.controls.filter(row => !row.covered).length} | ${screen.groups.map(escape).join('; ')} |`), '',
  '### Enabled candidate families by source group', '',
  'Static selects list each enabled literal option; symbolic options remain conditional. Factory controls have unknown attributes (including enabled state); anonymous controls are named by role and source line (or their static CSS selector).', '',
  '| Source group | Enabled candidates (? conditional) |', '|---|---|',
  ...[...groups.values()].map(group => `| ${escape(group.label)} | ${group.rows.map(describe).join('<br>')} |`), '',
  'Reproduce after npm run build: node scripts/e2e-staging/control-inventory.mjs <output-prefix>. The JSON companion preserves selectors, names, input types/options and source lines. Runtime expansion remains uncovered and must not be presented as measured live coverage.', ''].join('\n');
const prefix = process.argv[2];
if (!prefix) throw new Error('Provide an output prefix outside the source tree');
await writeFile(prefix + '.json', JSON.stringify({ totals, families: rankedFamilies, screens: result }, null, 2));
await writeFile(prefix + '.txt', table);
console.log(JSON.stringify({ ...totals, tableBytes: Buffer.byteLength(table), output: prefix }));
