import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissBrief } from './_h.ts';

// QA-004: the repository directory must not push the board lanes thousands of pixels below the first screen.
// Staging's board has "No published snapshot", so there is no repository directory and no lanes to measure.
test('QA-004 board lanes stay near the first screen', { session: 'staging-partner', tags: ['v1'] }, async ({ app, screen, browser }) => {
  await app.open('/control-room/progress');
  await dismissBrief(screen);
  const unpublished = await screen.getByText('No published snapshot', { exact: true }).isVisible();
  test.skip(unpublished, 'staging board says "No published snapshot": the repository directory and the board lanes cannot be reached, so the layout cannot be measured');
  const lanesTop = await browser.evaluate(() => {
    const heading = [...document.querySelectorAll('h2,h3')].find((h) => (h as HTMLElement).innerText.trim() === 'The path to live') as HTMLElement | undefined;
    return heading ? Math.round(heading.getBoundingClientRect().top + scrollY) : -1;
  });
  const viewport = await browser.evaluate(() => innerHeight);
  expect(lanesTop, 'document offset of the first lane').toBeGreaterThanOrEqual(0);
  expect(lanesTop, `first lane offset (viewport ${viewport}px)`).toBeLessThan(viewport * 2);
});
