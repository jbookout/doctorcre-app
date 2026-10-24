import { test } from '@playwright/test';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';

const origin = 'https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev';
test.use({ baseURL: origin });

let server;
test.beforeEach(async ({ page }) => {
  server = await startFixtureServer();
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/auth/session') return route.fulfill({
      json: { actor: { slug: 'joe', display_name: 'Joe' }, csrf_token: 'synthetic-session' },
    });
    if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') return route.fulfill({ json: {} });
    const response = await route.fetch({ url: `${server.url}${url.pathname}${url.search}` });
    return route.fulfill({ response });
  });
});
test.afterEach(() => server?.stop());

import '../staging/signed-in.spec.ts';
