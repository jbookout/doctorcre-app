import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openTasks, waitForTasks } from './task-page-fixture.mjs';

const hooks = `
  window.focusRows = ['1', '2', '3'];
  c.loopBoard = async args => {
    if (window.holdFocusRead && args.summary === false) await new Promise(resolve => { (window.focusReplies ??= []).push(resolve); });
    if (window.failFocusBoard) throw Error('Synthetic board failure');
    const loops = args.kind === 'team_loop' ? window.focusRows.map(number => ({
      number, kind: 'team_loop', status: 'open', owner: window.focusOwners?.[number] || 'joe', marker: 'none',
      title: 'Synthetic task ' + number, version: 1
    })) : [];
    if (args.summary === false) window.focusReads = (window.focusReads || 0) + 1;
    return { loops, count: loops.length };
  };
  const getBoard = c.getBoard;
  c.getBoard = async args => {
    if (window.failFocusActor) throw Error('Synthetic identity failure');
    const board = await getBoard(args);
    return { ...board, actor: window.focusActor || board.actor };
  };
`;

async function refresh(page, rows) {
  const reads = await page.evaluate(() => window.focusReads);
  await page.evaluate(rows => {
    window.focusRows = rows;
    window.dispatchEvent(new Event('online'));
  }, rows);
  await page.waitForFunction(reads => window.focusReads >= reads + 2 && document.querySelector('#quickAddForm')?.hidden === false, reads);
}

const active = page => page.evaluate(() => ({
  task: document.activeElement?.getAttribute('data-task'),
  handover: document.activeElement?.getAttribute('data-handover'),
  scope: document.activeElement?.getAttribute('data-scope'),
  id: document.activeElement?.id,
}));

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`removed task controls retain keyboard focus at ${width} in ${theme}`, async t => {
    const { page, errors } = await openTasks(t, hooks);
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await waitForTasks(page);
    for (const [removed, expected] of [['1', '2'], ['2', '3'], ['3', '2']]) {
      await page.reload();
      await waitForTasks(page);
      await page.locator(`[data-task="team_loop:${removed}"]`).focus();
      await refresh(page, ['1', '2', '3'].filter(number => number !== removed));
      assert.equal((await active(page)).task, `team_loop:${expected}`);
    }
    await page.reload();
    await waitForTasks(page);
    await page.locator('[data-handover="team_loop:2"]').focus();
    await refresh(page, ['1', '3']);
    assert.equal((await active(page)).task, 'team_loop:3');
    for (const attribute of ['data-task', 'data-handover']) {
      await page.locator(`[${attribute}="team_loop:1"]`).focus();
      await refresh(page, ['1', '3']);
      assert.equal((await active(page))[attribute === 'data-task' ? 'task' : 'handover'], 'team_loop:1');
    }
    await page.reload();
    await waitForTasks(page);
    await refresh(page, ['1']);
    await page.locator('[data-task="team_loop:1"]').focus();
    await refresh(page, []);
    assert.equal((await active(page)).scope, 'team');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement !== document.body), true);
    await page.locator('#scopeSwitch [aria-pressed="true"]').focus();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const evidence = '.github/pr-evidence/WR39.S1.J19';
    await mkdir(evidence, { recursive: true });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: `${evidence}/${width}-${theme}-empty-focus.png`, fullPage: true });
    assert.deepEqual(errors, []);
  });
}

test('pending task reads respect another focused control and actor privacy', async t => {
  const { page, errors } = await openTasks(t, hooks);
  await waitForTasks(page);
  await page.locator('[data-task="team_loop:1"]').focus();
  await page.evaluate(() => {
    window.holdFocusRead = true;
    window.dispatchEvent(new Event('online'));
  });
  await page.waitForFunction(() => window.focusReplies?.length === 2);
  await page.locator('#scopeSwitch [data-scope="team"]').focus();
  await page.evaluate(() => { window.holdFocusRead = false; window.focusReplies.splice(0).forEach(resolve => resolve()); });
  await waitForTasks(page);
  assert.equal((await active(page)).scope, 'team');
  await page.locator('[data-task="team_loop:1"]').focus();
  await page.evaluate(() => window.focusActor = 'dell');
  await refresh(page, ['1', '2', '3']);
  assert.equal((await active(page)).task, null);
  await page.locator('[data-task="team_loop:1"]').focus();
  await page.evaluate(() => window.failFocusActor = true);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.querySelector('#taskStatusLabel')?.textContent === 'Account unverified');
  assert.equal(await page.locator('#taskList [data-task]').count(), 0);
  assert.equal((await active(page)).task, null);
  assert.deepEqual(errors, []);
});

test('focus recovery follows visible ownership and retains Retry for a failed board', async t => {
  const { page, errors } = await openTasks(t, hooks);
  await waitForTasks(page);
  await page.locator('#scopeSwitch [data-scope="mine"]').click();
  await page.locator('[data-task="team_loop:2"]').focus();
  await page.evaluate(() => window.focusOwners = { '2': 'dell' });
  await refresh(page, ['1', '2', '3']);
  assert.equal((await active(page)).task, 'team_loop:3');
  assert.equal(await page.locator('[data-task="team_loop:2"]').count(), 0);
  await page.evaluate(() => window.failFocusBoard = true);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => document.activeElement?.id === 'retryRead');
  assert.equal(await page.locator('#taskList [data-task]').count(), 0);
  assert.deepEqual(errors, []);
});
