import { test, seedFixture, QA_NAMESPACE } from './support.ts';
import { expect, unique } from 'e2e';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

test.beforeEach(async ({ app, browser }) => {
  const seeded = await seedFixture(app.baseUrl!, `${QA_NAMESPACE}-capabilities`, 'joe');
  await browser.setCookies([seeded.cookie]);
});

test('model judgments wait for and extract the visible workspace', { tags: ['capability', 'agent'] }, async ({ app, agent, screen }) => {
  await app.open('/design-lab');
  await agent.waitFor('the Design Lab page has loaded and its visual system section tabs are available');
  const value = await agent.extract('the main page title', { schema: z.object({ title: z.string().min(1) }) });
  expect(value.title).toBe('Design Lab');
  await agent.assert('the page uses a dark background and displays colour-role swatches and a contrast table', { vision: true });
  await agent.assert('the page has a dark background and the Design Lab title is visible', { vision: 'only', agent: 'skeptic' });
  await expect(screen.getByRole('heading', 'Design Lab')).toBeVisible();
  await app.screenshot('design-lab-visual-judgment');
});

test('a goal types a unique parameter and preserves it in the search address', { tags: ['capability', 'agent'] }, async ({ app, agent, screen, browser }) => {
  const term = `QA synthetic ${randomUUID()}`;
  await app.open('/search');
  await agent.act('Enter {term} into Name to search and submit Search.', { params: { term: unique(term) } });
  await expect(screen.getByLabel('Name to search')).toHaveValue(term);
  expect(new URL(await browser.url()).searchParams.get('q')).toBe(term);
});

test('tool-loop executor navigates using its own vocabulary', { agent: 'limited-loop', tags: ['capability', 'agent'] }, async ({ app, agent, screen }) => {
  await app.open('/');
  await agent.act('open /doc-activity and confirm Doc Activity is visible');
  await expect(screen.getByRole('heading', 'Doc Activity').first()).toBeVisible();
});

test('model-free executor accepts its supported assertion and rejects other work', { agent: 'scripted', tags: ['capability'] }, async ({ app, agent }) => {
  await app.open('/doc-activity');
  await agent.assert('the screen contains Doc Activity');
  let code = '';
  try { await agent.act('perform a job this executor does not understand'); }
  catch (error) { if (error instanceof Error && 'code' in error && typeof error.code === 'string') code = error.code; }
  expect(code).toBe('AUTOMATION_UNSUPPORTED');
});

test('presentation survives restart and clearState resets the client', { tags: ['capability'] }, async ({ app, browser }) => {
  await app.open('/');
  await browser.evaluate(() => localStorage.setItem('qa-state', 'synthetic-round2'));
  await app.restart();
  expect(await browser.evaluate(() => localStorage.getItem('qa-state'))).toBe('synthetic-round2');
  await app.clearState();
  expect(await browser.evaluate(() => localStorage.getItem('qa-state'))).toBe(null);
  const seeded = await seedFixture(app.baseUrl!, `${QA_NAMESPACE}-capabilities`, 'joe');
  await browser.setCookies([seeded.cookie]);
  await app.open('/');
  await app.open('/doc-activity');
  await app.back();
  await expect(browser).toHaveURL('/');
});

test('init script, viewport, locale and timezone are observable without a model', { tags: ['capability'] }, async ({ app, browser }) => {
  await browser.addInitScript(() => { Math.random = () => 0.125; });
  await browser.setViewport({ width: 390, height: 844 });
  await app.open('/calendar');
  expect(await browser.evaluate(() => Math.random())).toBe(0.125);
  expect(await browser.evaluate(() => innerWidth)).toBe(390);
  expect(await browser.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('America/Chicago');
  expect(await browser.evaluate(() => navigator.language)).toBe('en-US');
  await expect(browser.locator('#calGrid')).toBeVisible();
});

test('request interception checks a fixture release response', { tags: ['capability'] }, async ({ app, browser }) => {
  await browser.route('**/app-release', route => route.fulfill({ json: { service: 'doctorcre-app', environment: 'fixture-round2' } }));
  await app.open('/');
  const [response] = await Promise.all([
    browser.waitForResponse('**/app-release'),
    browser.evaluate(() => fetch('/app-release').then(response => response.json())),
  ]);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ service: 'doctorcre-app', environment: 'fixture-round2' });
});

test('native app capability filter excludes web-only targets', { requires: ['native-app'], tags: ['capability'] }, async ({ app }) => {
  await app.open();
});
