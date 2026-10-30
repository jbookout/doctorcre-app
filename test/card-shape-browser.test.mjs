import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { routeLeads } from './leads-browser-fixture.mjs';
import { chromium, fixtureServer } from './browser-harness.mjs';

let server, browser;
before(async () => { server = await fixtureServer(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); await server?.close(); });
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) test(`shared cards at ${width} in ${theme}`, async t => {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } })), theme);
  for (const [surface, path, selector] of [['email', '/', '#homeEmailFollowups article'], ['brief', '/', '#homeBrief article'], ['attention', '/', '#dealFlags article'], ['call-followups', '/', '#homeCallTasks article'], ['meeting-reviews', '/', '#homeMeetingReviews article'], ['deals-board', '/deals', '.kanban-column .kanban-card'], ['deals-list', '/deals?view=list', '.deal-row'], ['parked', '/deals', '.parked-card'], ['email-deal', '/deals?deal=d01', '#panelEmailFollowups article'], ['leads', '/leads', '.lead-card'], ['leads-list', '/leads', '.filtered-list .lead-card']]) {
    if (surface.startsWith('leads')) await routeLeads(page);
    await page.goto(`${surface.startsWith('leads') ? 'http://localhost' : server.origin}${path}`);
    if (surface === 'leads-list') { await page.locator('.lead-card').first().waitFor(); await page.locator('#stageFilter').selectOption('archived'); }
    if (surface === 'parked') await page.locator('.parked-lane > summary').click();
    if (['call-followups', 'meeting-reviews'].includes(surface)) await page.locator('#homeEmailFollowups article').first().waitFor();
    if (surface === 'call-followups') await page.evaluate(async () => {
      const { mountHomeCallTasks } = await import('/js/home-call-tasks.js');
      const host = document.getElementById('homeCallTasks');
      mountHomeCallTasks({ document, client: {}, host }).update({ actor: 'joe', scope: 'mine', read: { state: 'read' }, tasks: [
        { candidateId: 'demo-card-call', kind: 'assigned_action', owner: 'joe', dealId: 'd14', dealName: 'Demo clinic', description: 'Call the lender', dueOn: '2026-10-02', evidence: 'Joe will call the lender.', createdAt: '2026-10-01T14:00:00Z' },
        { candidateId: 'demo-card-draft', kind: 'email_draft', owner: 'joe', dealId: 'd14', dealName: 'Demo clinic', subject: 'Demo lender follow-up', recipientRef: 'Demo lender', createdAt: '2026-10-01T14:00:00Z' }
      ] });
    });
    if (surface === 'meeting-reviews') await page.evaluate(async () => {
      const { mountHomeMeetingReviews } = await import('/js/home-meeting-reviews.js');
      mountHomeMeetingReviews({ document, client: {}, host: document.getElementById('homeMeetingReviews'), storage: sessionStorage }).update({ actor: 'joe', deals: [{ id: 'd14', name: 'Demo clinic', owner: 'joe' }], calendar: { follow_up_reviews: [{ key: 'aaaaaaaaaaaaaaaa', state: 'needs_review', title: 'Demo lender meeting', start: '2026-10-01T13:00:00Z', end: '2026-10-01T14:00:00Z' }] } });
    });
    await page.locator(selector).first().waitFor();
    await page.locator(selector).first().scrollIntoViewIfNeeded();
    const dir = 'out/test-artifacts/card-shape/after';
    await mkdir(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/${surface}-${width}-${theme}.png` });
    await writeFile(`${dir}/${surface}-${width}-${theme}.json`, JSON.stringify(await page.locator(selector).evaluateAll(cards => cards.map(card => ({ height: card.getBoundingClientRect().height, text: card.textContent, radius: getComputedStyle(card).borderRadius, border: getComputedStyle(card).borderWidth }))), null, 2));
    assert.equal(await page.locator(selector).first().locator('.work-card-title').count(), 1);
    assert.equal(await page.locator(selector).first().locator('.work-card-meta').count(), 1);
    const card = page.locator(selector).first();
    if (surface === 'deals-board' || surface === 'leads') {
      const style = await card.evaluate(node => { const s = getComputedStyle(node); return { radius: parseFloat(s.borderRadius), border: parseFloat(s.borderLeftWidth), background: s.backgroundColor }; });
      assert.ok(style.radius > 0 && style.border > 0 && style.background !== 'rgba(0, 0, 0, 0)', `${surface} has a tile surface`);
    }
    if (surface === 'deals-board') assert.equal(await page.locator('.kanban-card:not(.parked-card) .work-card-status').count(), 0, 'column stage is not a chip');
    if (surface === 'leads') assert.equal(await card.locator('.work-card-body').count(), 0, 'ordinary leads have no empty body');
    if (surface === 'brief') {
      assert.equal(await card.locator('.work-card-body, .work-card-status').count(), 0, 'brief dates belong in meta');
      assert.match(await card.locator('.work-card-meta').textContent(), /Due|No due date/);
      assert.ok((await card.boundingBox()).height <= 110, 'brief stays compact');
    }
    if (surface === 'deals-list' && width === 1440) {
      const title = await card.locator('.work-card-title').boundingBox();
      const stage = await card.locator('.deal-stage').boundingBox();
      const next = await card.locator('.deal-row-next').boundingBox();
      const owner = await card.locator('.work-card-meta').boundingBox();
      assert.ok(owner.x + owner.width <= width, 'owner is inside the viewport');
      assert.ok(title.x < stage.x && stage.x < next.x && next.x < owner.x, 'desktop has name, stage, next step and owner columns');
      assert.ok(Math.abs(title.y - owner.y) < 25, 'owner shares the title row');
      assert.ok((await card.boundingBox()).height <= 160, 'list rows stay compact');
    }
    if (['email', 'email-deal'].includes(surface)) assert.equal(await card.locator('.work-card-status').count(), 0, 'proposal type is not a state');

    for (const target of await page.locator(selector).first().locator('button:visible, a:visible, summary:visible, select:visible').all()) {
      const box = await target.boundingBox();
      assert.ok(box.height >= 44 && box.width >= 44, `${surface} has 44px targets`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${surface} fits`);
  }
});
