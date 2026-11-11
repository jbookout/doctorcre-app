import test from 'node:test';
import assert from 'node:assert/strict';
import { relativeAge, sourceTime, waitingDays } from '../js/email-source-line.js';

test('ages cover minutes, hours, days and missing or future timestamps', () => {
  const now = new Date('2026-10-01T15:00:00Z');
  assert.equal(relativeAge('2026-10-01T14:58:00Z', now), '2m ago');
  assert.equal(relativeAge('2026-10-01T13:00:00Z', now), '2h ago');
  assert.equal(relativeAge('2026-09-29T15:00:00Z', now), '2d ago');
  assert.equal(relativeAge('2026-10-02T15:00:00Z', now), 'just now');
  assert.equal(relativeAge('bad timestamp', now), 'time unavailable');
});

test('absolute source time uses Chicago and includes its timezone and omits the current year', () => {
  const now = new Date('2026-10-01T15:00:00Z');
  assert.equal(sourceTime('2026-10-01T13:00:00Z', now), 'Oct 1, 8:00 AM CDT');
  assert.equal(sourceTime('2025-10-01T13:00:00Z', now), 'Oct 1, 2025, 8:00 AM CDT');
  assert.equal(sourceTime(null, now), 'Time unavailable');
});

test('waiting age counts complete days without negative or invented ages', () => {
  const now = new Date('2026-10-01T15:00:00Z');
  assert.equal(waitingDays('2026-10-01T12:00:00Z', now), '0 days waiting');
  assert.equal(waitingDays('2026-09-30T12:00:00Z', now), '1 day waiting');
  assert.equal(waitingDays('2026-09-28T15:00:00Z', now), '3 days waiting');
  assert.equal(waitingDays('2026-10-02T15:00:00Z', now), '0 days waiting');
  assert.equal(waitingDays(null, now), 'Waiting time unavailable');
});

const clock = new Date('2026-03-10T12:00:00Z');
test('invalid activity timestamps never invent source time or elapsed days', () => {
  for (const value of ['2026-02-31T12:00:00Z', '2025-02-29T12:00:00Z', '1900-02-29T12:00:00Z', '2026-04-31T12:00:00Z',
    '2026-00-01T12:00:00Z', '2026-13-01T12:00:00Z', '2026-01-00T12:00:00Z', '2026-01-01T24:00:00Z',
    '2026-01-01T12:60:00Z', '2026-01-01T12:00:60Z', '2026-01-01T12:00:00+24:00', '2026-01-01T12:00:00+01:60',
    '12:00:00Z', '2026-03-01', '2026-03-01T12:00:00', '2026-03-01T12:00Z', '2026-03-01T12:00:00Z\n',
    1, 0, NaN, Infinity, new Date('2026-03-01'), {}, true]) {
    assert.equal(sourceTime(value, clock), 'Time unavailable', String(value));
    assert.equal(relativeAge(value, clock), 'time unavailable', String(value));
    assert.equal(waitingDays(value, clock), 'Waiting time unavailable', String(value));
  }
});
test('missing source preserves default and caller-specific unavailable labels', () => {
  for (const value of [null, undefined, '']) {
    assert.equal(sourceTime(value, clock), 'Time unavailable');
    assert.equal(sourceTime(value, clock, 'Not recorded'), 'Not recorded');
    assert.equal(relativeAge(value, clock), 'time unavailable');
    assert.equal(waitingDays(value, clock), 'Waiting time unavailable');
  }
});
test('valid leap days offsets and fractional seconds preserve Chicago and elapsed labels', () => {
  const now = new Date('2024-03-01T12:00:00Z');
  for (const value of ['2024-02-29T12:00:00Z', '2024-02-29T06:00:00-06:00', '2024-02-29T17:30:00+05:30', '2024-02-29T12:00:00.000000Z']) {
    assert.equal(sourceTime(value, now), 'Feb 29, 6:00 AM CST');
    assert.equal(relativeAge(value, now), '1d ago');
    assert.equal(waitingDays(value, now), '1 day waiting');
  }
  assert.equal(relativeAge('2024-02-29T12:00:00.123456Z', now), '23h ago');
  assert.equal(waitingDays('2024-02-29T12:00:00.123456Z', now), '0 days waiting');
  assert.equal(sourceTime('2000-02-29T12:00:00Z', now), 'Feb 29, 2000, 6:00 AM CST');
  assert.equal(relativeAge('2026-03-11T12:00:00Z', clock), 'just now');
  assert.equal(waitingDays('2026-03-11T12:00:00Z', clock), '0 days waiting');
});

test('email source unavailable labels retain keyboard retry at phone and desktop widths', async t => {
  const { chromium } = await import('./browser-harness.mjs');
  const { ownedFixtureServer: fixtureServer } = await import('./fixture-probe.ts');
  const { buildArtifact } = await import('../scripts/artifact.mjs');
  const { temporaryDirectory } = await import('../scripts/temp-directory.mjs');
  const { rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const outDir = await temporaryDirectory('email-clock-');
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root: fileURLToPath(new URL('../', import.meta.url)), outDir });
  const server = await fixtureServer({ root: join(outDir, 'site') });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.goto(server.origin + '/review-workflows?mode=fixture');
    await page.evaluate(async () => {
      const { createClient } = await import('/js/client.js');
      const { mountEmailFollowups } = await import('/js/email-followups.js');
      const client = await createClient('fixture');
      const read = client.listEmailProposals.bind(client);
      let fail = true;
      client.listEmailProposals = async args => {
        if (fail) { fail = false; throw Error('Synthetic unavailable'); }
        const result = await read(args);
        for (const row of result.proposals) row.source.occurred_at = '2026-02-31T12:00:00Z';
        return result;
      };
      const host = document.createElement('section');
      host.id = 'clock-proof';
      document.body.prepend(host);
      window.clockProof = mountEmailFollowups({ container: host, client });
      await window.clockProof.refresh();
    });
    const host = page.locator('#clock-proof');
    const retry = host.getByRole('button', { name: 'Retry email follow-ups', exact: true });
    await retry.waitFor();
    await retry.focus();
    assert.equal(await retry.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    await host.locator('.email-source').first().waitFor();
    assert.match(await host.locator('.email-source').first().innerText(), /Time unavailable · Waiting time unavailable/);
    assert.equal(await host.locator('.email-source').first().getAttribute('title'), 'Time unavailable');
    await page.evaluate(() => window.clockProof.dispose());
    await page.close();
  }
});
