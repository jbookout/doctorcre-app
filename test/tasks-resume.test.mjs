import test from 'node:test';
import assert from 'node:assert/strict';
import { openTasks, waitForTasks } from './task-page-fixture.mjs';

test('Tasks rereads on return without filing or replacing the current Quick Add draft', async t => {
  const { page, errors } = await openTasks(t, `window.taskReads ??=0; window.taskWrites ??=0;
    const read=c.loopBoard; c.loopBoard=args=>{if(args.summary===false)window.taskReads++;return read(args);};
    for(const name of ['addLoop','updateLoop','closeLoop']) { const write=c[name]; c[name]=args=>{window.taskWrites++;return write(args);}; }`);
  await waitForTasks(page);
  await page.locator('#quickAddInput').fill('Call about the synthetic practice Friday');
  await page.locator('#quickAddDate').fill('2026-12-01');
  const before = await page.evaluate(() => ({ reads: window.taskReads, rows: document.querySelector('#taskList').textContent,
    draft: document.querySelector('#quickAddInput').value, date: document.querySelector('#quickAddDate').value }));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.waitForFunction(reads => window.taskReads > reads && document.querySelector('#quickAddForm')?.hidden === false, before.reads);
  const after = await page.evaluate(() => ({ reads: window.taskReads, rows: document.querySelector('#taskList').textContent,
    draft: document.querySelector('#quickAddInput').value, date: document.querySelector('#quickAddDate').value }));
  assert.equal(after.reads, before.reads + 2);
  assert.deepEqual({ ...after, reads: before.reads }, before);
  assert.equal(await page.evaluate(() => window.taskWrites), 0);
  assert.deepEqual(errors, []);
});
