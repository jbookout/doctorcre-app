import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissBrief, stubVerbs } from '../v1/_h.ts';

// QA-016: a page that says "Sign-in required" must offer a sign-in action or instructions.
// Staging is signed in, so the refusal is recreated by answering the identity read (`deal-room-board`) with 401.
test('QA-016 Leads sign-in refusal offers a way to sign in', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await stubVerbs(browser, { 'deal-room-board': { status: 401, error: 'not_authenticated' } });
  await app.open('/leads');
  await dismissBrief(screen);
  await expect(screen.getByRole('alert').filter({ hasText: 'Sign-in required' })).toBeVisible();
  const actions: string[] = await browser.evaluate(() => [...document.querySelectorAll('main a[href], main button')].map((e) => ((e as HTMLElement).innerText || e.getAttribute('aria-label') || '').trim()).filter((t) => /^sign.?in\b/i.test(t) || /log.?in/i.test(t)));
  expect(actions, 'sign-in actions offered next to the refusal').not.toEqual([]);
});
