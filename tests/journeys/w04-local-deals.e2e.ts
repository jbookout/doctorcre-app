import { productTest } from './test.mjs';
const test = productTest();
import { expect } from 'e2e';
import { readFileSync } from 'node:fs';

// The synthetic board seed, with one automatic phase move Doc recorded on d14.
const seed = JSON.parse(readFileSync(new URL('../../data/board-seed.json', import.meta.url), 'utf8'));
seed.deals.find((deal: { id: string }) => deal.id === 'd14').phase = 'Negotiation';
seed.seed_events.push({
  id: 'e2e-auto-loi', actor: 'claude', verb: 'patch-deal-field', subject_type: 'deal', subject_id: 'd14',
  field: 'phase', old_value: 'Research', new_value: 'Negotiation', automatic: true,
  change_reason: 'LOI sent', evidence_date: '2026-10-03', recorded_at: '2026-10-03T12:00:00Z',
});

// W4: the Local Deals board moves a card by drag and undoes Doc's automatic move.
test('W4 Local Deals board drags a phase change and undoes an automatic move', async ({ app, browser, screen }) => {
  await browser.route('**/data/board-seed.json', route => route.fulfill({ json: seed }));
  await app.open('/deals');

  await expect(browser.locator('#pageTitle')).toHaveText('Local Deals');
  await expect(browser.locator('.kanban-column')).toHaveCount(8);
  const autoMove = browser.locator('[data-column="negotiation"] [data-id="d14"] .auto-move');
  await expect(autoMove).toContainText('Moved by Doc: LOI sent');

  await screen.getByRole('button', 'Undo phase change on Demo Surgical Practice').tap();
  await expect(screen.getByRole('status').filter({ hasText: 'Change undone' })).toBeVisible();
  await expect(browser.locator('[data-column="research"] [data-id="d14"]')).toBeVisible();
  await expect(browser.locator('[data-id="d14"] .auto-move')).toHaveCount(0);

  await browser.locator('[data-column="negotiation"] [data-id="d23"]').dragTo(browser.locator('[data-column="legal"]'));
  await expect(browser.locator('#completionDialog')).toBeVisible();
  await browser.locator('#completionConfirm').tap();
  await expect(browser.locator('#completionDialog')).toBeHidden();
  await expect(browser.locator('[data-column="legal"] [data-id="d23"]')).toBeVisible();
  await expect(browser.locator('[data-column="negotiation"] [data-id="d23"]')).toHaveCount(0);
});
