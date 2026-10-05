import { expect } from 'e2e';
import { reproTest, openSearch } from './support.mjs';

const test = reproTest();
test('QA-006 changing Organizations scope retains keyboard focus', { tags: ['bugbash'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await openSearch(app, browser);
  await screen.getByRole('button', /^Leads ·/).tap();
  const organizations = screen.getByRole('button', /^Organizations ·/);
  await organizations.focus();
  await organizations.press('Space');
  await expect(organizations).toBeFocused();
  await browser.keyboard.press('Tab');
  await expect(screen.getByRole('button', /^Deals ·/)).toBeFocused();
});
