import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissBrief, stubVerbs, searchPayload } from '../v1/_h.ts';

// QA-011: multiple-match guidance must not tell a partner to call an internal verb.
// `find-and-catch-up` is live (staging returns the real hint); `find` is stubbed so the page reaches the ready state.
test('QA-011 multiple-match guidance does not expose the catch-me-up verb', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await stubVerbs(browser, { find: { payload: searchPayload() } });
  await app.open('/search?q=QA');
  await dismissBrief(screen);
  await expect(screen.getByRole('heading', 'Multiple matches').first()).toBeVisible();
  await expect(screen.getByText('catch-me-up', { exact: false })).toBeHidden();
});
