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
  let before;
  if (name === 'Deals') {
    await expect.poll(() => browser.evaluate(async () => {
      const sync = (await import('/js/pipeline.js')).state.boardSync;
      return sync.stats().board_failed > 0 && !sync.status().board_read_in_flight && !sync.status().refresh_pending;
    })).toBe(true);
    before = await browser.evaluate(async () => (await import('/js/pipeline.js')).state.boardSync.stats());
  }
  await browser.locator(retry).click();
  if (name === 'Deals') await expect.poll(() => browser.evaluate(async before => {
    const sync = (await import('/js/pipeline.js')).state.boardSync;
    const stats = sync.stats(), status = sync.status();
    return stats.board_reads > before.board_reads && stats.board_failed > before.board_failed
      && !status.board_read_in_flight && !status.refresh_pending;
  }, before)).toBe(true);
  if (name === 'Leads') await expect(browser.locator('#leadBoard')).toHaveAttribute('aria-busy','false');
  await expect(browser.locator(error)).toContainText(/interrupted|sign.in|reconnecting|offline|error/i);
  await expect(browser.locator(updated)).toContainText('Unavailable');
});
