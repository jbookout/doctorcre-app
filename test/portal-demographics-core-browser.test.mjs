import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from './browser-harness.mjs';

const fixture = JSON.parse(await readFile('test/fixtures/portal-demographics-core.market-study.json', 'utf8'));
const css = await readFile('css/tokens.css', 'utf8') + await readFile('portal/demographics-core.css', 'utf8');
const data = fixture.demographics;
data.growth.geographies.push({ name: 'Sample City', series: [
  { label: '2021', value: 9000, kind: 'census' },
  { label: '2026', value: 10000, kind: 'estimate' },
  { label: '2031', value: 11000, kind: 'projection' },
], source_url: 'https://example.com/city-population' });
data.age.geographies.push({ name: 'Sample City', under_18_pct: 25, over_65_pct: 15, source_url: 'https://example.com/city-age' });
data.median_income.geographies.push({ name: 'Sample City', value: 80000 });
data.income_bands.areas.push({ name: 'Sample City', group: 'place', households: 4000, counts: { '100000': 2000, '150000': 500 }, caption: '2026 ACS estimate, households. Synthetic city bands.' });
const bundle = await build({ stdin: {
  contents: `import {createElement} from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom'; import {DemographicsCore} from './src/ui/portal/demographics-core'; const root=createRoot(document.getElementById('root')); window.renderData=(demographics)=>flushSync(()=>root.render(createElement(DemographicsCore,{demographics}))); window.renderData(${JSON.stringify(data)});`,
  resolveDir: process.cwd(), loader: 'tsx',
}, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });

for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
  test(`geographies, thresholds and tabular equivalents at ${width}px in ${theme}`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const requests = [];
    await page.route('http://127.0.0.1/**', route => {
      requests.push(route.request().url());
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en" data-theme="${theme}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demographics fixture</title><style>body{margin:0;font-family:system-ui} ${css}</style><main><h1>Demographics</h1><div id="root"></div></main><script>${bundle.outputFiles[0].text}</script></html>` });
    });
    await page.goto('http://127.0.0.1/demographics');
    const growth = page.locator('[data-growth]');
    await page.getByRole('group', { name: 'Growth geography', exact: true }).getByRole('button', { name: 'Sample City', exact: true }).click();
    assert.match(await growth.innerText(), /2031 projection/);
    assert.match(await growth.innerText(), /11,000/);
    assert.doesNotMatch(await growth.locator('table').innerText(), /60,000/);
    assert.equal(await growth.getByRole('link', { name: 'View population source for Sample City' }).getAttribute('href'), 'https://example.com/city-population');
    await page.getByRole('group', { name: 'Household geography', exact: true }).getByRole('button', { name: 'Sample City', exact: true }).click();
    assert.match(await page.locator('[data-age]').innerText(), /25%/);
    assert.equal(await page.locator('[data-age] a').getAttribute('href'), 'https://example.com/city-age');
    assert.equal(await page.locator('[data-median] a').getAttribute('href'), 'https://example.com/city-age');
    assert.match(await page.locator('[data-selected=true]').innerText(), /Sample City.*selected/s);
    assert.match(await page.locator('[data-selected=true]').innerText(), /\$80,000/);
    await page.getByRole('button', { name: '$150,000 or more', exact: true }).click();
    const city = page.locator('[data-income-bands] article').filter({ has: page.getByRole('heading', { name: 'Sample City', exact: true }) });
    assert.match(await city.innerText(), /500 of 4,000 households/);
    assert.match(await city.innerText(), /12.5%/);
    assert.match(await city.innerText(), /2026 ACS estimate/);
    assert.match(await page.locator('[data-income-bands]').innerText(), /Unknown of 20,000 households/);
    await page.getByRole('group', { name: 'Growth geography', exact: true }).getByRole('button', { name: 'Sample County', exact: true }).click();
    await page.getByRole('group', { name: 'Household geography', exact: true }).getByRole('button', { name: 'Sample County', exact: true }).click();
    assert.equal(await page.locator('[data-age] a').getAttribute('href'), 'https://example.com/age');
    assert.match(await growth.locator('table').innerText(), /60,000/);
    await page.getByText('Sources and methodology', { exact: true }).click();
    await page.getByText('Geography and source notes', { exact: true }).click();
    assert.match(await page.locator('body').innerText(), /Synthetic methodology/);
    await mkdir('out/test-artifacts/demographics-core', { recursive: true });
    await page.screenshot({ path: `out/test-artifacts/demographics-core/${width}-${theme}-charts.png`, fullPage: true });
    await page.addStyleTag({ content: '.demographics-bar { display:none }' });
    assert.match(await growth.locator('table').innerText(), /2025 estimate.*55,000/s);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('.regional-growth button').first().focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('.regional-growth button').first().evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
    await mkdir('out/test-artifacts/demographics-core', { recursive: true });
    await page.screenshot({ path: `out/test-artifacts/demographics-core/${width}-${theme}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 1);
    await page.addScriptTag({ path: 'node_modules/axe-core/axe.min.js' });
    const accessibility = await page.evaluate(async () => (await window.axe.run(document.querySelector('.demographics-core'))).violations.map(item => item.id));
    assert.deepEqual(accessibility, []);

    const replacement = structuredClone(data);
    replacement.growth.geographies = [data.growth.geographies[1]];
    replacement.age.geographies = [data.age.geographies[1]];
    replacement.median_income.geographies = [{ name: 'Income only', value: 90000 }];
    replacement.income_bands.thresholds = [200000];
    await page.evaluate(value => window.renderData(value), replacement);
    assert.equal(await page.locator('.regional-growth button[aria-pressed=true]').innerText(), 'Sample City');
    assert.equal(await page.locator('#demographics > .demo-switch button[aria-pressed=true]').innerText(), 'Sample City');
    assert.equal(await page.locator('.income-tier-switch button[aria-pressed=true]').innerText(), '$200,000 or more');
    await page.getByRole('group', { name: 'Household geography', exact: true }).getByRole('button', { name: 'Income only', exact: true }).click();
    assert.match(await page.locator('[data-age]').innerText(), /Unknown/);
    assert.equal(await page.locator('[data-age] a').count(), 0);
    assert.equal(await page.locator('[data-median] a').count(), 0);
    await page.evaluate(() => window.renderData(undefined));
    assert.equal(await page.locator('.demographics-core').count(), 0);
    await page.evaluate(value => window.renderData(value), data);
    await page.getByRole('heading', { name: 'Regional growth', exact: true }).waitFor();
  });
}

