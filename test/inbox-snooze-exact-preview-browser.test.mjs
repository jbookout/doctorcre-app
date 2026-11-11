import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildArtifact } from '../scripts/artifact.mjs';
import { temporaryDirectory } from '../scripts/temp-directory.mjs';
import { chromium } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';
import { installFixture, observe, opening } from '../scripts/prove-inbox-snooze-exact-preview.mjs';
let out;
before(async () => { out = await temporaryDirectory('snooze-preview-'); await buildArtifact({ root: process.cwd(), outDir: out }); });
after(async () => { if (out) await rm(out, { recursive: true, force: true }); });
async function open(t, { width = 390, theme = 'light', time = opening, uncertain = false, path = '/inbox', invalid = false } = {}) {
  const server = await fixtureServer({ root: join(out, 'site') }); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: 'Asia/Tokyo', colorScheme: theme });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true } })), theme);
  const calls = await installFixture(page, { time, uncertain, invalid });
  await page.goto(`${server.origin}${path}?mode=live`);
  if (!invalid) await page.getByRole('button', { name: 'Snooze', exact: true }).first().waitFor();
  return { page, calls };
}
for (const width of [390, 1280]) for (const theme of ['light', 'dark']) test(`fixed Central preview cancel focus ${width} ${theme}`, async t => {
  const { page, calls } = await open(t, { width, theme });
  await observe(page);
  assert.equal(calls.filter(call => call.name === 'snooze-home-inbox').length, 0);
});
for (const time of [opening, '2026-03-08T07:30:00.000Z']) test(`delayed click sends stored endpoint across DST ${time}`, async t => {
  const { page, calls } = await open(t, { time });
  await page.getByRole('button', { name: 'Snooze', exact: true }).click();
  const endpoints = await page.getByRole('dialog', { name: 'Snooze cards' }).locator('time').evaluateAll(nodes => nodes.map(node => node.dateTime));
  assert.deepEqual(endpoints, [1, 24].map(hours => new Date(Date.parse(time) + hours * 3600000).toISOString()));
  assert.match(await page.getByRole('dialog', { name: 'Snooze cards' }).innerText(), time === opening ? /CST/ : /CDT/);
  await page.clock.setFixedTime(new Date(Date.parse(time) + 30000));
  await page.getByRole('button', { name: /^24 hours/ }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
  assert.equal(calls.find(call => call.name === 'snooze-home-inbox').args.until, endpoints[1]);
});
test('expired choice refuses, Escape restores focus and reopening renews choices', async t => {
  const { page, calls } = await open(t);
  const opener = page.getByRole('button', { name: 'Snooze', exact: true });
  await opener.click();
  await page.clock.setFixedTime(new Date(Date.parse(opening) + 3600000));
  await page.getByRole('button', { name: /^1 hour/ }).click();
  await page.getByRole('dialog').getByRole('alert').waitFor();
  assert.equal(calls.filter(call => call.name === 'snooze-home-inbox').length, 0);
  await page.keyboard.press('Escape');
  assert.equal(await opener.evaluate(node => node === document.activeElement), true);
  await opener.click();
  assert.equal(await page.getByRole('dialog', { name: 'Snooze cards' }).locator('time').first().getAttribute('datetime'), '2026-11-01T08:30:00.000Z');
});
test('uncertain retry retains the exact command and offline never replays', async t => {
  const { page, calls } = await open(t, { uncertain: true });
  await page.getByRole('button', { name: 'Snooze', exact: true }).click();
  const until = await page.getByRole('dialog', { name: 'Snooze cards' }).locator('time').first().getAttribute('datetime');
  await page.getByRole('button', { name: /^1 hour/ }).click();
  await page.getByRole('button', { name: 'Retry same request' }).click();
  await page.getByText('Result uncertain.', { exact: false }).first().waitFor();
  const writes = calls.filter(call => call.name === 'snooze-home-inbox');
  assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]); assert.equal(writes[0].args.until, until);
  await page.context().setOffline(true);
  await page.getByText('Offline ·', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Retry same request' }).isDisabled(), true);
  assert.equal(calls.filter(call => call.name === 'snooze-home-inbox').length, 2);
});
test('bulk and swipe entry freeze choices; refresh retains them; invalidation disposes dialog', async t => {
  const { page, calls } = await open(t);
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: 'Snooze selected' }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('[data-inbox-row]').first().evaluate(node => {
    const touch = x => new Touch({ identifier: 1, target: node, clientX: x, clientY: 100 });
    node.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(250)] }));
    node.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [touch(50)] }));
  });
  const before = await page.getByRole('dialog', { name: 'Snooze cards' }).innerText();
  await page.clock.setFixedTime(new Date(Date.parse(opening) + 30000));
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  assert.equal(await page.getByRole('dialog', { name: 'Snooze cards' }).innerText(), before);
  await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(calls.filter(call => call.name === 'snooze-home-inbox').length, 0);
});

test('Home row opens the same fixed preview', async t => {
  const { page } = await open(t, { path: '/' });
  await observe(page);
});
test('malformed v5 response is refused by the production parser', async t => {
  const { page, calls } = await open(t, { invalid: true });
  await page.getByRole('alert').filter({ hasText: 'Inbox unavailable' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Snooze', exact: true }).count(), 0);
  assert.equal(calls.filter(call => call.name === 'snooze-home-inbox').length, 0);
});

test('offline selection sends nothing and session invalidation clears pending retry', async t => {
  const { page, calls } = await open(t);
  await page.getByRole('button', { name: 'Snooze', exact: true }).click();
  await page.context().setOffline(true);
  await page.getByRole('button', { name: /^1 hour/ }).click();
  await page.getByText('Offline. No change was sent.', { exact: false }).waitFor();
  assert.equal(calls.filter(call => call.name === 'snooze-home-inbox').length, 0);
  await page.evaluate(() => dispatchEvent(new Event('doctorcre-session-invalidated')));
  assert.equal(await page.getByRole('button', { name: 'Retry same request' }).count(), 0);
});
