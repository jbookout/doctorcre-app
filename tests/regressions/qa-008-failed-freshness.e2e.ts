import { expect } from 'e2e';
import { reproTest, refuseReads } from './support.mjs';

const test = reproTest();
for (const status of [503,401,403]) test(`QA-008 Tours pending freshness settles after ${status} retry`, { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await refuseReads(browser,status);
  await app.open('/tours?mode=live');
  await expect(browser.locator('#tour-library-state')).toContainText(status === 503 ? /unavailable/i : /sign in/i);
  await screen.getByRole('button', 'Refresh tours', { exact: true }).focus();
  await screen.getByRole('button', 'Refresh tours', { exact: true }).press('Enter');
  await expect(browser.locator('#tour-library-state')).toContainText(status === 503 ? /unavailable/i : /sign in/i);
  await expect(browser.locator('#planner-updated')).toContainText('Unavailable');
  await expect(browser.locator('.app-layout-status')).not.toContainText('Updating…');
});

for (const {name,path,updated,retry,error} of [
  {name:'Leads',path:'/leads?mode=live',updated:'#boardUpdated',retry:'#refreshBoard',error:'#leadBoardError'},
  {name:'Deals',path:'/deals?mode=live',updated:'#boardAsOf',retry:'#retryRead',error:'#boardStatusLabel'},
]) for (const status of [503,401,403]) test(`QA-008 ${name} failed-read freshness settles after ${status} retry`, { tags:['regression'],requires:['browser'],retries:0 }, async ({app,browser}) => {
  await refuseReads(browser,status);
  await app.open(path);
  await expect(browser.locator(error)).toContainText(/interrupted|sign.in|reconnecting|offline|error/i);
  await expect(browser.locator(updated)).toContainText('Unavailable');
  await browser.locator(retry).click();
  if (name === 'Leads') await expect(browser.locator('#leadBoard')).toHaveAttribute('aria-busy','false');
  await expect(browser.locator(error)).toContainText(/interrupted|sign.in|reconnecting|offline|error/i);
  await expect(browser.locator(updated)).toContainText('Unavailable');
});
