import test from 'node:test';
import assert from 'node:assert/strict';
import { componentDocument, chromium, pausedClock } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { observeExcerpts } from '../scripts/prove-fact-excerpt-invalid-expiry.mjs';

for (const width of [390, 1440]) {
  test(`fact review full island expiry, keyboard and teardown at ${width}px`, async t => {
    const server = await fixtureServer();
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await pausedClock(page, new Date('2026-02-01T00:00:00Z'));
    await componentDocument(page, server.origin, { dispose: page => page.evaluate(() => window.fixture?.panel.dispose()) });
    const result = await observeExcerpts(page, `${server.origin}/js/ui-facts.generated.js`);
    assert.equal(result.assertions, 28);
    await page.evaluate(async origin => {
      const { mountFactReview } = await import(`${origin}/js/ui-facts.generated.js`);
      const { createFactReviewFixture } = await import(`${origin}/data/fixtures/fact-review.mjs`);
      const { FACT_TERMS } = await import(`${origin}/js/client.js`);
      document.body.replaceChildren();
      const root = document.body.appendChild(document.createElement('div'));
      root.id = 'terms';
      const client = createFactReviewFixture({ canonicalHistory: true });
      window.fixture = { client, panel: mountFactReview(root, { client, entityRef: 'd14', terms: FACT_TERMS }) };
      await window.fixture.panel.refresh();
    }, server.origin);
    const summary = page.locator('[data-canonical-history] summary').first();
    await summary.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-canonical-history]').first().getAttribute('open'), '');
    assert.ok((await page.locator('#terms').innerText()).includes('Demo Amendment.pdf'));
    await page.evaluate(() => {
      window.fixture.client.listFactReview = async () => { throw Error('offline'); };
      return window.fixture.panel.refresh();
    });
    assert.match(await page.locator('[data-terms-status]').innerText(), /Terms unavailable/);
    assert.ok((await page.locator('#terms').innerText()).includes('Demo Amendment.pdf'));
    await summary.focus();
    await page.evaluate(() => {
      window.fixture.client.listFactReview = () => new Promise(resolve => { window.finishRead = resolve; });
      window.refreshing = window.fixture.panel.refresh();
    });
    await page.waitForFunction(() => typeof window.finishRead === 'function');
    await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
    assert.match(await page.locator('#terms').innerText(), /Sign in again/);
    assert.equal(await page.locator('#terms').evaluate(root => document.activeElement === root), true);
    await page.evaluate(async () => {
      window.finishRead({ schema_version: 'fact-review.v1', items: [], has_more: false });
      await window.refreshing;
    });
    assert.equal(await page.locator('[data-canonical-history]').count(), 0);
    await page.evaluate(() => window.fixture.panel.dispose());
  });
}
