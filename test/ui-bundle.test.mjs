import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { init, parse } from 'es-module-lexer';
import { spawnSync } from 'node:child_process';
import { ClientLint } from '../scripts/client-lint-rules.mjs';
import { isUiAsset, uiAssets } from '../scripts/ui-bundle.mjs';

const readSource = path => readFile(new URL('../' + path, import.meta.url));

test('lead guidance loads without unrelated page UI and shares the React runtime with deal forms', async () => {
  const assets = await uiAssets(readSource);
  await init;
  function dependencies(entry, found = new Set()) {
    if (found.has(entry)) return found;
    found.add(entry);
    assert.ok(assets.has(entry), `emitted module ${entry}`);
    const [imports] = parse(assets.get(entry).toString());
    for (const reference of imports.filter(row => row.d === -1 && row.n?.startsWith('.'))) {
      dependencies(new URL(reference.n, `https://fixture.invalid/${entry}`).pathname.slice(1), found);
    }
    return found;
  }
  const leads = dependencies('js/ui-lead.generated.js');
  const forms = dependencies('js/ui-deal-room-forms.generated.js');
  const source = [...leads].map(path => assets.get(path).toString()).join('\n');
  assert.ok(!source.includes('Research for the new organization or sub-client'));
  assert.ok(!source.includes('Record term'));
  assert.ok(!source.includes('Inbox unavailable.'));
  const shared = [...leads].filter(path => forms.has(path));
  assert.ok(shared.length > 0, 'one shared React runtime');
});

test('only emitted UI entries and shared chunks bypass source checks', async () => {
  const assets = await uiAssets(readSource);
  assert.ok(assets.has('js/ui-facts.generated.js'));
  assert.ok(assets.has('js/ui-checklist.generated.js'));
  assert.ok(assets.has('js/ui-activity-attribution.generated.js'));
  assert.ok(assets.has('js/ui-relationship-kind-filter.generated.js'));
  assert.ok(assets.has('js/ui-ideal-client-profile.generated.js'));
  assert.ok(!assets.has('js/ui-workspace.js'));
  const lint = new ClientLint();
  const paths = [...assets.keys(), 'js/ui-handwritten.js', 'js/other.generated.js', 'js/ui.generated.js', 'js/ui-workspace.js'];
  const ignored = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { input: paths.join('\n'), encoding: 'utf8' });
  assert.ok([0, 1].includes(ignored.status), ignored.stderr);
  const gitIgnored = new Set(ignored.stdout.trim().split('\n'));
  for (const path of paths) {
    const generated = assets.has(path);
    assert.equal(isUiAsset(path), generated, `artifact classification ${path}`);
    assert.equal(await lint.isPathIgnored(path), generated, `lint classification ${path}`);
    assert.equal(gitIgnored.has(path), generated, `git classification ${path}`);
  }
});

test('Home critical imports keep preparation rendering behind the lazy boundary', async () => {
  const assets = await uiAssets(readSource);
  await init;
  const found = new Set();
  async function visit(path) {
    if (found.has(path)) return;
    found.add(path);
    const source = (assets.get(path) ?? await readSource(path)).toString();
    const [imports] = parse(source);
    for (const reference of imports.filter(row => row.d === -1 && row.n?.startsWith('.'))) {
      await visit(new URL(reference.n, `https://fixture.invalid/${path}`).pathname.slice(1));
    }
  }
  await visit('js/app-shell.js');
  await visit('js/ui-inbox.generated.js');
  const lifetime = 'js/ui-meeting-preparation-lifetime.generated.js';
  assert.ok(found.has(lifetime), 'Home and preparation share the emitted lifetime');
  assert.equal(parse((await readSource('src/ui/meeting-preparation-lifetime.ts')).toString())[0].length, 0, 'lifetime source has no runtime imports');
  for (const path of ['js/meeting-preparation.js', 'js/home-dashboard-model.js', 'js/home-call-tasks.js']) {
    assert.ok(!found.has(path), `${path} must load only when its UI is requested`);
  }
});
