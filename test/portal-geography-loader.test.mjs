import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import Ajv from 'ajv/dist/2020.js';
import { uiBundle } from '../scripts/ui-bundle.mjs';
const read = name => readFile(new URL(`./fixtures/portal/${name}`, import.meta.url), 'utf8').then(JSON.parse);
const legacy = await read('example-health.market-study.json');
const canonical = { ...legacy, ...await read('same-name-geographies.v1.1.json') };
const v1 = await read('market-study.v1.schema.json');
const v11 = await read('market-study.v1.1.schema.json');
const ajv = new Ajv({ strict: false, schemas: [v1] });
const validators = new Map([[v1.properties.schema.const, ajv.compile(v1)], [v11.properties.schema.const, ajv.compile(v11)]]);
const validate = input => validators.get(input?.schema)?.(input) === true;
const bundle = await uiBundle(path => readFile(new URL('../' + path, import.meta.url), 'utf8'), 'src/ui/portal/package.ts');
const api = await import('data:text/javascript;base64,' + bundle.toString('base64'));
const parse = value => api.parseMarketStudy(value, validate);
const rows = p => [p.demographics.growth.geographies, p.demographics.age.geographies, p.demographics.median_income.geographies, p.demographics.income_bands.areas];
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('canonical projection joins same-named geographies by ID across independent section orders', () => {
  assert.equal(validate(canonical), true);
  const result = parse(canonical);
  assert.equal(result.demographics.kind, 'canonical');
  const illinois = result.demographics.geographies.get('src:9f32a');
  assert.equal(illinois.geography_label, 'Springfield, Illinois');
  assert.equal(illinois.age.under_18_pct, 20);
  assert.equal(illinois.medianIncome.value, 65000);
  assert.equal(illinois.incomeBands.households, 1000);
  assert.match(illinois.growth.source_url, /illinois/);
  const reordered = structuredClone(canonical);
  for (const row of rows(reordered)) row.reverse();
  assert.deepEqual([...parse(reordered).demographics.geographies].sort(), [...result.demographics.geographies].sort());
  reordered.demographics.age.geographies[0].under_18_pct = 99;
  assert.equal(illinois.age.under_18_pct, 20);
});

test('each section refuses missing, duplicate, unknown and inconsistent references', () => {
  for (let section = 0; section < 4; section++) {
    for (const defect of ['missing', 'duplicate', 'unknown', 'label', 'absent-id', 'absent-label']) {
      const input = structuredClone(canonical);
      const list = rows(input)[section];
      if (defect === 'missing') list.pop();
      if (defect === 'duplicate') list.push(structuredClone(list[0]));
      if (defect === 'unknown') list[0].geography_id = 'unknown';
      if (defect === 'label') list[0].geography_label = list[1].geography_label;
      if (defect === 'absent-id') delete list[0].geography_id;
      if (defect === 'absent-label') delete list[0].geography_label;
      assert.throws(() => parse(input), undefined, `${section} ${defect}`);
    }
  }
  for (const label of ['  ', ' springfield, missouri ']) {
    const input = structuredClone(canonical);
    rows(input).forEach(list => { list.find(r => r.geography_id === 'src:9f32a').geography_label = label; });
    assert.throws(() => parse(input));
  }
});

test('legacy policy never synthesizes IDs and unknown versions or malformed packages fail', () => {
  assert.equal(parse(legacy).demographics.kind, 'legacy');
  assert.deepEqual(parse(legacy).package, legacy);
  assert.throws(() => parse({ ...canonical, schema: 'carr.market-study.v2' }));
  assert.throws(() => parse({ ...canonical, internal_notes: 'not publishable' }));
  const invalid = structuredClone(canonical); invalid.demographics.age.geographies[0].under_18_pct = 'twenty';
  assert.throws(() => parse(invalid));
});

test('replacement clears selection before loading and failed packages cannot retain old rows', async () => {
  const loader = api.createPublicationLoader(validate);
  assert.equal(loader.state.kind, 'idle');
  await loader.replace(async () => ({ revision: 'one', package: canonical }));
  assert.equal(loader.select('src:b817c'), true);
  assert.equal(loader.state.selectedGeographyId, 'src:b817c');
  const next = deferred(); const pending = loader.replace(() => next.promise);
  assert.deepEqual(loader.state, { kind: 'loading' });
  next.resolve({ revision: 'two', package: { ...canonical, demographics: {} } }); await pending;
  assert.deepEqual(loader.state, { kind: 'unavailable' });
  assert.equal(loader.select('src:b817c'), false);
  await loader.replace(async () => { throw Error('network failed'); });
  assert.deepEqual(loader.state, { kind: 'unavailable' });
  await loader.replace(async () => ({ revision: 'three', package: canonical }));
  assert.equal(loader.state.revision, 'three');
  assert.equal(loader.state.selectedGeographyId, null);
  assert.equal(loader.select('unknown'), false);
  await loader.replace(async () => ({ revision: 'legacy', package: legacy }));
  assert.equal(loader.select('src:b817c'), false);
  assert.equal(loader.state.demographics.kind, 'legacy');
  loader.dispose(); loader.dispose(); assert.deepEqual(loader.state, { kind: 'disposed' });
});

test('superseded success, failure and disposal cannot resurrect publication data', async () => {
  for (const lateFails of [false, true]) {
    const loader = api.createPublicationLoader(validate);
    const first = deferred(); let signal;
    const pending = loader.replace(options => { signal = options.signal; return first.promise; });
    await loader.replace(async () => ({ revision: 'new', package: canonical }));
    assert.equal(signal.aborted, true);
    if (lateFails) first.reject(Error('late')); else first.resolve({ revision: 'old', package: canonical });
    await pending; assert.equal(loader.state.revision, 'new');
    const last = deferred(); const closing = loader.replace(() => last.promise);
    loader.dispose(); last.resolve({ revision: 'closed', package: canonical }); await closing;
    assert.deepEqual(loader.state, { kind: 'disposed' });
    let calls = 0; await loader.replace(async () => { calls++; return { revision: 'ignored', package: canonical }; });
    assert.equal(calls, 0);
  }
});

test('fixtures keep their exact declared CARR revisions and source bytes', async () => {
  const pins = await read('geography-contract-pins.json');
  assert.equal(pins.length, 4);
  for (const pin of pins) {
    const bytes = await readFile(new URL(`./fixtures/portal/${pin.file}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256, pin.file);
  }
});
