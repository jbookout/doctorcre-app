import { test, expect } from '@playwright/test';
import './privacy';
import { deal, needs, visible } from './ui';

test("16 WR39.S2", async ({ page }) => {
  await deal(page);
  const open = page.locator('[data-open-terms]');
  if (await open.isVisible()) await open.click();
  await visible(page.locator('[data-terms-list]'));
  const terms = page.locator('[data-fact-key]');
  needs(!await terms.count(), 'test deal with cited terms and conflicting or unconfirmed observations');
  const observations = terms.locator('.fact-observation');
  needs(!await observations.count(), 'test deal term with a document/page citation');
  for (let n = 0; n < Math.min(await observations.count(), 20); n++) {
    const observation = observations.nth(n);
    expect(await observation.innerText().then(text => /page/i.test(text))).toBe(true);
    expect(await observation.locator('.fact-read').count() > 0).toBe(true);
  }
  needs(true, 'source document/page viewer and independent stored-value comparison; citation presence alone is not equality');
});
