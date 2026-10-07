import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Bug bash repro (coordinator probe 2026-10-07; source js/morning-brief.js line 120):
// on the first page of the day the morning brief opens as a modal dialog several
// seconds AFTER the page is interactive. A partner who has started typing in a
// field loses focus mid-word and the rest of the page goes inert.
test('[doc-morning-brief] the automatic morning brief does not take focus from a field being typed in', { session: 'staging-partner', tags: ['bugbash'] }, async ({ app, browser, screen }) => {
  await app.open('/doc-chats');
  // First visit of the day: forget that the brief was already shown.
  await browser.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('doctorcre:morning:')) localStorage.removeItem(key); });
  await app.open('/doc-chats');
  const title = screen.getByRole('textbox', { name: 'Title', exact: true });
  await expect(title).toBeEnabled();
  await title.click();
  await expect(title).toBeFocused();
  // The partner keeps working for a few seconds; the brief's read lands meanwhile.
  // A fixed pause is the point of this repro: the defect is what happens after it.
  await new Promise(resolve => setTimeout(resolve, 8_000));
  await expect(screen.getByRole('dialog', { name: /Morning brief/ })).toBeHidden();
  await expect(title).toBeFocused();
});
