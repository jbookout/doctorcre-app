import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { uiAssets } from '../scripts/ui-bundle.mjs';
import { chromium } from './browser-harness.mjs';
import { observeRefresh } from '../scripts/prove-home-fact-review-refresh-selection.mjs';

const root = process.cwd();
const assets = await uiAssets(path => readFile(resolve(root, path), 'utf8'));
for (const mode of ['retained', 'removed', 'replaced', 'empty', 'forbidden', 'no-choice', 'schedule', 'correct-empty', 'correct-retained', 'reload-failure', 'uncertain', 'disposed']) {
  test(`fact refresh ${mode} reconciles visible choices and submitted request`, async t => {
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage();
    const origin = 'http://localhost:37891';
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/inbox') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="homeRoot" data-inbox></main><script type="module" src="/js/ui-inbox.generated.js"></script>' });
      if (url.pathname === '/__disposed-proof') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Disposed</title>' });
      const path = resolve(root, '.' + decodeURIComponent(url.pathname));
      if (!path.startsWith(root + sep)) return route.abort();
      const body = assets.get(url.pathname.slice(1)) || await readFile(path).catch(() => null);
      if (!body || !url.pathname.startsWith('/js/')) return route.abort();
      return route.fulfill({ contentType: 'text/javascript', body });
    });
    await observeRefresh(page, origin, mode);
  });
}
