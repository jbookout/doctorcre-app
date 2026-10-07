import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissBrief, stubJson } from '../v1/_h.ts';

// QA-017: the Vendors load failure must be exposed to assistive technology as an alert or status.
test('QA-017 Vendors load failure is exposed as an alert or status', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await stubJson(browser, '**/api/v1/business/vendors?*', { error: 'INTERNAL_ERROR' }, 503);
  await app.open('/vendors');
  await dismissBrief(screen);
  await expect(screen.getByText('This did not load', { exact: true }).first()).toBeVisible();
  const live = await browser.evaluate(() => {
    const el = [...document.querySelectorAll('main *')].find((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim() === 'This did not load'));
    const host = el?.closest('[role=alert],[role=status],[aria-live]');
    return host ? `${host.tagName.toLowerCase()}[role=${host.getAttribute('role')}][aria-live=${host.getAttribute('aria-live')}]` : null;
  });
  expect(live, 'live region (alert/status/aria-live) that contains "This did not load"').not.toBeNull();
});
