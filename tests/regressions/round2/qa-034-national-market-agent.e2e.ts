import { expect } from 'e2e';
import { reproTest } from '../support.mjs';

const test = reproTest();
test('QA-034 National Accounts detail preserves an unassigned market agent', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser }) => {
  await app.open('/deals?view=national');
  await expect(browser.locator('[data-account="demo-account-001"]')).toBeVisible();
  await browser.locator('[data-account="demo-account-001"]').tap();
  await expect(browser.locator('[data-market-agent="d05"]')).toHaveText('Assign agent…');
  await browser.locator('.row-menu[data-open-deal="d05"]').tap();
  await expect(browser.locator('#dealDialog')).toBeVisible();
  await expect(browser.locator('#dealDialog')).toContainText('Demo Family Clinic');
  const agent = await browser.evaluate(() => {
    const field = [...document.querySelectorAll('#dealDialog .detail-card')].find(node => node.querySelector('label')?.textContent === 'Market agent');
    return field?.querySelector('p')?.textContent || null;
  });
  console.log('Unassigned listing market agent in detail:', agent);
  await app.screenshot('qa-034-national-unassigned-market-agent-detail');
  expect(agent).toMatch(/unassigned|not assigned|not captured/i);
});
