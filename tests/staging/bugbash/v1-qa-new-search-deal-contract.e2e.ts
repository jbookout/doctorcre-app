import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissBrief } from '../v1/_h.ts';

// NEW (found while re-checking QA-006/007/011/012, not in the V1 list): staging's `find` returns deal rows with extra keys
// (lane, invoiced_on, closed_on, outcome); js/search-model.js DEAL_KEYS accepts only four, so any search that matches a
// deal shows "Search temporarily unavailable" although the record layer answered.
test('NEW search that matches a deal shows results, not "temporarily unavailable"', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await app.open('/search');
  await dismissBrief(screen);
  const dealMatches: number = await browser.evaluate(async () => {
    const r = await fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find', arguments: { query: 'QA' } } }) });
    const body = await r.json();
    return JSON.parse(body.result.content[0].text).deals.length;
  });
  test.skip(dealMatches === 0, 'no deal named like "QA" on staging right now');
  await screen.getByLabel('Name to search').fill('QA');
  await screen.getByRole('button', 'Search', { exact: true }).tap();
  const phase = () => browser.evaluate(() => document.getElementById('searchState')?.getAttribute('data-state') ?? '');
  await expect.poll(phase, { message: 'search page state after a query that matches a deal', timeout: 20_000 }).toBe('ready');
});