for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
  test(`duplicate geography names retain their own values and sources at ${width}px in ${theme}`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    await page.route('http://127.0.0.1/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en" data-theme="${theme}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Duplicate geography fixture</title><style>body{margin:0;font-family:system-ui} ${css}</style><main><h1>Demographics</h1><div id="root"></div></main><script>${bundle.outputFiles[0].text}</script></html>` }));
    await page.goto('http://127.0.0.1/demographics');
    const duplicate = structuredClone(data);
    for (const section of ['growth', 'age', 'median_income']) duplicate[section].geographies[1].name = 'Sample County';
    await page.evaluate(value => window.renderData(value), duplicate);
    const growth = page.getByRole('group', { name: 'Growth geography', exact: true });
    await growth.getByRole('button').nth(1).click();
    assert.equal(await growth.locator('[aria-pressed=true]').count(), 1);
    assert.notEqual(await growth.getByRole('button').nth(0).innerText(), await growth.getByRole('button').nth(1).innerText());
    assert.match(await page.locator('[data-growth] table').innerText(), /11,000/);
    assert.doesNotMatch(await page.locator('[data-growth] table').innerText(), /60,000/);
    assert.equal(await page.locator('#regional-growth-chart a').getAttribute('href'), 'https://example.com/city-population');
    const household = page.getByRole('group', { name: 'Household geography', exact: true });
    assert.equal(await household.getByRole('button').count(), 2);
    await household.getByRole('button').nth(1).click();
    assert.equal(await household.locator('[aria-pressed=true]').count(), 1);
    assert.match(await page.locator('[data-age]').innerText(), /25%/);
    assert.equal(await page.locator('[data-age] a').getAttribute('href'), 'https://example.com/city-age');
    assert.match(await page.locator('[data-selected=true]').innerText(), /\$80,000/);
    assert.equal(await page.locator('[data-median] a').getAttribute('href'), 'https://example.com/city-age');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await mkdir('out/test-artifacts/demographics-core', { recursive: true });
    await page.screenshot({ path: `out/test-artifacts/demographics-core/duplicates-${width}-${theme}.png`, fullPage: true });
    const replacement = structuredClone(duplicate);
    replacement.growth.geographies[1].series[2].value = 12000;
    replacement.age.geographies[1].under_18_pct = 31;
    await page.evaluate(value => window.renderData(value), replacement);
    assert.equal(await growth.getByRole('button').nth(0).getAttribute('aria-pressed'), 'true');
    assert.equal(await household.getByRole('button').nth(0).getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('[data-growth] table').innerText(), /60,000/);
    assert.match(await page.locator('[data-age]').innerText(), /22%/);
    await growth.getByRole('button').nth(1).click();
    await household.getByRole('button').nth(1).click();
    assert.match(await page.locator('[data-growth] table').innerText(), /12,000/);
    assert.match(await page.locator('[data-age]').innerText(), /31%/);
  });
}
