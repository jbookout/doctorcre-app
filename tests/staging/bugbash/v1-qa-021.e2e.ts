import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissBrief } from '../v1/_h.ts';

// QA-021: a filter matching one lead must read "1 lead", not "1 leads".
test('QA-021 single-result lead filter count is singular', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await app.open('/leads');
  await dismissBrief(screen);
  await screen.getByRole('button', 'Workspace sidebar').tap();
  const read = () => browser.evaluate(() => document.getElementById('filterSummary')?.textContent?.trim() ?? '');
  // Staging data is shared and moves; use whichever stage currently holds exactly one lead.
  let single = '';
  for (const stage of ['New', 'Qualified', 'Outreach Active', 'Engaged', 'Nurture', 'Opportunity']) {
    await screen.getByLabel('Stage').selectOption(stage);
    await expect.poll(read, { message: `filter summary after choosing Stage ${stage}` }).toMatch(/^\d+ leads?$/);
    if (Number((await read()).split(' ')[0]) === 1) { single = stage; break; }
  }
  if (!single) {
    // Fall back to the search filter on the one synthetic fixture lead.
    await screen.getByLabel('Stage').selectOption({ index: 0 });
    await screen.getByRole('searchbox', { name: /Search leads/i }).fill('QA Unlinked Prospect');
    await expect.poll(read, { message: 'filter summary after searching the fixture lead' }).toMatch(/^\d+ leads?$/);
    if (Number((await read()).split(' ')[0]) === 1) single = 'search: QA Unlinked Prospect';
  }
  test.skip(!single, 'no lead filter on staging currently matches exactly one lead');
  expect(await read(), `filter summary with one matching lead (Stage ${single})`).toBe('1 lead');
});
