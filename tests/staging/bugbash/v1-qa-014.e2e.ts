import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { CONTRAST_SRC, dismissBrief, stubJson } from '../v1/_h.ts';

// QA-014: a suggested introduction's description must be legible on the dark Home card.
// Staging has no relationship graph, so the network read is stubbed with the app's own valid snapshot.
test('QA-014 suggested introduction description contrast in dark mode', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  const mod: any = await import('../../../js/relationship-network-fixture.js');
  await stubJson(browser, '**/api/v1/business/relationships*', mod.relationshipNetworkFixture(new Date().toISOString()));
  await app.open('/');
  await dismissBrief(screen);
  await screen.getByRole('button', 'Just Me').tap();
  await expect(screen.getByRole('heading', 'Suggested introductions')).toBeVisible();
  const rows: Array<{ ratio: number; fg: string }> = await browser.evaluate(CONTRAST_SRC, { text: 'Worked together on equipment financing; offered an introduction.' });
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.ratio, `introduction description ${row.fg}`).toBeGreaterThanOrEqual(4.5);
});
