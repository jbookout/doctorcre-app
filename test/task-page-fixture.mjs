import { readFile } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';

export async function openTasks(t, hooks = '') {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/js/fixture-client.js', async route => {
    let source = await readFile(new URL('../js/fixture-client.js', import.meta.url), 'utf8');
    source = source.replace('export async function createFixtureClient', 'async function originalFixture');
    source += `\nexport async function createFixtureClient(opts) { const c = await originalFixture(opts); ${hooks} return c; }`;
    await route.fulfill({ contentType: 'text/javascript', body: source });
  });
  await page.goto(`${server.origin}/doc-chats/work`, { waitUntil: 'domcontentloaded' });
  return { page, errors };
}

export const waitForTasks = page => page.waitForFunction(() => document.querySelector('#quickAddForm')?.hidden === false);
