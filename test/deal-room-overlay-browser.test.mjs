import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, animationsSettled, settles } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';

let browser, server;
const evidence = process.env.DEAL_ROOM_OVERLAY_EVIDENCE || 'out/test-artifacts/deal-room-overlays';
before(async () => {
  await mkdir(evidence, { recursive: true });
  server = await fixtureServer();
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await server?.close(); });

async function open(t, width, theme) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
  const fixture = await readFile(new URL('../js/fixture-client.js', import.meta.url), 'utf8');
  assert.ok(fixture.includes('let pendingConfirms = [];'));
  const proposal = { id: 'overlay-suggestion', label: 'Demo next step from call', deal_id: 'd23', verb: 'set-next-step', args: { deal: 'd23', text: 'Review the sample terms' } };
  await page.route('**/js/fixture-client.js', route => route.fulfill({ contentType: 'text/javascript', body: fixture.replace('let pendingConfirms = [];', `let pendingConfirms = ${JSON.stringify([proposal])};`) }));
  await page.goto(`${server.origin}/index.html?mode=fixture`);
  await page.locator('#rows > tr').first().waitFor();
  await page.locator('.confirm-chip').waitFor();
  await animationsSettled(page);
  return page;
}

async function hit(target) {
  return target.evaluate(element => {
    const box = element.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { element: element.outerHTML.slice(0, 120), rect: { x: box.x, y: box.y, width: box.width, height: box.height }, reachable: element === top || element.contains(top), coveredBy: top?.outerHTML.slice(0, 200), inert: Boolean(element.closest('[inert]')) };
  });
}

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`call suggestion can be read, confirmed and skipped at ${width}px in ${theme}`, async t => {
    const page = await open(t, width, theme);
    await page.screenshot({ path: join(evidence, `suggestion-${width}-${theme}.png`), animations: 'disabled' });
    const chip = page.locator('.confirm-chip');
    if (width === 1440) {
      const rail = await page.locator('#appShell').boundingBox();
      const suggestion = await chip.boundingBox();
      assert.ok(suggestion.x >= rail.x + rail.width, 'suggestion text clears the workspace rail');
    }
    const center = await hit(chip);
    assert.equal(center.reachable, true, JSON.stringify(center));
    for (const action of ['Confirm', 'Skip']) {
      if (action === 'Skip') { await page.reload(); await chip.waitFor(); }
      const button = chip.getByRole('button', { name: action, exact: true });
      await button.scrollIntoViewIfNeeded();
      const target = await hit(button);
      assert.equal(target.reachable, true, JSON.stringify(target));
      await button.click();
      await settles(async () => assert.equal(await chip.count(), 0));
    }
  });

  if (width === 1440) test(`pending suggestion leaves the last deal and overdue card reachable in ${theme}`, async t => {
    const page = await open(t, width, theme);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const targets = [];
    const row = page.locator('#rows > tr').last();
    for (const selector of ['[data-owner]', '.park-button', '.row-menu']) {
      const control = row.locator(selector);
      await control.scrollIntoViewIfNeeded();
      targets.push({ control: selector, ...await hit(control) });
    }
    if (!await page.locator('.app-layout-page-tools').evaluate(node => node.open)) await page.locator('.app-layout-page-tools > summary').click();
    const sidebar = page.locator('.app-layout-page-tools');
    await sidebar.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const card = sidebar.locator('#appWorkingList [data-layout-deal]').last();
    await card.scrollIntoViewIfNeeded();
    targets.push({ control: 'last overdue card', ...await hit(card) });
    await page.screenshot({ path: join(evidence, `last-controls-${width}-${theme}.png`), animations: 'disabled' });
    assert.ok(targets.every(target => target.reachable), JSON.stringify(targets));
  });

  test(`toast leaves the pending suggestion pressable at ${width}px in ${theme}`, async t => {
    const page = await open(t, width, theme);
    await page.evaluate(async () => {
      const { showToast } = await import('/js/toast.js');
      showToast('Demo next step updated on the sample practice', { eventId: 'demo-event', error: true });
    });
    await animationsSettled(page);
    await page.screenshot({ path: join(evidence, `toast-${width}-${theme}.png`), animations: 'disabled' });
    for (const target of [page.locator('.confirm-chip'), page.locator('.confirm-chip .yes'), page.locator('.confirm-chip .skip-confirm')]) {
      await target.scrollIntoViewIfNeeded();
      const center = await hit(target);
      assert.equal(center.reachable, true, JSON.stringify(center));
    }
  });

  test(`review agenda is interactive in front of the workspace at ${width}px in ${theme}`, async t => {
    const page = await open(t, width, theme);
    await page.getByRole('button', { name: 'Review deals', exact: true }).click();
    await page.locator('#agendaPanel').waitFor();
    await animationsSettled(page);
    await page.screenshot({ path: join(evidence, `agenda-${width}-${theme}.png`), animations: 'disabled' });
    const reviewed = page.getByRole('button', { name: 'Reviewed — next', exact: true });
    const target = await hit(reviewed);
    assert.equal(target.inert, false, JSON.stringify(target));
    assert.equal(target.reachable, true, JSON.stringify(target));
    if (width === 390) assert.equal(await page.locator('#appLayout').getAttribute('data-drawer'), '');
    const progress = await page.locator('#agendaProgress').textContent();
    await reviewed.click();
    await settles(async () => assert.notEqual(await page.locator('#agendaProgress').textContent(), progress));
  });
}
