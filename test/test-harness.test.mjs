import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from './browser-harness.mjs';

test('launches share one Chromium while each test keeps its own storage', async () => {
  const [a, b] = await Promise.all([chromium.launch(), chromium.launch()]);
  const [pageA, pageB] = await Promise.all([a.newPage(), b.newPage()]);
  await Promise.all([pageA, pageB].map(page => page.goto('data:text/html,<title>x</title>')));
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
