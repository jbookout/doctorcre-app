import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { uiAssets } from '../scripts/ui-bundle.mjs';
import { chromium } from './browser-harness.mjs';
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { exerciseEvidenceHistory, territoryResponse } from '../scripts/prove-territory-evidence-current-history-view.mjs';

const assets = await uiAssets(path => readFile(path, 'utf8'));
for (const width of [390, 1280]) for (const colorScheme of ['light', 'dark']) {
  test(`evidence history lifecycle at ${width} ${colorScheme}`, async t => {
    const server = await startFixtureServer(); t.after(() => server.stop());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme });
    await page.route('https://**', route => route.abort());
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({theme})), colorScheme);
    await page.route('**/js/**', route => {
      const bytes = assets.get(new URL(route.request().url()).pathname.slice(1));
      return bytes ? route.fulfill({contentType:'text/javascript', body:bytes}) : route.abort();
    });
    await page.goto(server.url);
    const results = await page.evaluate(exerciseEvidenceHistory, territoryResponse);
    assert.ok(results.length > 30);
    assert.ok(results.every(result => result.passed));
    await page.evaluate(async response => {
      const { mountTerritoryEvidence } = await import('/js/ui-territory-evidence.generated.js');
      const host = document.createElement('div');document.body.replaceChildren(host);
      mountTerritoryEvidence(host, {getTerritoryStateBoard: async () => response}, () => {});
    }, territoryResponse);
    await page.getByText('Recorded territory conditions', {exact:true}).focus();
    await page.keyboard.press('Enter');
    const selector = page.getByLabel('Evidence view', {exact:true});
    await selector.focus();await page.keyboard.press('c');await page.keyboard.press('Enter');
    assert.equal(await selector.inputValue(), 'current');
    assert.equal(await selector.evaluate(el => el === document.activeElement), true);
    assert.match(await page.locator('tbody tr').first().innerText(), /2 visible \/ 4 total evidence/);
    assert.equal(await page.getByRole('option', {name:'Historical evidence',exact:true}).count(), 1);
    assert.equal(await page.locator('.territory-evidence').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  });
}
