import { test as setup, expect } from '@playwright/test';

setup('authenticate the staging test account', async ({ request }) => {
  const secret = process.env.E2E_SESSION_SECRET;
  if (!secret) throw new Error('E2E_SESSION_SECRET must be provided through the environment');

  const response = await request.post('/auth/e2e-session', {
    headers: { authorization: `Bearer ${secret}` },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(200);

  const session = await request.get('/auth/session');
  expect(session.status()).toBe(200);
  const identity = await session.json();
  expect(identity.e2e_principal).toBe('e2e-joe');
  expect(identity.actor?.slug).toBe('joe');
  await request.storageState({ path: 'playwright/.auth/staging.json' });
});
