import { expect } from 'e2e';
import { reproTest, paintedText } from '../support.mjs';

const test = reproTest();
test('Phone Chats exposure heading text remains inside viewport clipping boundaries', { tags: ['verification'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open('/doc-chats?mode=live');
  await screen.getByRole('button', 'Dismiss morning brief', { exact: true }).tap();
  await screen.getByRole('heading', 'What this page shows a passer-by', { exact: true }).scrollIntoView();
  await app.screenshot('qa-032-phone-heading-clipped');
  const painted = await paintedText(browser, '#exposureTitle');
  expect(painted.full, JSON.stringify(painted)).toBe(true);
});
