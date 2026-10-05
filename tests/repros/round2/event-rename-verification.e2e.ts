import { expect } from 'e2e';
import { reproTest } from '../support.mjs';

const test = reproTest();
test('Event rename refreshes timeline and card names', { tags: ['bugbash'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await app.open('/ideas-events?tab=events');
  await screen.getByRole('button', 'Add event', { exact: true }).tap();
  await screen.getByLabel('Event name', { exact: true }).fill('QA-Events-Edit-731');
  await screen.getByLabel('Organizer', { exact: true }).fill('Demo QA association');
  await screen.getByLabel('Starts', { exact: true }).fill('2026-11-10T09:00');
  await screen.getByLabel('Ends', { exact: true }).fill('2026-11-10T10:00');
  await screen.getByLabel('Reference', { exact: true }).fill('Synthetic QA invitation');
  await screen.getByRole('button', 'Save event', { exact: true }).tap();
  await expect(browser.locator('.event-card')).toContainText('QA-Events-Edit-731');
  await browser.locator('.event-card').tap();
  await screen.getByLabel('Event name', { exact: true }).fill('QA-Events-Edit-731-Updated');
  await screen.getByRole('button', 'Save event', { exact: true }).tap();
  await expect(browser.locator('.event-card')).toContainText('QA-Events-Edit-731-Updated');
  await expect(browser.locator('.event-timeline-node')).toHaveAttribute('aria-label', /QA-Events-Edit-731-Updated/);
  await app.screenshot('event-long-title-accessible-update');
  await browser.locator('.event-card').tap();
  await screen.getByLabel('Event name', { exact: true }).fill('QA renamed event');
  await screen.getByRole('button', 'Save event', { exact: true }).tap();
  await expect(browser.locator('.event-card .event-name')).toHaveText('QA renamed event');
  await expect(browser.locator('.event-timeline-node text').nth(0)).toHaveText('QA renamed event');
  await app.screenshot('event-short-title-visible-update');
});
