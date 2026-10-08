import { expect } from 'e2e';
import { reproTest, openSearch } from './support.mjs';

const test = reproTest();
test('QA-007 disabling initially pressed Leads retains the other scopes', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await openSearch(app, browser);
  const initial = Number((await browser.locator('#searchCount').textContent()).match(/\d+/)[0]);
  const leads = screen.getByRole('button', /^Leads ·/);
  const count = Number((await leads.textContent()).split('·')[1].trim());
  await expect(leads).toHaveAttribute('aria-pressed', 'true');
  await leads.tap();
  await expect(leads).toHaveAttribute('aria-pressed', 'false');
  await expect(browser.locator('#searchCount')).toHaveText(`${initial - count} grouped results in scope`);
  await expect(screen.getByRole('button', /^Organizations ·/)).toHaveAttribute('aria-pressed', 'true');
  for (const chip of await browser.locator('#searchChips button').all()) {
    if (await chip.getAttribute('aria-pressed') === 'true') await chip.tap();
  }
  await expect(browser.locator('#searchCount')).toHaveText('0 grouped results in scope');
  await expect.poll(() => browser.evaluate(() => new URL(location.href).searchParams.get('kinds'))).toBe('none');
  await browser.reload();
  await expect(browser.locator('#searchCount')).toHaveText('0 grouped results in scope');
  await screen.getByRole('button', /^Leads ·/).tap();
  await expect(browser.locator('#searchCount')).toHaveText(`${count} grouped results in scope`);
});
