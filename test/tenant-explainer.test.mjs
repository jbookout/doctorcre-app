import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, fixtureServer, pausedClock } from './browser-harness.mjs';

test('tenant explainer plays, pauses, completes and replays its editable story', async () => {
  const server = await fixtureServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await pausedClock(page, 1000);
    await page.goto(`${server.origin}/outreach/tenant-representation/index.html`);
    assert.equal(await page.getByRole('heading', { name: 'Your practice needs space.' }).isVisible(), true);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.clock.runFor(8100);
    assert.equal(await page.getByRole('heading', { name: 'Who works for you?' }).isVisible(), true);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.clock.runFor(16000);
    assert.equal(await page.getByRole('heading', { name: 'Who works for you?' }).isVisible(), true);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.clock.runFor(42000);
    assert.equal(await page.getByRole('heading', { name: 'Before you sign, ask.' }).isVisible(), true);
    await page.getByRole('button', { name: 'Replay', exact: true }).click();
    assert.equal(await page.getByRole('heading', { name: 'Your practice needs space.' }).isVisible(), true);
    await mkdir('test-artifacts/tenant-explainer', { recursive: true });
    await page.screenshot({ path: 'test-artifacts/tenant-explainer/desktop.png', fullPage: true });
  } finally { await browser.close(); await server.close(); }
});

test('reduced motion exposes the full sourced story on a phone and stops active playback', async () => {
  const server = await fixtureServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await pausedClock(page, 1000);
    await page.goto(`${server.origin}/outreach/tenant-representation/index.html`);
    assert.equal(await page.getByRole('heading').count(), 6);
    assert.equal(await page.getByRole('button', { name: 'Play', exact: true }).count(), 0);
    for (const heading of await page.getByRole('heading').all()) assert.equal(await heading.isVisible(), true);
    assert.ok(await page.getByRole('link', { name: /CARR tenant representation/ }).count() > 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length), 0);
    await mkdir('test-artifacts/tenant-explainer', { recursive: true });
    await page.screenshot({ path: 'test-artifacts/tenant-explainer/phone-reduced.png', fullPage: true });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.clock.runFor(8100);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Pause', exact: true }).waitFor({ state: 'hidden' });
    await page.clock.runFor(16000);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByRole('button', { name: 'Play', exact: true }).waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('heading', { name: 'Who works for you?' }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Play', exact: true }).evaluate(button => button.getBoundingClientRect().height >= 44), true);
    await page.screenshot({ path: 'test-artifacts/tenant-explainer/phone.png', fullPage: true });
  } finally { await browser.close(); await server.close(); }
});
