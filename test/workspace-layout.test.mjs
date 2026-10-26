import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/ui/workspace-layout.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { validateLayout, insertPanel, movePanel, removePanel, resizeSplit, selectPanel } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const tabs = (id, panels, active = panels[0]) => ({ kind: 'tabs', id, panels, active });
const empty = () => ({ version: 1, stage: null });
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

test('select a panel without changing its group, order or source layout', () => {
  const source = freeze(initial());
  assert.deepEqual(selectPanel(source, 'leads'), { ...empty(), stage: tabs('main', ['deals', 'leads'], 'leads') });
  const split = insertPanel(source, 'today', { kind: 'split', target: 'main', id: 'columns', group: 'aside', axis: 'horizontal', side: 'after', ratio: 0.7 });
  assert.deepEqual(selectPanel(freeze(split), 'leads').stage, { ...split.stage, first: tabs('main', ['deals', 'leads'], 'leads') });
  assert.deepEqual(source, initial());
  assert.throws(() => selectPanel(source, 'missing'));
});

test('split a group and move a tab between groups', () => {
  const source = freeze(initial());
  const split = insertPanel(source, 'today', { kind: 'split', target: 'main', id: 'columns', group: 'aside', axis: 'horizontal', side: 'after', ratio: 0.7 });
  assert.deepEqual(split.stage, { kind: 'split', id: 'columns', axis: 'horizontal', ratio: 0.7,
    first: tabs('main', ['deals', 'leads']), second: tabs('aside', ['today']) });
  const moved = movePanel(freeze(split), 'leads', { kind: 'tabs', group: 'aside' });
  assert.deepEqual(moved.stage.first, tabs('main', ['deals']));
  assert.deepEqual(moved.stage.second, tabs('aside', ['today', 'leads'], 'leads'));
  assert.deepEqual(source, initial());
});

test('resize a split without changing panel placement', () => {
  const source = freeze(insertPanel(initial(), 'today', { kind: 'split', target: 'main', id: 'columns', group: 'aside', axis: 'horizontal', side: 'after', ratio: 0.7 }));
  assert.deepEqual(resizeSplit(source, 'columns', 0.4).stage, { ...source.stage, ratio: 0.4 });
  for (const ratio of [0, 1, -1, NaN, Infinity]) assert.throws(() => resizeSplit(source, 'columns', ratio));
  assert.throws(() => resizeSplit(source, 'main', 0.5));
});

test('remove an active tab, collapse empty split branches, and remove the final panel', () => {
  const source = freeze({ ...initial(), stage: tabs('main', ['deals', 'leads', 'calls'], 'leads') });
  assert.deepEqual(removePanel(source, 'leads').stage, tabs('main', ['deals', 'calls'], 'calls'));
  assert.deepEqual(removePanel({ ...source, stage: tabs('main', ['deals', 'leads'], 'leads') }, 'leads').stage, tabs('main', ['deals']));
  const nested = insertPanel(initial(), 'today', { kind: 'split', target: 'main', id: 'columns', group: 'aside', axis: 'vertical', side: 'before', ratio: 0.3 });
  assert.deepEqual(removePanel(freeze(nested), 'today'), initial());
  assert.deepEqual(removePanel({ ...empty(), stage: tabs('main', ['deals']) }, 'deals'), empty());
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

test('validate the stage tree and reject corrupt, duplicate, cyclic or sparse documents', () => {
  const source = freeze(initial());
  const result = validateLayout(source);
  assert.deepEqual(result, source);
  assert.notEqual(result.stage.panels, source.stage.panels);
  const split = { kind: 'split', id: 'columns', axis: 'horizontal', ratio: 0.5, first: tabs('main', ['deals']), second: tabs('aside', ['today']) };
  for (const invalid of [
    null, {}, { ...source, version: 2 }, { ...source, stage: tabs('main', []) },
    { ...source, stage: tabs('main', ['deals'], 'missing') },
    { ...source, stage: tabs('main', ['deals', 'deals']) },
    { ...source, stage: { ...split, second: tabs('main', ['today']) } },
    { ...source, stage: { ...split, axis: 'diagonal' } },
    { ...source, stage: { ...split, ratio: Infinity } },
    { ...source, stage: { ...split, first: null } },
    { ...empty(), stage: tabs('main', ['deals', , 'leads']) },
  ]) assert.throws(() => validateLayout(invalid));
  const cycle = { ...split };
  cycle.first = cycle;
  assert.throws(() => validateLayout({ ...empty(), stage: cycle }), /Duplicate node identifier/);
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
  assert.throws(() => insertPanel(source, 'deals', { kind: 'tabs', group: 'main' }));
  assert.throws(() => movePanel(source, 'missing', { kind: 'tabs', group: 'main' }));
});

test('nest splits around whole groups, then move a sole sibling tab and collapse its parent', () => {
  const columns = insertPanel(initial(), 'today', { kind: 'split', target: 'main', id: 'columns', group: 'aside', axis: 'horizontal', side: 'after', ratio: 0.7 });
  const nested = insertPanel(columns, 'calls', { kind: 'split', target: 'columns', id: 'rows', group: 'bottom', axis: 'vertical', side: 'before', ratio: 0.25 });
  assert.deepEqual(nested.stage, { kind: 'split', id: 'rows', axis: 'vertical', ratio: 0.25, first: tabs('bottom', ['calls']), second: columns.stage });
  const moved = movePanel(freeze(nested), 'today', { kind: 'tabs', group: 'main', index: 1 });
  assert.deepEqual(moved.stage.second, tabs('main', ['deals', 'today', 'leads'], 'today'));
  assert.deepEqual(validateLayout(JSON.parse(JSON.stringify(moved))), moved);
});

test('move a sole panel around its collapsing split target', () => {
  for (const panel of ['a', 'b']) {
    for (const side of ['before', 'after']) {
      for (const nested of [false, true]) {
        const split = { kind: 'split', id: 'S', axis: 'horizontal', ratio: 0.5,
          first: tabs('G1', ['a']), second: tabs('G2', ['b']) };
        const source = freeze({ ...empty(), stage: nested
          ? { kind: 'split', id: 'outer', axis: 'vertical', ratio: 0.3, first: tabs('other', ['c']), second: split }
          : split });
        const sibling = panel === 'a' ? split.second : split.first;
        const moved = movePanel(source, panel, { kind: 'split', target: 'S', id: 'new-split', group: 'new-group', axis: 'vertical', side, ratio: 0.4 });
        const group = tabs('new-group', [panel]);
        const expected = { kind: 'split', id: 'new-split', axis: 'vertical', ratio: 0.4,
          first: side === 'before' ? group : sibling, second: side === 'before' ? sibling : group };
        assert.deepEqual(moved.stage, nested ? { ...source.stage, second: expected } : expected);
        assert.deepEqual(validateLayout(moved), moved);
        assert.deepEqual(nested ? source.stage.second : source.stage, split);
      }
    }
  }
});
