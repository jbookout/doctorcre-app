import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, fixtureServer, animationsSettled, settles } from './browser-harness.mjs';

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
    return { reachable: element === top || element.contains(top), coveredBy: top?.outerHTML.slice(0, 200), inert: Boolean(element.closest('[inert]')) };
  });
}

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`call suggestion can be read, confirmed and skipped at ${width}px in ${theme}`, async t => {
    const page = await open(t, width, theme);
    await page.screenshot({ path: join(evidence, `suggestion-${width}-${theme}.png`), animations: 'disabled' });
    const chip = page.locator('.confirm-chip');
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

  test(`review agenda is interactive in front of the workspace at ${width}px in ${theme}`, async t => {
    const page = await open(t, width, theme);
    if (width === 390) await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
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
