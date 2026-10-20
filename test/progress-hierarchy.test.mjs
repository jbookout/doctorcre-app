import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { hierarchyView, hierarchyUrl } from '../js/progress-hierarchy.js';
import { boardView } from '../js/progress-board-model.js';
import { mountBoard } from '../js/progress-board.js';

const hierarchy = {
  schema: 'work-request-hierarchy.v1',
  work_requests: { WR14: { id: 'WR14', card_title: 'Board cleanup', card_description: 'Make the work easier to follow.',
    status: 'active', slices: ['WR14.S1', 'WR14.S2'], counts: { done: 1, active: 1, blocked: 0, failed: 0 } } },
  slices: {
    'WR14.S1': { id: 'WR14.S1', parent_id: 'WR14', card_title: 'Board grouping', card_description: 'Group related work.', status: 'done', cards: ['WR14.S1.J1.carr#1960'], pr_counts: { done: 1 } },
    'WR14.S2': { id: 'WR14.S2', parent_id: 'WR14', card_title: 'Board navigation', card_description: 'Open the work at the right level.', status: 'active', cards: ['WR14.S2.J1.app#316'], pr_counts: { review: 1 } },
  }, aliases: { 'old-card': 'WR14.S2.J1.app#316' },
};
const tasks = {
  'WR14.S1.J1.carr#1960': { id: 'WR14.S1.J1.carr#1960', parent_id: 'WR14.S1', card_title: 'Board grouping', card_description: 'Keep related changes together.', done: true, pr: 1960, repo: 'jbookout/carr-system', merge_sha: 'a'.repeat(40) },
  'WR14.S2.J1.app#316': { id: 'WR14.S2.J1.app#316', parent_id: 'WR14.S2', card_title: 'Board navigation', card_description: 'Follow a request through its slices and changes.', status: 'review', stage: 'review', pr: 316, repo: 'jbookout/doctorcre-app' },
};
const data = { schema: 'carr-progress-board.v4', project: 'carr-v5', hierarchy, tasks };

test('default is Work Requests, then ordered slices, then only the selected slice PRs', () => {
  assert.deepEqual(hierarchyView(data).active.map(c => c.id), ['WR14']);
  const slices = hierarchyView(data, 'WR14');
  assert.deepEqual(slices.active.map(c => c.id), ['WR14.S2']);
  assert.deepEqual(slices.completed.map(c => c.id), ['WR14.S1']);
  assert.deepEqual(hierarchyView(data, 'WR14.S2').active.map(c => c.id), ['WR14.S2.J1.app#316']);
  assert.equal(hierarchyView(data, 'old-card').selected.id, 'WR14.S2.J1.app#316');
  assert.equal(hierarchyView(data, 'missing').error, 'Card not found.');
  assert.match(hierarchyUrl('carr-v5', 'WR14.S2.J1.app#316'), /WR14.S2.J1.app%23316/);
});

test('board drills down, pastes aliases, opens evidence, and Back restores the parent URL', async () => {
  const page = await readFile(new URL('../control-room.html', import.meta.url), 'utf8');
  const dom = new JSDOM(page, { url: 'https://app.doctorcre.com/progress-board' });
  const opened = [];
  const board = mountBoard({ window: dom.window, client: { readProgressBoard: async () => ({ snapshot: { board_id: 'carr-v5', version: 1, snapshot_json: data } }) },
    openTask: card => opened.push(card), setInterval: () => 0, setTimeout: () => 0, clearTimeout() {} });
  await board.refresh(true);
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('#board-stages [data-hierarchy-id]').length, 1);
  assert.equal(doc.querySelector('.headline').hidden, true);
  assert.equal(doc.querySelector('#board-ledger').closest('.panel').hidden, true);
  doc.querySelector('#hierarchy-jump input').value = 'WR14';
  await board.refresh(true);
  assert.equal(doc.querySelector('#hierarchy-jump input').value, 'WR14');
  doc.querySelector('[data-hierarchy-id="WR14"]').click();
  assert.equal(new URL(dom.window.location.href).searchParams.get('card'), 'WR14');
  assert.match(doc.querySelector('#board-stages').textContent, /Board navigation/);
  assert.equal(doc.querySelector('#task-count').textContent, '1 active · 1 completed');
  assert.ok(doc.querySelector('#hierarchy-completed details:not([open])'));
  doc.querySelector('[data-hierarchy-id="WR14.S2"]').click();
  assert.match(doc.querySelector('#board-stages').textContent, /Board navigation/);
  assert.doesNotMatch(doc.querySelector('#board-stages').textContent, /Board grouping/);
  assert.ok(doc.querySelector('#board-stages .column[data-stage=review]'));
  doc.querySelector('[data-hierarchy-id="WR14.S2.J1.app#316"]').click();
  assert.equal(opened.at(-1).id, 'WR14.S2.J1.app#316');
  doc.querySelector('#hierarchy-back').click();
  assert.equal(new URL(dom.window.location.href).searchParams.get('card'), 'WR14');
  doc.querySelector('#hierarchy-jump input').value = 'old-card';
  doc.querySelector('#hierarchy-jump').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  assert.equal(opened.at(-1).id, 'WR14.S2.J1.app#316');
  board.dispose();
});


