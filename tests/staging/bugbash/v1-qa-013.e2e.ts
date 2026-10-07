import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissBrief } from '../v1/_h.ts';

// QA-013: the Vendors route must identify itself as Vendors in the heading a partner can see.
// (The h1 #pageTitle says Vendors but is hidden inside the sidebar; the visible heading is the sidebar's h2.)
test('QA-013 Vendors destination heading is Vendors', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await app.open('/vendors?q=Demo');
  await dismissBrief(screen);
  await expect(screen.getByRole('link', 'Vendors').first()).toBeVisible();
  const heading = () => browser.evaluate(() => (document.querySelector('.app-layout-sidebar-head h2') as HTMLElement | null)?.innerText.trim() ?? '');
  await expect.poll(heading, { message: 'visible workspace heading on /vendors' }).toBe('Vendors');
});
