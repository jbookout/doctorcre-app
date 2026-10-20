import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { mountBoard } from '../js/progress-board.js';
import fixture from '../js/progress-work-queue-fixture.js';

test('queue order is shown directly and every job opens its exported execution detail', async () => {
  const dom = new JSDOM(readFileSync(new URL('../progress-board.html', import.meta.url), 'utf8'), {
    url: 'https://app.doctorcre.com/control-room/progress/board/carr-v5?card=WR14.S1.J1', pretendToBeVisual: true });
  let snapshot = structuredClone(fixture);
  const board = mountBoard({ window: dom.window, document: dom.window.document,
    client: { readProgressBoard: async () => ({snapshot:{version:1,snapshot_json:snapshot}}) } });
  try {
    await board.refresh();
    const doc = dom.window.document;
    const panel = doc.querySelector('[data-queue-detail="WR14.S1.J1"]');
    assert.ok(panel?.open, 'card-ID URL expands the job');
    assert.match(panel.textContent, /gpt-6.1-sol.*high/s);
    assert.match(panel.textContent, /P1.*Preserve keyboard focus.*Resolved/s);
    assert.match(panel.textContent, /P2.*Show unknown timing.*Open/s);
    assert.match(panel.textContent, /Review round.*1 of 3/s);
    assert.match(panel.textContent, /CI.*passed/s);
    assert.equal(panel.querySelector('a[data-pr]').href, 'https://github.com/jbookout/doctorcre-app/pull/317');
    assert.ok(panel.querySelector('a[data-job-log]'));
    const roots = () => [...doc.querySelector('[data-queue-root]').children].map(n => n.dataset.queueId);
    assert.deepEqual(roots(), ['WR20','WR14']);
    const button = doc.querySelector('[data-queue-detail="WR14.S1.J1"] > summary');
    button.focus();
    snapshot.work_queue.board.order.reverse();
    snapshot.work_queue.revision++;
    await board.refresh();
    assert.deepEqual(roots(), ['WR14','WR20']);
    assert.equal(doc.activeElement, button, 'same focused element survives reorder');
    assert.equal(doc.querySelector('[data-queue-detail="WR14.S1.J1"]'), panel);
    assert.ok(panel.open, 'open panel survives reorder');
    board.dispose();
    panel.open = false;
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
    assert.equal(panel.open, false, 'disposing the board releases queue history handling');
  } finally { board.dispose(); dom.window.close(); }
});
