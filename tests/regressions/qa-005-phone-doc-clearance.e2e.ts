import { reproTest } from './support.mjs';
import { expect } from 'e2e';

const test = reproTest();
test('QA-005 final Opportunity score remains uncovered on a phone', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open('/leads');
  const card = screen.getByRole('button', 'Dr. Demo 12', { exact: true });
  await expect(card).toBeVisible();
  await card.scrollIntoView();
  await browser.evaluate(() => { const main = document.querySelector('.app-layout-main') || document.scrollingElement; main.scrollTop = main.scrollHeight; window.scrollTo(0, document.body.scrollHeight); });
  const visibility = await browser.evaluate(() => {
    const card = [...document.querySelectorAll('.lead-card')].find(n => n.getAttribute('aria-label') === 'Dr. Demo 12');
    const score = card.querySelector('.score'), b = score.getBoundingClientRect();
    const points = [{ x: b.right - 3, y: b.bottom - 3 }, { x: b.left + b.width / 2, y: b.top + b.height / 2 }];
    return { score: score.innerText, box: { x: b.x, y: b.y, width: b.width, height: b.height }, visible: points.every(p => { const top = document.elementFromPoint(p.x, p.y); return top && score.contains(top); }), cover: points.map(p => document.elementFromPoint(p.x, p.y)?.id || document.elementFromPoint(p.x, p.y)?.className || null) };
  });
  expect(visibility.visible, JSON.stringify(visibility)).toBe(true);
});
