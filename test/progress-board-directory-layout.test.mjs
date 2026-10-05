import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';

const boards = Array.from({ length: 166 }, (_, i) => ({ board_id: `demo-${i}`, title: `Demo repository ${i}` }));
for (const [width, height] of [[1440, 960], [390, 844]]) {
  for (const file of ['progress-board.html', 'control-room.html']) {
    test(`QA-004: 166 published boards stay bounded and keyboard reachable in ${file} at ${width}px`, async t => {
      const browser = await chromium.launch(); t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width, height } });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://board.test') return route.abort();
        const path = url.pathname === '/' ? file : url.pathname.slice(1);
        let body = await readFile(new URL('../' + path, import.meta.url));
        if (path === file) body = Buffer.from(String(body).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''));
        await route.fulfill({ body, contentType: path.endsWith('.css') ? 'text/css' : /\.m?js$/.test(path) ? 'text/javascript' : 'text/html' });
      });
      await page.goto('http://board.test/');
      await page.evaluate(async boards => {
        window.__BOARD_NO_AUTOMOUNT = true;
        const { mountBoard } = await import('/js/progress-board.js');
        window.directoryTestBoard = mountBoard({ window, document, search: '?board=demo-0', storage: null,
          client: {
            listProgressBoards: async () => {
              if (window.directoryTestFailure) throw new Error('Synthetic discovery unavailable');
              return { schema: 'progress-board-directory.v1', boards };
            },
            readProgressBoard: async () => ({ snapshot: { board_id: 'demo-0', version: 1,
              snapshot_json: { title: 'Demo delivery', tasks: { build: { title: 'Demo task', status: 'running' } } } }, questions: [] }),
          }, setInterval: () => 0 });
        await window.directoryTestBoard.refresh();
      }, boards);
      await page.waitForFunction(() => document.querySelectorAll('#board-directory a').length === 166);
      const directory = page.locator('.directory-panel');
      const lanesTop = await page.locator('#board-filters').evaluate(node => node.getBoundingClientRect().top);
      if (file === 'progress-board.html') assert.ok(lanesTop < height, `filters start at ${lanesTop}px, within the first screen`);
      else assert.ok(await directory.evaluate(node => node.getBoundingClientRect().height) < 150, 'embedded directory remains a compact sidebar control');
      assert.equal(await directory.evaluate(node => node.open), false, 'directory starts collapsed');
      const summary = directory.locator('summary');
      await summary.focus(); await page.keyboard.press('Enter');
      assert.equal(await directory.evaluate(node => node.open), true);
      const nav = page.locator('#board-directory');
      const size = await nav.evaluate(node => ({ height: node.clientHeight, content: node.scrollHeight }));
      assert.ok(size.height <= height / 2 + 1, `expanded directory is bounded: ${size.height}px`);
      assert.ok(size.content > size.height, 'all entries remain in the scroll area');
      await page.keyboard.press('Tab');
      assert.equal(await nav.locator('a').first().evaluate(node => node === document.activeElement), true);
      await nav.locator('a').last().focus();
      const lastVisible = await nav.locator('a').last().evaluate(node => {
        const box = node.getBoundingClientRect(), frame = node.parentElement.getBoundingClientRect();
        return box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1;
      });
      assert.equal(lastVisible, true, 'keyboard focus scrolls the final entry into view');
      await summary.focus(); await page.keyboard.press('Space');
      assert.equal(await directory.evaluate(node => node.open), false);
      assert.equal(await summary.evaluate(node => node === document.activeElement), true);
      await page.evaluate(() => window.directoryTestBoard.refresh());
      assert.equal(await directory.evaluate(node => node.open), false, 'refresh preserves disclosure state');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await summary.press('Enter');
      assert.equal(await nav.isVisible(), true, 'reduced motion keeps every entry available');
      await summary.press('Space');
      await page.evaluate(async () => {
        window.directoryTestFailure = true;
        await window.directoryTestBoard.refresh();
      });
      assert.equal(await directory.evaluate(node => node.open), false);
      assert.equal(await page.locator('#directory-error').isVisible(), true, 'discovery failure remains visible while collapsed');
    });
  }
}
