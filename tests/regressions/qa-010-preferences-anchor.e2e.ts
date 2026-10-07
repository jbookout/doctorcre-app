import { reproTest } from './support.mjs';
import { expect } from 'e2e';

const test = reproTest();
test('QA-010 notification preferences navigation brings controls into view', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await app.open('/');
  await screen.getByRole('button', /account and settings/i).tap();
  await screen.getByRole('link', 'Notification preferences').tap();
  await expect(browser).toHaveURL('/updates#prefForm');
  await expect(screen.getByRole('heading', 'Your notification preferences')).toBeVisible();
  await expect(browser.locator('#prefSave')).toBeEnabled();
  const form = await browser.locator('#prefForm').boundingBox();
  const viewport = await browser.evaluate(() => ({ height: innerHeight }));
  expect(form.y, JSON.stringify({ form, viewport })).toBeGreaterThanOrEqual(0);
  expect(form.y, JSON.stringify({ form, viewport })).toBeLessThan(viewport.height);
});
