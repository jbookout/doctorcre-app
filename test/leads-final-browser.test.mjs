import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, settles } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';
import { lead, workspace } from './leads-workspace-fixture.mjs';

async function capture(page, name, measurements) {
  if (!process.env.LEADS_FINAL_DIR) return;
  await mkdir(process.env.LEADS_FINAL_DIR, { recursive: true });
  await page.screenshot({ path: `${process.env.LEADS_FINAL_DIR}/${name}.png` });
  await writeFile(`${process.env.LEADS_FINAL_DIR}/${name}.json`, JSON.stringify(measurements, null, 2));
}

test('An unclaimed New lead can be claimed on the first screen of a 45-lead board', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const board = workspace();
  board.leads = Array.from({ length: 45 }, (_, n) => lead(n + 1, {
    stage: n < 43 ? 'new' : 'qualified', owner: n === 1 ? 'example-partner' : null,
  }));
  const writes = [];
  await routeLeads(page, { getBoard: () => board, onWrite: value => writes.push(value) });
  await page.goto('http://localhost/leads');
  await page.locator('.lead-card').first().waitFor();
  const claim = page.locator('#leadBoard').getByRole('button', { name: 'Claim', exact: true }).first();
  assert.ok(await claim.count(), 'the board exposes a labelled Claim action');
  const bounds = await claim.boundingBox();
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 900, `Claim is on the first screen: ${JSON.stringify(bounds)}`);
  assert.equal(await page.locator('.lead-card').nth(1).getByRole('button', { name: 'Claim', exact: true }).count(), 0, 'owned leads cannot be claimed');
  assert.equal(await page.locator('[data-stage="qualified"] [data-claim]').count(), 0, 'Claim follows existing New-lead eligibility');
  await claim.focus();
  await page.keyboard.press('Space');
  await settles(async () => assert.equal(await page.locator('#moveAnnouncement').innerText(), 'Lead claimed'));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, 'claim-lead');
  assert.equal(writes[0].arguments.lead_id, board.leads[0].id);
  assert.equal(await page.locator('#leadDetail').evaluate(node => node.open), false);
});
