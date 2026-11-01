import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, pausedClock, webkitSkipReason } from './browser-harness.mjs';

test('WebKit skips macOS 27 and newer without disabling Linux CI or older Macs', () => {
  for (const version of ['27.0.1', '28.0']) {
    assert.match(webkitSkipReason('darwin', version), /Playwright 1\.63\.0.*webkit-2359.*_WKBrowserContext/);
    assert.match(webkitSkipReason('darwin', version), /Do not.*install.*webkit/);
  }
  assert.equal(webkitSkipReason('darwin', '26.5.1'), false);
  assert.equal(webkitSkipReason('darwin', '15.7'), false);
  assert.equal(webkitSkipReason('linux', '27.0'), false);
  assert.equal(webkitSkipReason('win32', '27.0'), false);
});

test('launches share one Chromium while each test keeps its own storage', async () => {
  const [a, b] = await Promise.all([chromium.launch(), chromium.launch()]);
  const [pageA, pageB] = await Promise.all([a.newPage(), b.newPage()]);
  await Promise.all([pageA, pageB].map(page => page.setContent('<title>x</title>')));
  assert.equal(pageA.context().browser(), pageB.context().browser());
  assert.notEqual(pageA.context(), pageB.context());
  await a.close();
  assert.equal(pageA.isClosed(), true);
  assert.equal(await pageB.evaluate(() => 1 + 1), 2);
  await b.close();
});

test('the after-hook closes successful browsers even when a cached launch rejected', async () => {
  const harness = new URL('./browser-harness.mjs', import.meta.url).href;
  const script = `
    import { after, test } from 'node:test';
    import assert from 'node:assert/strict';
    import { chromium } from ${JSON.stringify(harness)};
    let underlying;
    test('failed then successful launch', async () => {
      await assert.rejects(chromium.launch({ executablePath: '/__review_missing_chromium__' }));
      const lease = await chromium.launch();
      underlying = (await lease.newPage()).context().browser();
      await lease.close();
      assert.equal(underlying.isConnected(), true);
    });
    after(async () => {
      const connected = underlying.isConnected();
      await underlying.close(); // Clean up even when the harness regresses.
      assert.equal(connected, false, 'the harness after-hook must close the successful browser');
    });
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], { timeout: 30_000 });
});

test('a page loaded after pausedClock runs no timer until the test moves the clock', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('http://127.0.0.1:9/paused', route => route.fulfill({ contentType: 'text/html', body: '<script>setTimeout(() => { window.fired = true; }, 0)</script>' }));
    await pausedClock(page, Date.parse('2026-10-01T15:00:00Z'));
    await page.goto('http://127.0.0.1:9/paused');
    await delay(300);
    assert.equal(await page.evaluate(() => window.fired), undefined, 'a due timer waits for the paused clock');
    await page.clock.runFor(1);
    assert.equal(await page.evaluate(() => window.fired), true);
  } finally { await browser.close(); }
});
