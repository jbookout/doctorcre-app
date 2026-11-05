import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from './browser-harness.mjs';

const read = name => readFile(new URL(`./fixtures/portal/${name}`, import.meta.url), 'utf8').then(JSON.parse);
const legacy = await read('example-health.market-study.json');
const canonical = { ...legacy, ...await read('same-name-geographies.v1.1.json') };
const v1 = await read('market-study.v1.schema.json');
const v11 = await read('market-study.v1.1.schema.json');
const output = await build({ stdin: {
  contents: `import Ajv from 'ajv/dist/2020.js';
    export { createPublicationLoader } from './src/ui/portal/package.ts';
    const ajv = new Ajv({ strict: false, schemas: [${JSON.stringify(v1)}] });
    const legacy = ajv.getSchema(${JSON.stringify(v1.$id)});
    const canonical = ajv.compile(${JSON.stringify(v11)});
    export const validate = value => value?.schema === 'carr.market-study.v1' ? legacy(value) : canonical(value);`,
  resolveDir: new URL('../', import.meta.url).pathname,
}, bundle: true, write: false, format: 'esm', platform: 'browser' });
const source = output.outputFiles[0].text;

for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
  test(`synthetic consumer tracks canonical selection and replacement at ${width}px in ${theme}`, async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width, height: 844 }, colorScheme: theme });
      await page.setContent('<main><select aria-label="Geography"></select><output></output><a>Source</a></main>');
      await page.evaluate(async ({ source, canonical }) => {
        const api = await import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
        const loader = api.createPublicationLoader(api.validate);
        const select = document.querySelector('select');
        const output = document.querySelector('output');
        const link = document.querySelector('a');
        const render = () => {
          const state = loader.state;
          select.replaceChildren(); output.textContent = state.kind; link.removeAttribute('href');
          if (state.kind !== 'ready' || state.demographics.kind !== 'canonical') return;
          select.replaceChildren(...[...state.demographics.geographies.values()].map(row => new Option(row.geography_label, row.geography_id)));
          select.value = state.selectedGeographyId ?? '';
          const selected = state.demographics.geographies.get(state.selectedGeographyId);
          if (selected) { output.textContent = `${state.revision}|${selected.geography_id}|${selected.age.under_18_pct}|${selected.medianIncome.value}`; link.href = selected.age.source_url; }
        };
        select.addEventListener('change', () => { loader.select(select.value); render(); });
        window.replace = async (revision, fail = false) => {
          const next = structuredClone(canonical);
          if (revision === 'two') next.demographics.age.geographies.find(r => r.geography_id === 'src:9f32a').under_18_pct = 22;
          const pending = loader.replace(async () => { if (fail) throw Error('synthetic failure'); return { revision, package: next }; });
          render(); await pending; render();
        };
        await window.replace('one');
      }, { source, canonical });
      const select = page.getByRole('combobox', { name: 'Geography' });
      assert.deepEqual(await select.locator('option').allTextContents(), ['Springfield, Illinois', 'Springfield, Missouri']);
      await select.selectOption('src:9f32a');
      assert.equal(await page.locator('output').textContent(), 'one|src:9f32a|20|65000');
      assert.match(await page.locator('a').getAttribute('href'), /illinois/);
      await select.selectOption('src:b817c');
      assert.equal(await page.locator('output').textContent(), 'one|src:b817c|30|95000');
      assert.match(await page.locator('a').getAttribute('href'), /missouri/);
      await page.evaluate(() => window.replace('two'));
      assert.equal(await select.inputValue(), '');
      await select.selectOption('src:9f32a');
      assert.equal(await page.locator('output').textContent(), 'two|src:9f32a|22|65000');
      await page.evaluate(() => window.replace('bad', true));
      assert.equal(await page.locator('output').textContent(), 'unavailable');
      assert.equal(await select.locator('option').count(), 0);
      assert.equal(await page.locator('a').getAttribute('href'), null);
    } finally { await browser.close(); }
  });
}
