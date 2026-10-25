import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/ui/workspace-layout.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { validateLayout, insertPanel, movePanel, removePanel, resizeSplit, resizeFloating, migrateLayout } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const tabs = (id, panels, active = panels[0]) => ({ kind: 'tabs', id, panels, active });
const empty = () => ({ version: 1, stage: null, floating: [], hidden: [] });
const initial = () => ({ ...empty(), stage: tabs('main', ['deals', 'leads']) });
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('insert a panel into an empty stage, then insert an ordered active tab without mutating the source', () => {
  const source = freeze(empty());
  const one = insertPanel(source, 'deals', { kind: 'stage', group: 'main' });
  assert.deepEqual(one, { ...empty(), stage: tabs('main', ['deals']) });
  assert.deepEqual(insertPanel(freeze(one), 'leads', { kind: 'tabs', group: 'main', index: 0 }),
    { ...empty(), stage: tabs('main', ['leads', 'deals'], 'leads') });
  assert.deepEqual(source, empty());
});

test('split a group and move tabs between docked, floating and hidden placements', () => {
  const source = freeze(initial());
  const split = insertPanel(source, 'today', { kind: 'split', target: 'main', id: 'columns', group: 'aside', axis: 'horizontal', side: 'after', ratio: 0.7 });
  assert.deepEqual(split.stage, { kind: 'split', id: 'columns', axis: 'horizontal', ratio: 0.7,
    first: tabs('main', ['deals', 'leads']), second: tabs('aside', ['today']) });
  const floating = movePanel(freeze(split), 'leads', { kind: 'floating', x: 20, y: 30, width: 640, height: 480 });
  assert.deepEqual(floating.floating, [{ panel: 'leads', x: 20, y: 30, width: 640, height: 480 }]);
  assert.deepEqual(floating.stage.first, tabs('main', ['deals']));
  const hidden = movePanel(freeze(floating), 'leads', { kind: 'hidden' });
  assert.deepEqual(hidden.hidden, ['leads']);
  assert.deepEqual(hidden.floating, []);
  const restored = movePanel(freeze(hidden), 'leads', { kind: 'tabs', group: 'aside' });
  assert.deepEqual(restored.stage.second, tabs('aside', ['today', 'leads'], 'leads'));
  assert.deepEqual(restored.hidden, []);
  assert.deepEqual(source, initial());
});

test('resize a split and floating panel without changing panel placement', () => {
  let layout = insertPanel(initial(), 'today', { kind: 'split', target: 'main', id: 'columns', group: 'aside', axis: 'horizontal', side: 'after', ratio: 0.7 });
  layout = movePanel(layout, 'leads', { kind: 'floating', x: 20, y: 30, width: 640, height: 480 });
  const source = freeze(layout);
  const resized = resizeSplit(source, 'columns', 0.4);
  assert.deepEqual(resized.stage, { ...source.stage, ratio: 0.4 });
  const bounds = { x: -10, y: 0, width: 800, height: 600 };
  const result = resizeFloating(freeze(resized), 'leads', bounds);
  assert.deepEqual(result.floating, [{ panel: 'leads', ...bounds }]);
  assert.deepEqual(source.floating, [{ panel: 'leads', x: 20, y: 30, width: 640, height: 480 }]);
  for (const ratio of [0, 1, -1, NaN, Infinity]) assert.throws(() => resizeSplit(source, 'columns', ratio));
  assert.throws(() => resizeSplit(source, 'main', 0.5));
  assert.throws(() => resizeFloating(source, 'deals', bounds));
  for (const bad of [{ ...bounds, width: 0 }, { ...bounds, height: -1 }, { ...bounds, x: NaN }])
    assert.throws(() => resizeFloating(source, 'leads', bad));
});

test('remove an active tab, collapse empty split branches, and remove the final panel', () => {
  const source = freeze({ ...initial(), stage: tabs('main', ['deals', 'leads', 'calls'], 'leads') });
  assert.deepEqual(removePanel(source, 'leads').stage, tabs('main', ['deals', 'calls'], 'calls'));
  assert.deepEqual(removePanel({ ...source, stage: tabs('main', ['deals', 'leads'], 'leads') }, 'leads').stage, tabs('main', ['deals']));
  const nested = insertPanel(initial(), 'today', { kind: 'split', target: 'main', id: 'columns', group: 'aside', axis: 'vertical', side: 'before', ratio: 0.3 });
  assert.deepEqual(removePanel(freeze(nested), 'today'), initial());
  assert.deepEqual(removePanel({ ...empty(), stage: tabs('main', ['deals']) }, 'deals'), empty());
  assert.deepEqual(removePanel({ ...empty(), floating: [{ panel: 'deals', x: 0, y: 0, width: 1, height: 1 }] }, 'deals'), empty());
  assert.deepEqual(removePanel({ ...empty(), hidden: ['deals'] }, 'deals'), empty());
  assert.throws(() => removePanel(source, 'missing'));
});

test('reorder within a group using the final index, including its sole tab', () => {
  const source = freeze(initial());
  assert.deepEqual(movePanel(source, 'deals', { kind: 'tabs', group: 'main', index: 1 }).stage, tabs('main', ['leads', 'deals'], 'deals'));
  assert.deepEqual(movePanel(source, 'leads', { kind: 'tabs', group: 'main', index: 0 }).stage, tabs('main', ['leads', 'deals'], 'leads'));
  const single = freeze({ ...empty(), stage: tabs('main', ['deals']) });
  assert.deepEqual(movePanel(single, 'deals', { kind: 'tabs', group: 'main', index: 0 }), single);
  assert.throws(() => movePanel(single, 'deals', { kind: 'split', target: 'main', id: 'split', group: 'other', axis: 'vertical', side: 'after', ratio: 0.5 }));
});

