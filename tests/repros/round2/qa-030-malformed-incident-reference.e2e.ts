import { expect } from 'e2e';
import { reproTest } from '../support.mjs';
import { REF_REFUSAL } from '../../../js/incidents-model.js';

const test = reproTest();
test('QA-030 malformed incident reference names the refusal and retains the open list', { tags: ['bugbash'], requires: ['browser'], retries: 0 }, async ({ app, browser, screen }) => {
  await app.open('/incidents?mode=live');
  await screen.getByRole('button', 'Dismiss morning brief', { exact: true }).tap();
  await expect(screen.getByRole('heading', 'Open incidents', { exact: true })).toBeVisible();
  await app.open('/incidents?mode=live&ref=QA-MISSING-INC-001');
  await expect(browser).toHaveURL('/incidents?mode=live&ref=QA-MISSING-INC-001');
  await expect(screen.getByRole('heading', 'Open incidents', { exact: true })).toBeVisible();
  await app.screenshot('qa-030-malformed-reference-shows-ordinary-overview');
  await expect(screen.getByText(REF_REFUSAL, { exact: true })).toBeVisible();
});
