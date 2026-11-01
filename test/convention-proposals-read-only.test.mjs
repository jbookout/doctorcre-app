import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountBoard } from '../js/progress-board.js';
import { createFixtureClient } from '../js/fixture-client.js';

const html = await readFile(new URL('../control-room.html', import.meta.url), 'utf8');
const seed = await readFile(new URL('../data/board-seed.json', import.meta.url), 'utf8');

// Agents adopt and retire rules themselves and tell Joe (WR-000631): the
// Approvals tab shows pending proposals and offers Joe nothing to approve.
test('pending convention proposals are listed read-only, with no adopt control', async t => {
  const client = await createFixtureClient({ seedUrl: `data:application/json;base64,${Buffer.from(seed).toString('base64')}`, docContext: false });
  const dom = new JSDOM(html, { url: 'https://example.test/control-room?tab=approvals' });
  const board = mountBoard({ client, window: dom.window, document: dom.window.document, storage: null,
    setInterval: () => 0, setTimeout: () => 0 });
  t.after(() => { board.dispose(); dom.window.close(); });
  const queue = await client.governanceQueue();
  board.setGovernance(queue);
  const cards = dom.window.document.querySelectorAll('[data-convention]');
  assert.equal(cards.length, queue.pending_convention_proposals.length);
  assert.ok(cards.length > 0);
  for (const [index, row] of queue.pending_convention_proposals.entries()) {
    assert.equal(cards[index].querySelector('h3').textContent, row.section_key.split('/').at(-1));
    assert.equal(cards[index].querySelector('.convention-body').textContent, row.statement);
    assert.equal(cards[index].querySelector('form, button, textarea'), null);
  }
  assert.equal('adoptRule' in client, false);
});