test('migrate the explicit pre-release v0 format to v1 and read current JSON without aliasing', () => {
  const v0 = freeze({ version: 0, stage: tabs('main', ['deals']), floating: [{ panel: 'today', x: 0, y: 10, width: 300, height: 500 }] });
  const current = migrateLayout(v0);
  assert.deepEqual(current, { ...v0, version: 1, hidden: [] });
  const parsed = migrateLayout(JSON.parse(JSON.stringify(current)));
  assert.deepEqual(parsed, current);
  assert.notEqual(parsed.stage, current.stage);
  assert.notEqual(parsed.floating[0], current.floating[0]);
  assert.throws(() => migrateLayout({ ...v0, hidden: ['lost'] }));
  for (const version of [-1, 2, '1', undefined]) assert.throws(() => migrateLayout({ ...current, version }));
  assert.throws(() => migrateLayout({ ...v0, stage: tabs('main', ['deals'], 'missing') }));
});

test('validate all placements and reject corrupt, duplicate, cyclic or sparse documents', () => {
  const source = freeze({ ...initial(), floating: [{ panel: 'today', x: 0, y: 0, width: 1, height: 1 }], hidden: ['calls'] });
  const result = validateLayout(source);
  assert.deepEqual(result, source);
  assert.notEqual(result.stage.panels, source.stage.panels);
  const split = { kind: 'split', id: 'columns', axis: 'horizontal', ratio: 0.5, first: tabs('main', ['deals']), second: tabs('aside', ['today']) };
  for (const invalid of [
    null, {}, { ...source, version: 2 }, { ...source, stage: tabs('main', []) },
    { ...source, stage: tabs('main', ['deals'], 'missing') },
    { ...source, stage: tabs('main', ['deals', 'deals']) },
    { ...source, floating: [{ panel: 'deals', x: 0, y: 0, width: 1, height: 1 }] },
    { ...source, hidden: ['today'] }, { ...source, hidden: [''] },
    { ...source, stage: { ...split, second: tabs('main', ['today']) } },
    { ...source, stage: { ...split, axis: 'diagonal' } },
    { ...source, stage: { ...split, ratio: Infinity } },
    { ...source, stage: { ...split, first: null } },
    { ...source, floating: [{ panel: 'today', x: 0, y: 0, width: 0, height: 1 }] },
    { ...source, hidden: Array(1) }, { ...source, floating: Array(1) },
    { ...empty(), stage: tabs('main', ['deals', , 'leads']) },
  ]) assert.throws(() => validateLayout(invalid));
  const cycle = { ...split };
  cycle.first = cycle;
  assert.throws(() => validateLayout({ ...empty(), stage: cycle }));
  let deep = tabs('main', ['deals']);
  for (let i = 0; i < 140; i++) deep = { ...split, id: `split-${i}`, first: deep, second: tabs(`group-${i}`, [`panel-${i}`]) };
  assert.throws(() => validateLayout({ ...empty(), stage: deep }));
});

test('invalid operations fail atomically and never silently lose an existing panel', () => {
  const source = freeze(initial());
  const split = { kind: 'split', target: 'main', id: 'columns', group: 'aside', axis: 'horizontal', side: 'after', ratio: 0.5 };
  for (const destination of [
    { kind: 'missing' }, { kind: 'tabs', group: 'missing' },
    { kind: 'tabs', group: 'main', index: -1 }, { kind: 'tabs', group: 'main', index: 4 },
    { kind: 'tabs', group: 'main', index: 0.5 }, { kind: 'stage', group: 'other' },
    { ...split, target: 'missing' }, { ...split, id: 'main' }, { ...split, group: 'columns' },
    { ...split, axis: 'diagonal' }, { ...split, side: 'middle' }, { ...split, ratio: 1 },
    { kind: 'floating', x: 0, y: 0, width: -1, height: 1 },
  ]) {
    assert.throws(() => insertPanel(source, 'today', destination));
    assert.throws(() => movePanel(source, 'deals', destination));
    assert.deepEqual(source, initial());
  }
  assert.throws(() => insertPanel(source, 'deals', { kind: 'hidden' }));
  assert.throws(() => movePanel(source, 'missing', { kind: 'hidden' }));
});

test('nest splits around whole groups, then move a sole sibling tab and collapse its parent', () => {
  const columns = insertPanel(initial(), 'today', { kind: 'split', target: 'main', id: 'columns', group: 'aside', axis: 'horizontal', side: 'after', ratio: 0.7 });
  const nested = insertPanel(columns, 'calls', { kind: 'split', target: 'columns', id: 'rows', group: 'bottom', axis: 'vertical', side: 'before', ratio: 0.25 });
  assert.deepEqual(nested.stage, { kind: 'split', id: 'rows', axis: 'vertical', ratio: 0.25, first: tabs('bottom', ['calls']), second: columns.stage });
  const moved = movePanel(freeze(nested), 'today', { kind: 'tabs', group: 'main', index: 1 });
  assert.deepEqual(moved.stage.second, tabs('main', ['deals', 'today', 'leads'], 'today'));
  assert.deepEqual(validateLayout(JSON.parse(JSON.stringify(moved))), moved);
});
