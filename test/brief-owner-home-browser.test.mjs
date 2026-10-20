import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArtifact } from '../scripts/artifact.mjs';
import { chromium, fixtureServer, animationsSettled } from './browser-harness.mjs';

let outDir, server;
before(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'doctorcre-brief-home-'));
  await buildArtifact({ root: fileURLToPath(new URL('../', import.meta.url)), outDir });
  server = await fixtureServer({ root: join(outDir, 'site') });
});
after(async () => {
  await server?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`built Home owner chips keep 44px targets at ${width}px in ${theme}`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await page.goto(server.origin + '/');
    await page.locator('#appSyncTime[datetime]').waitFor({ state: 'attached' });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    if (width === 390) await page.getByRole('button', { name: 'Today sidebar', exact: true }).click();
    await animationsSettled(page);
    const targets = await page.locator('#appTodayOwners .chip').evaluateAll(nodes => nodes.map(node => {
      const { width, height } = node.getBoundingClientRect();
      return { surface: 'Today', label: node.textContent, width, height };
    }));
    if (width === 390) await page.getByRole('button', { name: 'Close Today', exact: true }).click();
    await page.keyboard.press('Control+k');
    await page.getByRole('button', { name: /^Morning brief/ }).click();
    await page.locator('#morningOwners .chip').first().waitFor();
    await animationsSettled(page);
    targets.push(...await page.locator('#morningOwners .chip').evaluateAll(nodes => nodes.map(node => {
      const { width, height } = node.getBoundingClientRect();
      return { surface: 'Morning brief', label: node.textContent, width, height };
    })));
    t.diagnostic(JSON.stringify(targets));
    assert.equal(targets.length, 6);
    for (const target of targets) assert.ok(target.width >= 44 && target.height >= 44,
      `${target.surface} ${target.label}: ${target.width}x${target.height}`);
    assert.equal(await page.locator('#morningOwners .chip').first().evaluate(node =>
      getComputedStyle(node).borderRadius === getComputedStyle(document.documentElement).getPropertyValue('--radius-round').trim()), true);
  });
}
