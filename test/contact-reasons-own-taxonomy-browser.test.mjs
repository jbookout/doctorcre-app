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
    const assertions = await exerciseContactReasons(page,'http://localhost/js/contact-reasons.mjs');
    assert.ok(assertions.includes('retired session ignores late results'));
  });
}
