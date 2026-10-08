import { expect } from 'e2e';
import { reproTest, openSearch } from './support.mjs';

const test = reproTest();
test('QA-020 submitting a cleared search removes the previous query from the URL', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await openSearch(app, browser);
  await screen.getByLabel('Name to search', { exact: true }).clear();
  await screen.getByRole('button', 'Search', { exact: true }).tap();
  await expect(browser.locator('#searchState')).toContainText('Search by name');
  await expect(browser).toHaveURL('/search');
});
