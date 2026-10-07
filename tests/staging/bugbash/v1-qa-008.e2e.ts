import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissBrief, stubJson } from '../v1/_h.ts';

// QA-008: after the Tours request fails (and a keyboard Refresh), the footer must settle instead of staying "Updating…".
test('QA-008 Tours footer settles after a failed request and retry', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await stubJson(browser, '**/api/tours/library', { error: 'carr_unavailable' }, 503);
  await app.open('/tours');
  await dismissBrief(screen);
  await expect(screen.getByText('Tours temporarily unavailable.', { exact: true })).toBeVisible();
  const refresh = screen.getByRole('button', 'Refresh tours');
  await refresh.focus();
  await refresh.press('Enter');
  await expect(screen.getByText('Tours temporarily unavailable.', { exact: true })).toBeVisible();
  const footer = () => browser.evaluate(() => (document.querySelector('footer, [role=contentinfo]') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim() ?? '');
  await expect.poll(footer, { message: 'footer text after the failed Tours read' }).not.toContain('Updating…');
});
