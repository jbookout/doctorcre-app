import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from './browser-harness.mjs';
import {routeLeads} from './leads-browser-fixture.mjs';
import {exerciseContactReasons} from '../scripts/prove-contact-reasons-own-taxonomy.mjs';

for (const width of [390,1280]) for (const colorScheme of ['light','dark']) {
  test(`own contact taxonomy ${width}px ${colorScheme}`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({viewport:{width,height:1000},colorScheme});
    await routeLeads(page);
    await page.goto('http://localhost/leads');
    await page.locator('.lead-card').first().waitFor();
    await page.waitForFunction(() => typeof document.getElementById('docOpen')?.onclick === 'function');
    await page.evaluate(() => {
      window.taxonomyTransitions = [];
      document.addEventListener('click', event => {
        if (event.target.closest('[data-retry-reasons]')) {
          window.taxonomyTransitions.push({edge:'retry',source:window.taxonomyProof.payload.coverage[0].source});
        }
      }, true);
      window.addEventListener('doctorcre-session-invalidated', () => {
        const host = document.querySelector('#taxonomy-proof');
        window.taxonomyTransitions.push({edge:'retire',busy:host.getAttribute('aria-busy'),
          unavailable:host.textContent.includes('Contact reasons unavailable'),cards:host.querySelectorAll('.work-card').length});
      });
    });
    const assertions = await exerciseContactReasons(page,'http://localhost/js/contact-reasons.mjs');
    assert.ok(assertions.includes('retired session ignores late results'));
    const transitions = await page.evaluate(() => window.taxonomyTransitions);
    for (const source of ['constructor','toString','__proto__']) {
      assert.ok(transitions.some(row => row.edge === 'retry' && row.source === source), `missing unsuccessful Retry for ${source}`);
    }
    for (const expected of [
      {edge:'retire',busy:'true',unavailable:false,cards:0},
      {edge:'retire',busy:'false',unavailable:true,cards:0},
      {edge:'retire',busy:'true',unavailable:true,cards:0},
    ]) assert.ok(transitions.some(row => JSON.stringify(row) === JSON.stringify(expected)), `missing retirement ${JSON.stringify(expected)}`);
  });
}
