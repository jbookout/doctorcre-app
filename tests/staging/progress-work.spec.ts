import { test, expect } from '@playwright/test';

test('Progress work reads project evidence and searches sessions without dispatch', async ({ page }) => {
  await page.goto('/control-room/progress/work?board=carr-v5');
  await page.addLocatorHandler(page.getByRole('button', { name: 'Dismiss morning brief' }), async dismiss => { await dismiss.click(); });
  await expect(page.locator('#workReadState')).not.toHaveText('Loading…', { timeout: 27000 });
  await expect(page.locator('#workReadState')).not.toContainText('Work evidence unavailable');
  await page.locator('#workSessionQuery').fill('V2 no session 35f9009c');
  await page.locator('#workSessionSearch button').click();
  await expect(page.locator('#workSessionList')).not.toBeEmpty();
  for (const section of ['#workSessions', '#workReviews', '#workDot', '#workTasks']) {
    await expect(page.locator(section)).toBeVisible();
  }
});

test('V2-E01: Progress work distinguishes published freshness from an unpublished board', async ({ page }) => {
  const publicationRead = page.waitForResponse(response => new URL(response.url()).pathname === '/mcp'
    && response.request().postDataJSON()?.params?.name === 'read-progress-board');
  await page.goto('/control-room/progress/work?board=carr-v5');
  const response = await publicationRead;
  expect(response.ok()).toBe(true);
  const envelope = await response.json();
  const publication = JSON.parse(envelope.result.content[0].text);
  expect(publication.ok).toBe(true);
  const status = page.locator('#workReadState');
  if (publication.snapshot === null) {
    await expect(status).toHaveAttribute('data-state', 'unpublished', { timeout: 27000 });
    await expect(status).toHaveText('No published snapshot');
  } else {
    expect(Number.isFinite(Date.parse(publication.snapshot.updated_at))).toBe(true);
    await expect(status).toHaveAttribute('data-state', /^(fresh|stale)$/, { timeout: 27000 });
    await expect(status).toHaveText(/^Updated /);
  }
});
