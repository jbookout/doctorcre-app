import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { PAINTED_SRC, stubVerbs } from '../v1/_h.ts';

// QA-003: when the Deals board cannot be read, a sighted partner must SEE the unavailable message (not only a screen reader).
// Staging is signed in, so the failure is recreated by answering the board read (`deal-room-board`) with 503.
test('QA-003 Deals board failure message is visibly rendered', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await stubVerbs(browser, { 'deal-room-board': { status: 503 } });
  await app.open('/deals');
  await expect(screen.getByRole('status').filter({ hasText: 'The board could not be read' })).toBeAttached();
  const boxes: Array<{ painted: boolean; w: number; h: number; clipped: boolean }> = await browser.evaluate(PAINTED_SRC, { text: 'The board could not be read' });
  expect(boxes.some((b) => b.painted), `unavailable message boxes ${JSON.stringify(boxes)}`).toBe(true);
});
