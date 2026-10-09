import { test } from '@e2e-dev/web';
import { stagingSession } from '../../scripts/e2e-staging/session.mjs';

test.setup('obtain a staging partner session without browser login', { sessions: ['staging-partner'] }, async ({ app, browser, session }) => {
  const { state } = await stagingSession(app.baseUrl);
  await browser.setCookies(state.cookies);
  await app.open('/');
  if (await browser.evaluate(() => location.pathname.startsWith('/auth/'))) throw new Error('Staging partner still faces sign-in');
  await session.save('staging-partner');
});
