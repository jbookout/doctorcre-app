import { expect } from 'e2e';
import { reproTest, textContrast } from './support.mjs';

const test = reproTest();
test('QA-015 submitted dark Search button retains readable contrast', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await app.open('/search');
  await screen.getByLabel('Name to search', { exact: true }).fill('Demo');
  await screen.getByRole('button', 'Search', { exact: true }).tap();
  await expect(browser.locator('#searchResults [data-group]')).toHaveCount(9);
  await browser.mouse.move(0, 0);
  await expect(screen.getByRole('button', 'Search', { exact: true })).toBeFocused();
  await browser.evaluate(() => Promise.all(document.querySelector('#searchForm button[type="submit"]').getAnimations().map(animation => animation.finished.catch(() => null))).then(() => true));
  const color = await textContrast(browser, '#searchForm button[type="submit"]');
  await app.screenshot('qa-015-submitted-search-focus');
  expect(color.ratio, JSON.stringify(color)).toBeGreaterThanOrEqual(4.5);
});
