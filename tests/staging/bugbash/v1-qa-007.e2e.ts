import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissBrief, stubVerbs, searchPayload } from '../v1/_h.ts';

// QA-007: turning off a pressed scope chip must disable that scope, not isolate it.
// `find` is stubbed with an app-valid payload (staging's own `find` fails app validation whenever a deal matches).
test('QA-007 toggling a pressed scope removes only that group', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await stubVerbs(browser, { find: { payload: searchPayload() } });
  await app.open('/search?q=QA');
  await dismissBrief(screen);
  await expect(screen.getByText('8 shown', { exact: true })).toBeVisible();
  await expect(screen.getByRole('button', 'Leads · 2', { pressed: true })).toBeVisible();

  await screen.getByRole('button', 'Leads · 2').tap();
  const shown = () => browser.evaluate(() => document.getElementById('searchCount')?.textContent ?? '');
  await expect.poll(shown, { message: 'shown total after switching Leads off' }).toBe('6 shown');
  await expect(screen.getByRole('button', 'Leads · 2', { pressed: false })).toBeVisible();
  await expect(screen.getByRole('button', 'Deals · 2', { pressed: true })).toBeVisible();
});
