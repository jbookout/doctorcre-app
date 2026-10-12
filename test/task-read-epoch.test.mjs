import test from 'node:test';
import assert from 'node:assert/strict';
import { openTasks, waitForTasks } from './task-page-fixture.mjs';

const boardHooks = `window.taskReplies ??=[]; const loops=c.loopBoard; c.loopBoard=async args=>{
 const payload=await loops(args); if(window.holdTasks && args.summary===false) await new Promise(resolve=>window.taskReplies.push(resolve)); return payload;
}; const identity=c.getBoard; c.getBoard=async args=>{
 if(window.failIdentity) throw Error('synthetic identity failure');
 if(window.holdIdentity) await new Promise(resolve=>window.identityReplies.push(resolve)); return identity(args);
}; window.identityReplies ??=[];`;

test('a failed identity read fences out an earlier successful Tasks board response', async t => {
  const { page, errors } = await openTasks(t, `window.holdTasks=true; ${boardHooks}`);
  await page.waitForFunction(() => window.taskReplies?.length === 2);
  await page.evaluate(() => { window.failIdentity=true; window.dispatchEvent(new Event('online')); });
  await page.waitForFunction(() => document.querySelector('#taskStatusLabel')?.textContent === 'Account unverified');
  await page.evaluate(() => window.taskReplies.splice(0).forEach(resolve => resolve()));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await page.locator('#taskList [data-task]').count(), 0);
  assert.equal(await page.locator('#quickAddForm').isVisible(), false);
  assert.deepEqual(errors, []);
});

test('identity verification conceals prior rows and task details until the current board returns', async t => {
  const { page, errors } = await openTasks(t, boardHooks);
  await waitForTasks(page);
  await page.locator('#taskList [data-task]').first().click();
  await page.locator('#taskDialog').waitFor({ state: 'visible' });
  await page.evaluate(() => { window.holdIdentity=true; window.dispatchEvent(new Event('online')); });
  await page.waitForFunction(() => window.identityReplies.length > 0);
  assert.equal(await page.locator('#taskDialog').isVisible(), false);
  assert.equal(await page.locator('#taskList [data-task]').count(), 0);
  await page.evaluate(() => { window.holdIdentity=false; window.identityReplies.splice(0).forEach(resolve => resolve()); });
  await waitForTasks(page);
  assert.ok(await page.locator('#taskList [data-task]').count());
  assert.deepEqual(errors, []);
});

test('a concealed task dialog sends focus to Retry after failed identity verification', async t => {
  const { page, errors } = await openTasks(t, boardHooks);
  await waitForTasks(page);
  await page.locator('#taskList [data-task]').first().click();
  await page.locator('#taskDialog').waitFor({ state: 'visible' });
  await page.evaluate(() => { window.failIdentity=true; window.dispatchEvent(new Event('online')); });
  await page.waitForFunction(() => document.activeElement?.id === 'retryRead');
  assert.equal(await page.locator('#taskDialog').isVisible(), false);
  assert.deepEqual(errors, []);
});
