import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissBrief, stubVerbs } from '../v1/_h.ts';

// QA-010: "Notification preferences" in the account menu must bring the preference form into view.
// Staging's own feed is empty (the form is on the first screen anyway), so `notification-feed` is stubbed with 14 unread cards
// to recreate V1's long feed above the form.
const feed = () => ({ unread_count: 14, notifications: Array.from({ length: 14 }, (_, i) => ({ id: `qa-n-${i}`, severity: i % 2 ? 'failure' : 'action_required', reason: `QA recheck notification ${i + 1}`, subject_type: 'deal', subject_ref: `D-${i + 1}`, created_at: new Date(Date.now() - i * 60_000).toISOString(), read_at: null, delivery: [], quiet_suppressed: false, deep_link: null })) });
test('QA-010 Notification preferences link scrolls the form into view', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await stubVerbs(browser, { 'notification-feed': { payload: feed() } });
  await app.open('/');
  await dismissBrief(screen);
  await screen.getByRole('button', 'Joe: account and settings').tap();
  // Keyboard activation: the menu items are covered by the rail on staging (QA-001), a pointer tap cannot reach them.
  const link = screen.getByRole('link', 'Notification preferences');
  await link.focus();
  await link.press('Enter');
  await expect(browser).toHaveURL(/\/updates#prefForm$/);
  await expect(screen.getByText('QA recheck notification 1', { exact: true })).toBeAttached();
  await expect(screen.getByText('No quiet hours set', { exact: false })).toBeAttached();
  await browser.evaluate(() => new Promise((resolve) => setTimeout(resolve, 2500))); // let async renders settle
  const inView = () => browser.evaluate(() => {
    const form = document.getElementById('prefForm') as HTMLElement;
    const r = form.getBoundingClientRect();
    return r.top >= 0 && r.top < innerHeight - 40;
  });
  expect(await inView(), 'preference form top edge is inside the viewport after the page settled').toBe(true);
});
