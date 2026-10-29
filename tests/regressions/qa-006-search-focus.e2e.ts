import { expect } from 'e2e';
import { reproTest, openSearch } from './support.mjs';

const test = reproTest();
test('QA-006 changing Organizations scope retains visible keyboard focus', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await openSearch(app, browser);
  for (const chip of await browser.locator('#searchChips button').all()) {
    if (!(await chip.textContent()).startsWith('Leads ·')) await chip.tap();
  }
  await expect(browser.locator('#searchCount')).toHaveText('2 grouped results in scope');
  const organizations = screen.getByRole('button', /^Organizations ·/);
  await organizations.focus();
  await organizations.press('Space');
  await expect(browser.locator('#searchCount')).toHaveText('7 grouped results in scope');
  await expect(organizations).toBeFocused();
  await expect.poll(() => browser.evaluate(() => {
    const style = getComputedStyle(document.activeElement);
    return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
  })).toBe(true);
  await expect.poll(() => browser.evaluate(() => {
    const rect = document.activeElement.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight;
  })).toBe(true);
  await organizations.press('Enter');
  await expect(organizations).toHaveAttribute('aria-pressed', 'false');
  await expect(organizations).toBeFocused();
  await expect(browser.locator('#searchCount')).toHaveText('2 grouped results in scope');
  await browser.keyboard.press('Tab');
  await expect(screen.getByRole('button', /^Deals ·/)).toBeFocused();
});
