import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';

for (const width of [320, 390, 1280, 1440]) for (const theme of ['light', 'dark']) for (const national of [false, true]) {
  test(`${national ? 'National Accounts' : 'Local Deals'} keeps summary dates visible at ${width}px ${theme}`, async t => {
    const server = await fixtureServer();
    t.after(() => server.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' });
    await page.clock.setFixedTime(new Date('2026-10-29T15:00:00Z'));
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.route('**/data/board-seed.json', async route => {
      const seed = await (await route.fetch()).json();
      const deal = seed.deals.find(deal => deal.id === (national ? 'd01' : 'd14'));
      Object.assign(deal, { next_step: '', next_date: null, email_actions: [
        { id: 'summary-action', status: 'open', owner: 'dell', description: 'Review the sample lease terms and confirm the remaining details with the lender before arranging the property tour', due_on: '2026-10-30' },
      ] });
      seed.history = { ...seed.history, [deal.id]: [{ id: 'summary-last', summary: 'Sent the sample proposal for review', recorded_at: '2026-10-22T12:00:00Z' }] };
      await route.fulfill({ json: seed });
    });
    await page.goto(`${server.origin}/deals?mode=fixture${national ? '&view=national' : ''}`);
    if (national) await page.locator('.account-card').first().click();
    const card = national ? page.locator('#rows tr[data-deal-id="d01"]') : page.locator('.kanban-card[data-id="d14"]');
    await card.waitFor();
    await card.scrollIntoViewIfNeeded();
    const facts = card.locator('.deal-summary-facts').first();
    assert.match(await facts.innerText(), national ? /Fri Oct 30 · Dell/ : /Fri Oct 30/);
    if (!national) assert.doesNotMatch(await facts.innerText(), /· D/);
    const spaced = await card.locator('.deal-summary-facts').evaluateAll(nodes => nodes.filter(node => node.textContent.includes('·')).map(node => {
      const range = document.createRange();
      range.setStart(node.firstChild, 0);
      range.setEnd(node.firstChild, 1);
      return { text: node.textContent, space: range.getBoundingClientRect().width };
    }));
    assert.ok(spaced.length > 0, 'a dated summary line is rendered');
    for (const fact of spaced) {
      assert.match(fact.text, /^ · /, 'the dot keeps a space before it');
      assert.ok(fact.space > 1, 'the space before the dot is rendered, not collapsed');
    }
    const visible = await card.locator('.deal-summary-facts').evaluateAll(nodes => nodes.every(node => {
      const box = node.getBoundingClientRect();
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (['hidden', 'clip'].includes(style.overflow)) {
          const clip = ancestor.getBoundingClientRect();
          if (box.right > clip.right + 1 || box.bottom > clip.bottom + 1) return false;
        }
      }
      return box.width > 0 && box.right <= innerWidth;
    }));
    assert.equal(visible, true, 'summary facts are outside the clamped text');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if ([390, 1440].includes(width)) {
      const dir = 'out/test-artifacts/deal-board-summary';
      await mkdir(dir, { recursive: true });
      await page.screenshot({ path: `${dir}/${national ? 'national-accounts' : 'local-deals'}-${width}-${theme}.png` });
    }
  });
}

test('search from National Accounts keeps dates visible on local deals', async t => {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.goto(`${server.origin}/deals?view=national&mode=fixture`);
  await page.locator('.account-card').first().click();
  await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
  await page.locator('#search').fill('Demo Surgical');
  await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
  const row = page.locator('#rows tr[data-deal-id="d14"]');
  await row.waitFor();
  assert.equal(await row.locator('.due').isVisible(), true, 'local results retain their date column');
});
