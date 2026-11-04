import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const deal = '11111111-1111-4111-8111-111111111111';
const tour = '22222222-2222-4222-8222-222222222222';
for (const width of [390,1024,1440]) for (const theme of ['light','dark']) test(`Tours lists deals and has no standalone creation at ${width} ${theme}`, async ({page}) => {
  await page.setViewportSize({width,height:900});
  await page.route('http://localhost/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/tours/library') return route.fulfill({json:{data:{tours:[{id:tour,deal_id:deal,deal_name:'Demo practice',name:'Demo tour',status:'draft'}]}}});
    if (path.startsWith('/api/') || path === '/mcp') return route.fulfill({json:{data:{},actor:{slug:'joe'}}});
    try { return route.fulfill({body:await readFile(new URL(path === '/tours' ? 'tours/index.html' : path.slice(1),root)),contentType:path.endsWith('.js') || path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'}); }
    catch { return route.fulfill({status:404}); }
  });
  await page.goto('http://localhost/tours');
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; },theme);
  const link=page.locator('#upcoming-tours a');
  await expect(link).toHaveText('Demo tour');
  await expect(link).toHaveAttribute('href',`/deals?deal=${deal}&tab=tours&tour=${tour}`);
  await expect(page.locator('#create-tour-form, #plan-form')).toHaveCount(0);
});