test('unknown and prototype addresses fail safely and aliases cannot loop', () => {
  assert.equal(hierarchyView(data, 'toString').error, 'Card not found.');
  assert.equal(hierarchyView(data, '__proto__').error, 'Card not found.');
  const cyclic = structuredClone(data);
  cyclic.hierarchy.aliases = { a: 'b', b: 'a' };
  assert.equal(hierarchyView(cyclic, 'a').error, 'Card not found.');
});

test('exact published cards take precedence at every step of an alias chain', () => {
  const snapshot = structuredClone(data);
  const id = 'WR14.S2.J1.app#316';
  snapshot.hierarchy.aliases = { original: 'previous', previous: id, [id]: 'missing' };
  for (const address of [id, 'previous', 'original']) {
    assert.equal(hierarchyView(snapshot, address).selected?.id, id);
  }
});


test('an incomplete hierarchy contract shows an error rather than a broken board', () => {
  const view = boardView({snapshot:{version:1, snapshot_json:{schema:'carr-progress-board.v4',tasks:{}}}});
  assert.match(view.error, /Work Request hierarchy/);
});


test('legacy receipts stay in expandable History without becoming completed proof', () => {
  const archived = structuredClone(data);
  archived.tasks['WR14.S2.J1.app#316'].archived = true;
  const view = hierarchyView(archived, 'WR14.S2');
  assert.equal(view.active.length, 0);
  assert.equal(view.completed.length, 0);
  assert.equal(view.history[0].id, 'WR14.S2.J1.app#316');
});

for (const status of [401, 403]) test(`denied hierarchy read ${status} cannot be restored by history and identical recovery renders`, async () => {
  const page = await readFile(new URL('../control-room.html', import.meta.url), 'utf8');
  const dom = new JSDOM(page, { url: 'https://app.doctorcre.com/control-room/progress/board/carr-v5' });
  let denied = false;
  const board = mountBoard({ window: dom.window, client: { readProgressBoard: async () => {
    if (denied) throw Object.assign(new Error('Denied'), {status});
    return {snapshot: {board_id:'carr-v5', version:1, snapshot_json:data}};
  } }, setInterval: () => 0, setTimeout: () => 0, clearTimeout() {} });
  try {
    await board.refresh(true);
    const doc = dom.window.document;
    assert.equal(doc.querySelectorAll('[data-hierarchy-id]').length, 1);
    denied = true;
    await assert.rejects(board.refresh(true), {status});
    assert.equal(doc.querySelectorAll('[data-hierarchy-id]').length, 0);
    dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate'));
    assert.equal(doc.querySelectorAll('[data-hierarchy-id]').length, 0);
    denied = false;
    await board.refresh(true);
    assert.equal(doc.querySelectorAll('[data-hierarchy-id]').length, 1);
  } finally { board.dispose(); dom.window.close(); }
});

test('browser history opens the selected job detail in both directions', async () => {
  const page = await readFile(new URL('../control-room.html', import.meta.url), 'utf8');
  const dom = new JSDOM(page, {url:'https://app.doctorcre.com/control-room/progress/board/carr-v5'});
  const opened = [];
  const board = mountBoard({window:dom.window, client:{readProgressBoard:async()=>({snapshot:{version:1,snapshot_json:data}})},
    openTask:card=>opened.push(card.id), setInterval:()=>0, setTimeout:()=>0, clearTimeout(){}});
  try {
    await board.refresh(true);
    const jump = id => {
      dom.window.document.querySelector('#hierarchy-jump input').value = id;
      dom.window.document.querySelector('#hierarchy-jump').dispatchEvent(new dom.window.Event('submit', {cancelable:true}));
    };
    jump('WR14.S1.J1.carr#1960');
    jump('WR14.S2.J1.app#316');
    const history = async direction => {
      const popped = new Promise(resolve=>dom.window.addEventListener('popstate',resolve,{once:true}));
      dom.window.history[direction]();
      await popped;
    };
    await history('back');
    assert.equal(opened.at(-1), 'WR14.S1.J1.carr#1960');
    await history('forward');
    assert.equal(opened.at(-1), 'WR14.S2.J1.app#316');
  } finally {board.dispose(); dom.window.close();}
});
