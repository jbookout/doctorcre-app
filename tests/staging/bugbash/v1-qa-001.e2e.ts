import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissBrief } from '../v1/_h.ts';

// QA-001: the account menu must be fully visible and reachable beside the workspace rail.
test('QA-001 account menu is not clipped by the workspace rail', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await app.open('/');
  await dismissBrief(screen);
  await screen.getByRole('button', 'Joe: account and settings').tap();
  await expect(screen.getByRole('button', 'Joe: account and settings', { expanded: true })).toBeVisible();

  const covered = await browser.evaluate(() => {
    const names = ['Profile', 'Theme', 'Notification preferences', 'Doc Activity', 'Sign out'];
    const menu = document.getElementById('accountMenu') as HTMLElement;
    return [...menu.querySelectorAll('button,a')].filter((e) => names.includes((e as HTMLElement).innerText.trim())).map((e) => {
      const r = e.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const inside = r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      const reachable = !!top && (top === e || e.contains(top)) && inside;
      const hit = top ? `${top.tagName.toLowerCase()}${top.id ? '#' + top.id : ''}` : 'nothing';
      return reachable ? null : `${(e as HTMLElement).innerText.trim()} (hit-test lands on ${hit}; box ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)})`;
    }).filter(Boolean);
  });
  expect(covered, 'account menu items that are clipped or covered').toEqual([]);
});
