import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.setup('prepare synthetic broker session', { sessions: ['broker'] }, async ({ app, browser, session }) => {
  const response = await fetch(new URL('/api/test/seed', app.baseUrl), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ namespace: 'fix-explore', viewer: 'joe', variant: 'realistic' }),
  });
  expect(response.status).toBe(200);
  const seeded = await response.json();
  await browser.setCookies([seeded.cookie]);
  await app.open('/search?q=Demo');
  await expect(browser.locator('#searchResults [data-group]')).toHaveCount(9);
  await session.save('broker');
});
