import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { CONTRAST_SRC, dismissBrief } from '../v1/_h.ts';

// QA-002: light appearance must keep Home card text readable (WCAG AA 4.5:1).
// Staging Home has no "Demo ..." deal or invoice cards, so every text node on Home is checked instead.
test('QA-002 Home text keeps 4.5:1 contrast in light theme', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await app.open('/');
  await dismissBrief(screen);
  await screen.getByRole('button', 'Dark mode', { pressed: true }).tap();
  await expect(screen.getByRole('button', 'Dark mode', { pressed: false })).toBeVisible();
  const rows: Array<{ ratio: number; text: string; fg: string }> = await browser.evaluate(CONTRAST_SRC, { text: '', exact: false, selector: 'main *' });
  expect(rows.length).toBeGreaterThan(5);
  const bad = rows.filter((r) => r.ratio < 4.5).sort((a, b) => a.ratio - b.ratio).slice(0, 5).map((r) => `${r.ratio}:1 "${r.text}" ${r.fg}`);
  expect(bad, 'Home text below 4.5:1 in light theme (worst five)').toEqual([]);
});
