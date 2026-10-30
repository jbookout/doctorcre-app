import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';

const outcomeTitle = 'Let partners compare every synthetic delivery outcome and understand the next action before opening the complete work record or its supporting history, including the current stage, the expected result, the documented handoff, and the evidence that each synthetic release reached its intended destination with the right verification';
const boards = Array.from({ length: 166 }, (_, i) => ({ board_id: `demo-${i}`, title: `Demo repository ${i}`, project: i === 165 ? 'Synthetic Focus' : 'Demo delivery' }));
for (const [width, height] of [[1440, 960], [390, 844]]) {
  for (const file of ['progress-board.html', 'control-room.html']) {
    test(`QA-004: 166 published boards stay bounded and keyboard reachable in ${file} at ${width}px`, async t => {
      const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] }); t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width, height } });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://board.test') return route.abort();
        const path = url.pathname === '/' || url.pathname === '/control-room/progress/board/demo-0' ? file
          : url.pathname.startsWith('/icons/') ? `public-shell${url.pathname}` : url.pathname.slice(1);
        let body = await readFile(new URL('../' + path, import.meta.url));
        if (path === file) body = Buffer.from(String(body).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''));
        await route.fulfill({ body, contentType: path.endsWith('.css') ? 'text/css' : /\.m?js$/.test(path) ? 'text/javascript' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/html' });
      });
      await page.goto(file === 'progress-board.html' ? 'http://board.test/control-room/progress/board/demo-0' : 'http://board.test/');
      await page.evaluate(async ({boards, outcomeTitle}) => {
        window.__BOARD_NO_AUTOMOUNT = true;
        const { mountBoard } = await import('/js/progress-board.js');
        window.directoryTestBoard = mountBoard({ window, document, search: '?board=demo-0', storage: null,
          client: {
            listProgressBoards: async () => {
              if (window.directoryTestFailure) throw new Error('Synthetic discovery unavailable');
              return { schema: 'progress-board-directory.v1', boards:window.directoryTestUpdated ? boards.map(board => board.board_id === 'demo-165' ? {...board,title:'Updated synthetic outcome'} : board) : boards };
            },
            readProgressBoard: async () => ({ snapshot: { board_id: 'demo-0', version: 1,
              snapshot_json: { title: 'Demo delivery', tasks: { build: { title: 'Demo task', status: 'running', updated_at: new Date().toISOString() },
                ...Object.fromEntries(Array.from({length:100}, (_,i) => [`queue-${i}`, {title:i === 0 ? outcomeTitle : `Demo queued outcome ${i}`,status:'queued'}])) } } }, questions: [] }),
          }, setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {} });
        await window.directoryTestBoard.refresh();
      }, {boards, outcomeTitle});
      await page.waitForFunction(() => document.querySelectorAll('#board-directory a').length === 166);
      if (file === 'progress-board.html') {
        assert.equal(await page.locator('#board-stages .board-card[data-stage=queued]').count(), 0, 'Active leaves queued work in its own view');
        await page.locator('[data-work-view="queue"]').click();
        assert.equal(await page.locator('#board-stages .board-card[data-stage=queued]').count(), 20);
        assert.equal(await page.locator('.stage-count').textContent(), '100');
      } else assert.equal(await page.locator('#board-stages .board-card[data-stage=queued]').count(), 100);
      const title = page.locator('[data-card-id="queue-0"] .card-title').first();
      assert.equal(await title.textContent(), outcomeTitle);
      await page.evaluate(() => document.fonts.ready);
      const clippedTitle = await title.evaluate(node => {
        const bounds = node.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(node);
        return [...range.getClientRects()].some(rect => rect.top < bounds.top - 1
          || rect.bottom > bounds.bottom + 1 || rect.left < bounds.left - 1 || rect.right > bounds.right + 1);
      });
      assert.equal(clippedTitle, false, 'the full outcome title is readable without clipping');
      const directory = page.locator('.directory-panel');
      const lanesTop = await page.locator('#board-filters').evaluate(node => node.getBoundingClientRect().top);
      if (file === 'progress-board.html') {
        assert.ok(lanesTop < height, `filters start at ${lanesTop}px, within the first screen`);
        const firstLane = await page.locator('#board-stages .column').first().boundingBox();
        assert.ok(firstLane.y < height, 'the first lane starts in the first viewport');
        await mkdir('test-artifacts/directory', {recursive:true});
        await page.screenshot({path:`test-artifacts/directory/initial-${width}.png`});
      }
      const summary = directory.locator('summary');
      if (file === 'progress-board.html') assert.equal(await directory.evaluate(node => node.open), false, 'directory starts collapsed');
      else {
        assert.equal(await directory.evaluate(node => node.open), true, 'embedded directory shows its boards on first view');
        assert.ok(await page.locator('#board-directory a').first().isVisible(), 'a board card is visible without a click');
        assert.ok(await summary.evaluate(node => getComputedStyle(node, '::before').content !== 'none'), 'the disclosure shows a marker');
        await summary.focus(); await page.keyboard.press('Space');
      }
      await summary.focus(); await page.keyboard.press('Enter');
      assert.equal(await directory.evaluate(node => node.open), true);
      const nav = page.locator('#board-directory');
      const size = await nav.evaluate(node => ({ height: node.clientHeight, content: node.scrollHeight }));
      assert.ok(size.height <= height / 2 + 1, `expanded directory is bounded: ${size.height}px`);
      assert.ok(size.content > size.height, 'all entries remain in the scroll area');
      const search = page.getByRole('searchbox', {name:'Find a board'});
      await search.click();
      assert.equal(await directory.evaluate(node => node.open), true, 'using search does not toggle the directory');
      await search.fill('Synthetic Focus');
      assert.deepEqual(await nav.locator('a:visible').evaluateAll(nodes => nodes.map(node => node.dataset.boardId)), ['demo-165']);
      await page.evaluate(() => { window.directoryTestUpdated = true; return window.directoryTestBoard.refresh(); });
      assert.match(await nav.locator('a:visible').textContent(), /Updated synthetic outcome/);
      assert.equal(await search.inputValue(), 'Synthetic Focus', 'refresh retains the search');
      assert.equal(await search.evaluate(node => node === document.activeElement), true, 'refresh retains search focus');
      await search.fill('demo-164');
      assert.deepEqual(await nav.locator('a:visible').evaluateAll(nodes => nodes.map(node => node.dataset.boardId)), ['demo-164']);
      await search.fill('Demo repository 163');
      assert.deepEqual(await nav.locator('a:visible').evaluateAll(nodes => nodes.map(node => node.dataset.boardId)), ['demo-163']);
      await search.fill('No matching synthetic project');
      assert.equal(await nav.locator('a:visible').count(), 0);
      assert.equal(await page.getByRole('status').filter({hasText:'No boards match your search.'}).isVisible(), true);
      await search.fill('');
      await page.keyboard.press('Tab');
      assert.equal(await nav.locator('a').first().evaluate(node => node === document.activeElement), true);
      if (file === 'progress-board.html' && width > 1000) {
        const layout = await page.evaluate(() => ({ directory:document.querySelector('.directory-panel').getBoundingClientRect().toJSON(), pipeline:document.querySelector('.pipeline-panel').getBoundingClientRect().toJSON(), filters:document.querySelector('#board-filters').getBoundingClientRect().toJSON() }));
        assert.ok(layout.directory.right < layout.pipeline.left, 'the directory is a left selector beside the work');
        assert.ok(layout.filters.top < height, 'opening 166 entries leaves filters in the first viewport');
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await mkdir('test-artifacts/directory', {recursive:true});
      await page.screenshot({path:`test-artifacts/directory/${file}-${width}.png`});
      await nav.locator('a').last().focus();
      const directoryScroll = await nav.evaluate(node => node.scrollTop);
      await page.evaluate(() => window.directoryTestBoard.refresh());
      assert.equal(await nav.evaluate(node => node.scrollTop), directoryScroll, 'refresh retains directory scroll');
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
