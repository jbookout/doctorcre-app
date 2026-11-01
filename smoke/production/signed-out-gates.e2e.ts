import assert from 'node:assert/strict';
import { test } from '@e2e-dev/web';
import { chromium } from 'playwright';

test('protected pages send signed-out visitors to login', async () => {
  const origin = new URL(process.env.DOCTORCRE_SMOKE_URL ?? 'https://app.doctorcre.com').origin;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    // Stop the login response before it redirects to the identity provider.
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/auth/login?*`, requestStage: 'Response' }] });
    cdp.on('Fetch.requestPaused', event => {
      void cdp.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/html' }],
        body: Buffer.from('Login').toString('base64'),
      });
    });
    for (const path of ['/control-room/progress', '/deals', '/leads', '/invoices', '/doc-chats']) {
      await page.goto(new URL(path, origin).href);
      const target = new URL(page.url());
      assert.equal(target.origin, origin, path);
      assert.equal(target.pathname, '/auth/login', path);
      const expected = path === '/control-room/progress'
        ? [path, '/control-room/progress/board/carr-v5']
        : [path];
      assert.ok(expected.includes(target.searchParams.get('return_to') ?? ''), `${path}: unexpected return_to`);
    }
  } finally {
    await browser.close();
  }
});
