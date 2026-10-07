import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissBrief, stubVerbs, searchPayload } from '../v1/_h.ts';

// QA-006: toggling a scope chip from the keyboard must keep focus on that chip.
test('QA-006 scope chip keeps keyboard focus after Space', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await stubVerbs(browser, { find: { payload: searchPayload() } });
  await app.open('/search?q=QA');
  await dismissBrief(screen);
  await expect(screen.getByText('8 shown', { exact: true })).toBeVisible();

  const chip = screen.getByRole('button', 'Organizations · 2');
  await chip.focus();
  await expect(chip).toBeFocused();
  await chip.press('Space');
  await expect(screen.getByRole('button', 'Organizations · 2')).toBeFocused();
});
