// Run explicitly after the family fixtures pass. This compiler uses app-owned
// handlers and offline DOM; preparation consumes only the committed catalog.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { catalogFixture } from './catalog-fixture.mjs';
import { families } from './catalog-families.mjs';
import { inventory } from '../../scripts/e2e-staging/controls.mjs';
import { canonicalIdentity } from '../../scripts/e2e-staging/traversal.mjs';
import { screens } from '../../scripts/e2e-staging/screens.mjs';
const file = new URL('../../contracts/e2e-staging-control-proofs.v1.json', import.meta.url);
const ceiling = setTimeout(() => { console.error('Offline catalog compilation exceeded twelve minutes'); process.exit(1); }, 720_000);
ceiling.unref();
const catalog = JSON.parse(await readFile(file, 'utf8'));
const selected = process.argv.slice(2);
if (selected.some(id => !families.some(row => row.id === id)) || new Set(selected).size !== selected.length)
  throw new Error('Choose distinct reviewed family IDs');
const selectedFamilies = selected.length ? families.filter(row => selected.includes(row.id)) : families;
// Preserve the independently reviewed morning-close identities used by the
// preparation integration fixture, including all sponsor dialog titles.
const controls = catalog.controls.filter(row => row.review.policy === 'dismiss-morning-brief.v1' || selected.length && !selected.includes(row.review.family)).map(row =>
  row.review.policy === 'dismiss-morning-brief.v1' ? { ...row,
    observations: [{ selector: '#docMorningBrief', attribute: 'open', transitions: [{ from: '', to: null }] }],
    review: { ...row.review, family: 'close-morning-brief' } } : row);
const seen = new Map(controls.map(row => [canonicalIdentity(row.identity), row]));
// Measure every path. Shared markup does not imply shared ownership: the
// surrounding page's controls and selected views belong to the full identity.
const paths = (await screens()).map(row => row.path).filter(path => path !== '/share');
for (const family of selectedFamilies) {
  for (const path of paths) {
    for (const phone of family.phoneOnly ? [true] : [false, true]) {
      for (const state of [0, 1]) for (const theme of ['dark', 'light']) for (const callAvailable of [false, true]) {
        // Only the avatar's own accessible identity varies by sponsor. Other
        // controls include its selector, never its label, in their ownership.
        for (const actor of ['account-menu', 'close-morning-brief', 'close-profile'].includes(family.id) ? ['joe', 'dell'] : ['joe']) {
          const f = await catalogFixture({ path, phone, actor, theme, assist: state === 1, callAvailable });
          try {
            await family.setup?.(f, state);
            const node = f.window.document.querySelector(family.selector);
            const action = (await inventory(f.page)).find(row => f.window.document.querySelector(row.selector) === node);
            if (!action || action.disabled) throw new Error('Family fixture is not reachable: ' + family.id + ' ' + path);
            const observations = family.observations(f, state);
            {
              const identity = action.identity;
              const key = canonicalIdentity(identity);
              if (seen.has(key)) {
                const existing = seen.get(key);
                if (existing.observations.length !== observations.length) throw new Error('Observation conflict: ' + family.id);
                for (const effect of observations) {
                  if (effect.request) {
                    if (!existing.observations.some(row => JSON.stringify(row) === JSON.stringify(effect))) throw new Error('Request observation conflict: ' + family.id);
                    continue;
                  }
                  const target = existing.observations.find(row => row.selector === effect.selector && row.attribute === effect.attribute);
                  if (!target) throw new Error('Observation selector conflict: ' + family.id);
                  for (const transition of effect.transitions) if (!target.transitions.some(row => row.from === transition.from && row.to === transition.to)) target.transitions.push(transition);
                }
                continue;
              }
              const entry = { identity, effects: observations.filter(row => row.request).map(row => ({ operation: row.request.operation,
                arguments: row.request.operation === 'deal-room-board' ? { workspace: 'all' } : {} })), observations: structuredClone(observations), review: { policy: family.id + '.v1', family: family.id,
                path, source: family.source, candidate: family.candidate,
                handler: 'App-owned handler; every declared DOM transition or same-origin API operation must be causally observed',
                fixture_test: 'tests/staging-live/catalog-families.test.mjs' } };
              controls.push(entry); seen.set(key, entry);
            }
          } finally { f.close(); }
        }
      }
    }
  }
  console.log(family.id + ': compiled; ' + controls.length + ' identities total');
}
catalog.reviewed_source_commit = execFileSync('git', ['rev-parse', '8739b120'], { encoding: 'utf8' }).trim();
catalog.controls = controls.map(row => ({ ...row, identity: canonicalIdentity(row.identity) }));
// One finite proof per line keeps the catalog reviewable; preparation uses the
// exact same full-state SHA-256 identities as live inventory.
const { controls: entries, ...metadata } = catalog;
await writeFile(file, JSON.stringify(metadata, null, 2).slice(0, -2) + ',\n  "controls": [\n' + entries.map(row => '    ' + JSON.stringify(row)).join(',\n') + '\n  ]\n}\n');
console.log('Catalog written: ' + controls.length + ' identities across ' + families.length + ' families');
clearTimeout(ceiling);
