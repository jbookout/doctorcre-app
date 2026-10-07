import { expect } from 'e2e';
import { reproTest, openSearch } from './support.mjs';

const test = reproTest();
test('QA-007 disabling initially pressed Leads retains the other scopes', { tags: ['bugbash'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await openSearch(app, browser);
  const initial = Number((await browser.locator('#searchCount').textContent()).match(/\d+/)[0]);
  const leads = screen.getByRole('button', /^Leads ·/);
  const count = Number((await leads.textContent()).split('·')[1].trim());
  await expect(leads).toHaveAttribute('aria-pressed', 'true');
  await leads.tap();
  await expect(leads).toHaveAttribute('aria-pressed', 'false');
  await expect(browser.locator('#searchCount')).toHaveText(`${initial - count} shown`);
  await expect(screen.getByRole('button', /^Organizations ·/)).toHaveAttribute('aria-pressed', 'true');
});
