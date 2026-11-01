import assert from 'node:assert/strict';
import { test } from '@e2e-dev/web';
import { chromium, type Response } from 'playwright';

export function assertRedirectHops(responses: { url: string; status: number; headers: Record<string, string> }[]) {
  assert.ok(responses.length, 'No navigation responses recorded');
  for (const response of responses) {
    const { url, status, headers } = response;
    assert.ok(!headers['cf-mitigated'], `Cloudflare challenge at ${url}: HTTP ${status}, cf-ray ${headers['cf-ray'] ?? 'absent'}`);
    assert.ok(status >= 300 && status < 400, `Expected redirect at ${url}: HTTP ${status}, server ${headers.server ?? 'absent'}, cf-ray ${headers['cf-ray'] ?? 'absent'}`);
  }
}

test('rejects content before a later redirect', () => {
  assert.throws(() => assertRedirectHops([
    { url: 'https://example.test/deals', status: 200, headers: { 'content-type': 'text/html' } },
    { url: 'https://example.test/redirect', status: 302, headers: {} },
  ]), /Expected redirect.*HTTP 200/);
});

for (const path of ['/deals', '/leads', '/invoices', '/control-room/progress', '/doc-chats']) {
test(`${path} sends signed-out visitors to login`, async () => {
  const origin = new URL(process.env.DOCTORCRE_SMOKE_URL ?? 'https://app.doctorcre.com').origin;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/auth/login?*`, requestStage: 'Response' }] });
    let loginFailure = '';
    cdp.on('Fetch.requestPaused', async event => {
      const headers = Object.fromEntries((event.responseHeaders ?? []).map(h => [h.name.toLowerCase(), h.value]));
      const body = await cdp.send('Fetch.getResponseBody', { requestId: event.requestId }).catch(() => ({ body: '', base64Encoded: false }));
      const content = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      if ((event.responseStatusCode ?? 0) < 200 || (event.responseStatusCode ?? 0) >= 400 || headers['cf-mitigated'] || /cf-challenge|challenge-platform|just a moment/i.test(content)) {
        loginFailure = `Login challenge or refusal at ${event.request.url}: HTTP ${event.responseStatusCode}, cf-ray ${headers['cf-ray'] ?? 'absent'}`;
      }
      await cdp.send('Fetch.fulfillRequest', {
        requestId: event.requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/html' }],
        body: Buffer.from('Login').toString('base64'),
      });
    });
    {
      const responses: Response[] = [];
      const record = (response: Response) => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) responses.push(response);
      };
      page.on('response', record);
      loginFailure = '';
      try {
        await page.goto(new URL(path, origin).href);
        const hops = responses.filter(response => new URL(response.url()).pathname !== '/auth/login');
        for (const response of hops) {
          if (response.status() < 300 || response.status() >= 400) {
            const body = await response.text().catch(() => '');
            assert.ok(!/cf-challenge|challenge-platform|just a moment/i.test(body), `Cloudflare challenge at ${response.url()}: HTTP ${response.status()}, cf-ray ${response.headers()['cf-ray'] ?? 'absent'}`);
          }
        }
        assertRedirectHops(hops.map(response => ({ url: response.url(), status: response.status(), headers: response.headers() })));
        assert.equal(loginFailure, '', loginFailure);
        const target = new URL(page.url());
        assert.equal(target.origin, origin, path);
        assert.equal(target.pathname, '/auth/login', path);
        assert.equal(target.searchParams.get('return_to'), path, `${path}: unexpected return_to`);
      } finally {
        page.off('response', record);
      }
    }
  } finally {
    await browser.close();
  }
});
}
