import { test, expect } from '@playwright/test';
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
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
  await server?.stop();
});

import '../staging/signed-in.spec.ts';

test('navigation, reload and a delayed save still verify the session after background updates pause', async ({ page }) => {
  await page.clock.install();
  await page.goto('/leads');
  await expect(page.getByRole('button', { name: 'Joe: account and settings', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const { pollSafety } = await import('/js/poll-safety.mjs');
    const safety = pollSafety(window, { document });
    await safety.run(async () => {
      for (let i = 0; i < 91; i++) {
        await safety.fetch(window.fetch.bind(window), '/api/synthetic-budget-read').catch(() => {});
      }
    }, { initial: true });
  });
  await expect(page.locator('[data-poll-safety]')).toContainText('request limit');

  const identityAfterNavigation = page.waitForResponse('**/auth/session');
  await page.goto('/vendors');
  expect((await identityAfterNavigation).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Joe: account and settings', exact: true })).toBeVisible();

  const identityAfterReload = page.waitForResponse('**/auth/session');
  await page.reload();
  expect((await identityAfterReload).status()).toBe(200);
  await page.clock.fastForward(6_000);
  const save = page.waitForRequest('**/api/synthetic-delayed-save');
  const saved = await page.evaluate(async () => {
    const { sessionFetch } = await import('/js/private-session.js');
    return (await sessionFetch('/api/synthetic-delayed-save', { method: 'POST', body: '{}' })).ok;
  });
  expect((await save).method()).toBe('POST');
  expect(saved).toBe(true);
});

test('a delayed save remains human while an exhausted background cycle is still settling', async ({ page }) => {
  await page.clock.install();
  await page.goto('/leads');
  await expect(page.getByRole('button', { name: 'Joe: account and settings', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const { pollSafety } = await import('/js/poll-safety.mjs');
    const safety = pollSafety(window, { document });
    window.backgroundDone = safety.run(async () => {
      for (let i = 0; i < 91; i++) {
        await safety.fetch(window.fetch.bind(window), '/api/synthetic-budget-read').catch(() => {});
      }
      await new Promise(resolve => { window.releaseBackground = resolve; });
    }, { initial: true });
  });
  await page.waitForFunction(() => typeof window.releaseBackground === 'function');
  await expect(page.locator('[data-poll-safety]')).toContainText('request limit');
  await page.clock.fastForward(6_000);
  const saved = await page.evaluate(async () => {
    const { sessionFetch } = await import('/js/private-session.js');
    try { return (await sessionFetch('/api/synthetic-delayed-save', { method: 'POST', body: '{}' })).ok; }
    catch (error) { return error.code; }
    finally { window.releaseBackground(); await window.backgroundDone; }
  });
  expect(saved).toBe(true);
});
