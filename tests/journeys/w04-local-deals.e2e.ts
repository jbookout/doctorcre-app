import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { readFileSync } from 'node:fs';

// The synthetic board seed, with one automatic phase move recorded on d14.
const seed = JSON.parse(readFileSync(new URL('../../data/board-seed.json', import.meta.url), 'utf8'));
seed.deals.find((deal: { id: string }) => deal.id === 'd14').phase = 'Negotiation';
seed.seed_events.push({
  id: 'e2e-auto-loi', actor: 'claude', verb: 'patch-deal-field', subject_type: 'deal', subject_id: 'd14',
  field: 'phase', old_value: 'Research', new_value: 'Negotiation', automatic: true,
  change_reason: 'LOI sent', evidence_date: '2026-10-03', recorded_at: '2026-10-03T12:00:00Z',
});

test('W4 Local Deals board moves a deal and undoes only the move just made', async ({ app, browser, screen }) => {
  await browser.route('**/data/board-seed.json', route => route.fulfill({ json: seed }));
  await app.open('/deals');

  await expect(browser.locator('#pageTitle')).toHaveText('Local Deals');
  await expect(browser.locator('.kanban-column')).toHaveCount(7);
  await browser.locator('#listView').tap();
  await expect(browser.locator('.deal-row[data-id="d14"] .deal-stage')).toHaveText('Negotiating');
  await expect(browser.locator('.deal-row[data-id="d14"] .auto-move, .deal-row[data-id="d14"] [data-undo]')).toHaveCount(0);
  await browser.locator('#boardView').tap();

  await expect(browser.locator('[data-id="d14"] [data-undo]')).toHaveCount(0);

  const phone = await browser.evaluate(() => innerWidth <= 760);
  const move = async () => {
    if (phone) {
      // Phones use the existing deal phase picker; HTML drag remains desktop-only.
      await browser.locator('[data-column="negotiation"] [data-id="d23"] .card-open').tap();
      await expect(browser.locator('#detailPhase')).toBeVisible();
      await browser.locator('#detailPhase').selectOption({ value: 'legal' });
    } else {
      await browser.evaluate(() => document.querySelector('[data-column="negotiation"] [data-id="d23"]')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'instant' }));
      await browser.locator('[data-column="negotiation"] [data-id="d23"]').dragTo(browser.locator('[data-column="legal"]'));
    }
  };
  await move();
  await expect(browser.locator('#completionDialog')).toBeVisible();
  await browser.locator('#completionDialog #completionCancel').tap();
  await expect(browser.locator('#completionDialog')).toBeHidden();
  if (phone) {
    await browser.locator('#recordPanel [aria-label="Close deal"]').tap();
    await expect(browser.locator('#recordPanel')).toBeHidden();
  }
  await expect(browser.locator('[data-column="negotiation"] [data-id="d23"]')).toBeVisible();
  await move();
  await expect(browser.locator('#completionDialog')).toBeVisible();
  await browser.locator('#completionConfirm').tap();
  await expect(browser.locator('#completionDialog')).toBeHidden();
  if (phone) {
    await browser.locator('#recordPanel [aria-label="Close deal"]').tap();
    await expect(browser.locator('#recordPanel')).toBeHidden();
  }
  await expect(browser.locator('[data-column="legal"] [data-id="d23"]')).toBeVisible();
  await expect(browser.locator('[data-column="negotiation"] [data-id="d23"]')).toHaveCount(0);
  await browser.locator('.toast [data-undo]').tap();
  await expect(screen.getByRole('status').filter({ hasText: 'Change undone' })).toBeVisible();
  await expect(browser.locator('[data-column="negotiation"] [data-id="d23"]')).toBeVisible();
  await expect(browser.locator('[data-id="d23"] [data-undo]')).toHaveCount(0);

});
