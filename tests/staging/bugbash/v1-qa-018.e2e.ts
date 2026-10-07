import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { dismissBrief } from '../v1/_h.ts';

// QA-018: when Doc cannot act on a question, the feedback must say how to recover / whether anything was submitted.
test('QA-018 Ask Doc refusal explains recovery', { session: 'staging-partner', tags: ['bugbash', 'v1'] }, async ({ app, screen, browser }) => {
  await app.open('/');
  await dismissBrief(screen);
  await screen.getByRole('button', 'Open Doc').tap();
  const box = screen.getByRole('combobox', 'Search anything or ask Doc');
  await box.fill('Ask what lease clause protects a dental practice from relocation');
  await box.press('Enter');
  const status = () => browser.evaluate(() => document.getElementById('docCommandStatus')?.textContent?.trim() ?? '');
  await expect.poll(status, { message: 'Doc command status after submitting a question' }).not.toBe('');
  const text = await status();
  expect(text, 'Doc feedback after the question').toMatch(/not (sent|submitted|saved)|nothing was|try|retry|instead|search/i);
});
