import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { stagingSession } from '../../scripts/e2e-staging/session.mjs';

// Sign in once by API, per `npx e2e guide writing-tests` (Sign-in sessions):
// the staging session exchange sets the normal secure cookie, and
// browser.setCookies restores it. No password is typed, so every test and
// exploration that restores this session keeps its screenshots.
test.setup('staging partner session by cookie exchange', { sessions: ['staging-partner'] }, async ({ app, browser, screen, session }) => {
  const { state } = await stagingSession(app.baseUrl);
  await browser.setCookies(state.cookies);
  await app.open('/');
  await expect(browser).toHaveURL(/^[^?#]*\/(\?.*)?$/);
  await expect(screen.getByRole('navigation').first()).toBeVisible();
  // The morning brief opens by itself, a few seconds after load, once per day
  // (local storage key doctorcre:morning:<partner>). Let it open and dismiss it
  // here so the saved session carries "shown today" and later tests start the
  // way a partner's second page of the day does. Its own journey reopens it.
  const brief = screen.getByRole('button', { name: 'Dismiss morning brief' });
  await expect(brief).toBeVisible({ timeout: 30_000 }).catch(() => undefined);
  if (await brief.isVisible().catch(() => false)) await brief.click();
  await expect(screen.getByRole('dialog', { name: /Morning brief/ })).toBeHidden();
  // The progress board is the second surface; prove the same session reaches it signed in.
  await app.open('/control-room/progress');
  await expect(browser).toHaveURL(/\/control-room\/progress/);
  await session.save('staging-partner');
});
