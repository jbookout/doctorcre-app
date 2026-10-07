import { expect } from 'e2e';
import { reproTest, openSearch } from './support.mjs';

const test = reproTest();
test('QA-012 filtered counts explain the unfiltered candidate list', { tags: ['bugbash'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await openSearch(app, browser);
  await screen.getByRole('button', /^Leads ·/).tap();
  await screen.getByRole('button', /^Organizations ·/).tap();
  await expect(browser.locator('#searchResults [data-group]')).toHaveCount(2);
  await expect(browser.locator('#searchCandidates')).toContainText(/candidates found/);
  await expect(browser.locator('#searchCount')).toContainText(/grouped|results in scope/i);
  await expect(browser.locator('#searchCandidates')).toContainText(/unfiltered|not filtered|all scopes|scope does not/i);
});
