import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissBrief, stubVerbs, searchPayload } from '../v1/_h.ts';

// QA-012: when Scope narrows the grouped results, the separate candidate list must say Scope does not filter it.
test('QA-012 candidate list says it is not filtered by Scope', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await stubVerbs(browser, { find: { payload: searchPayload() } });
  await app.open('/search?q=QA');
  await dismissBrief(screen);
  await expect(screen.getByRole('heading', 'Multiple matches').first()).toBeVisible();
  await screen.getByRole('button', 'Leads · 2').tap();
  await screen.getByRole('button', 'Organizations · 2').tap();
  await expect(screen.getByText('4 shown', { exact: true })).toBeVisible();

  const candidates = await browser.evaluate(() => (document.getElementById('searchCandidates') as HTMLElement).innerText);
  expect(candidates, 'candidate list text').toMatch(/scope/i);
});
