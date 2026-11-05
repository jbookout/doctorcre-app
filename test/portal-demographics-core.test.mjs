import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const result = await build({ entryPoints: ['src/ui/portal/demographics-core.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' });
const { createRequire } = await import('node:module');
const module = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { DemographicsCore } = module.exports;
const fixture = JSON.parse(await readFile('test/fixtures/portal-demographics-core.market-study.json', 'utf8'));
const render = demographics => new JSDOM(renderToStaticMarkup(createElement(DemographicsCore, { demographics }))).window.document;

test('published years, units, denominators, notes and sources survive rendering', () => {
  const doc = render(fixture.demographics);
  const growth = doc.querySelector('[data-growth]');
  assert.match(growth.textContent, /2020 census/);
  assert.match(growth.textContent, /2025 estimate/);
  assert.match(growth.textContent, /2030 projection/);
  assert.match(growth.textContent, /60,000/);
  assert.match(growth.textContent, /Population/);
  assert.equal(growth.querySelector('a[href="https://example.com/census"]').href, 'https://example.com/census');
  assert.match(doc.body.textContent, /6,000 of 20,000 households/);
  assert.match(doc.body.textContent, /30%/);
  assert.match(doc.body.textContent, /Synthetic households note/);
  assert.equal(doc.querySelector('[data-age] a').href, 'https://example.com/age');
});

test('missing module renders nothing', () => {
  assert.equal(render(undefined).body.textContent, '');
});

test('unknown counts stay unknown while a published zero stays zero', () => {
  const data = structuredClone(fixture.demographics);
  data.income_bands.areas[0].counts = { '150000': 0 };
  delete data.income_bands.combined;
  assert.match(render(data).querySelector('[data-income-bands]').textContent, /Unknown of 20,000 households/);
  data.income_bands.thresholds = [150000];
  assert.match(render(data).querySelector('[data-income-bands]').textContent, /0 of 20,000 households/);
  data.income_bands.areas[0].households = 0;
  assert.match(render(data).querySelector('[data-income-bands]').textContent, /Unknown share/);
});

test('ten times the geography rows remain present with their values', () => {
  const data = structuredClone(fixture.demographics);
  data.median_income.geographies = Array.from({ length: 10 }, (_, index) => ({ name: `Example area ${index}`, value: 80000 + index }));
  assert.match(render(data).querySelector('[data-median]').textContent, /Example area 9/);
  assert.match(render(data).querySelector('[data-median]').textContent, /\$80,009/);
});

test('source rendering refuses unsafe and malformed URLs without hiding values', () => {
  for (const url of ['javascript:alert(1)', 'https://[', 'https://user:pass@example.com/']) {
    const data = structuredClone(fixture.demographics);
    data.growth.geographies[0].source_url = url;
    const doc = render(data);
    assert.match(doc.querySelector('#regional-growth-chart').textContent, /60,000/);
    assert.equal(doc.querySelector('#regional-growth-chart a'), null);
  }
});
