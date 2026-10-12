import { reproTest } from './support.mjs';
import { expect } from 'e2e';

const test = reproTest();
test('QA-018 Ask Doc failure states submission status and recovery', { tags: ['regression'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await app.open('/');
  await screen.getByRole('button', 'Open Doc', { exact: true }).tap();
  const input = screen.getByRole('combobox', 'Search anything or ask Doc', { exact: true });
  await input.fill('Ask Doc: What lease terms should a fictional dental practice review?');
  await expect(browser.locator('#docCommandStatus')).toHaveText('No matches');
  await input.press('Enter');
  await expect(browser.locator('#docCommandStatus')).toContainText(/unavailable/i);
  await expect(browser.locator('#docCommandStatus')).toContainText(/not submitted|not sent|was not sent|not delivered/i);
  await expect(browser.locator('#docCommandStatus')).toContainText(/retry|try again|contact|refresh/i);
});
