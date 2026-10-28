import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium, fixtureServer} from './browser-harness.mjs';

async function open(t, width) {
  const server = await fixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({viewport: {width, height: 900}});
  await page.route('**/dialog-test', route => route.fulfill({contentType: 'text/html', body: `
    <button id="first">First record</button><button id="second">Second record</button>
    <dialog id="jobDialog"><h2 id="jobTitle"></h2><div id="jobBody"></div><button id="jobClose">Close</button></dialog>`}));
  await page.goto(server.origin + '/dialog-test');
  return page;
}

for (const width of [390, 1440]) {
  for (const kind of ['job', 'relationship']) {
    test(`${kind} preserves a reopened selection through native close, then truly closes at ${width}px`, async t => {
      const page = await open(t, width);
      const result = await page.evaluate(async kind => {
        let detail, dialog, rows;
        if (kind === 'job') {
          const {mountJobDetail} = await import('/js/job-detail.js');
          detail = mountJobDetail({document, client: {}});
          dialog = document.getElementById('jobDialog');
          rows = [{id: 'a', title: 'Synthetic first'}, {id: 'b', title: 'Synthetic second'}];
        } else {
          const {mountRelationshipDialog} = await import('/js/relationship-dialog.js');
          detail = mountRelationshipDialog({document});
          dialog = document.querySelector('.relationship-dialog');
          rows = [{id: 'a', name: 'Synthetic first', kind: 'person', verticals: []}, {id: 'b', name: 'Synthetic second', kind: 'person', verticals: []}];
        }
        const snapshot = () => ({nodes: rows, edges: [], referrals: []});
        const show = index => kind === 'job' ? detail.open(rows[index]) : detail.open(snapshot(), rows[index].id);
        document.getElementById('first').focus(); show(0);
        const staleClose = new Promise(resolve => dialog.addEventListener('close', event => resolve({trusted: event.isTrusted, open: dialog.open}), {once: true}));
        dialog.close();
        document.getElementById('second').focus(); show(1);
        const stale = await staleClose;
        const focusInside = dialog.contains(document.activeElement);
        rows[1] = {...rows[1], title: 'Synthetic updated', name: 'Synthetic updated'};
        detail.update(kind === 'job' ? rows : snapshot());
        const reopened = {open: dialog.open, text: dialog.textContent, focusInside};
        const trueClose = new Promise(resolve => dialog.addEventListener('close', event => resolve(event.isTrusted), {once: true}));
        dialog.close();
        const trusted = await trueClose;
        return {stale, reopened, closed: !dialog.open, trusted, focus: document.activeElement.id};
      }, kind);
      assert.deepEqual(result.stale, {trusted: true, open: true});
      assert.equal(result.reopened.open, true);
      assert.match(result.reopened.text, /Synthetic updated/);
      assert.equal(result.reopened.focusInside, true);
      assert.equal(result.closed, true);
      assert.equal(result.trusted, true);
      assert.equal(result.focus, 'second');
    });
  }
}

test('shared close cleanup runs only for true native closes and can be disposed', async t => {
  const page = await open(t, 1440);
  const result = await page.evaluate(async () => {
    const {onDialogClosed} = await import('/js/dialog-lifecycle.js');
    const dialog = document.getElementById('jobDialog'), trigger = document.getElementById('second');
    let selected = 'first', cleanups = 0;
    const dispose = onDialogClosed(dialog, () => { selected = null; ++cleanups; trigger.focus(); });
    const closed = () => new Promise(resolve => dialog.addEventListener('close', event => resolve(event.isTrusted), {once: true}));
    dialog.showModal();
    const stale = closed(); dialog.close(); dialog.showModal(); selected = 'second'; await stale;
    const reopened = {selected, cleanups, open: dialog.open};
    const actual = closed(); dialog.close(); const trusted = await actual;
    const trueClose = {selected, cleanups, open: dialog.open, focus: document.activeElement.id, trusted};
    dispose();
    dialog.showModal(); const disposed = closed(); dialog.close(); await disposed;
    return {reopened, trueClose, afterDispose: cleanups};
  });
  assert.deepEqual(result.reopened, {selected: 'second', cleanups: 0, open: true});
  assert.deepEqual(result.trueClose, {selected: null, cleanups: 1, open: false, focus: 'second', trusted: true});
  assert.equal(result.afterDispose, 1);
});

for (const width of [390, 1440]) {
  test(`Tour Planner preserves a reopened tour and its pending read through native close at ${width}px`, async t => {
    const page = await open(t, width);
    await page.evaluate(async () => {
      const {mountPlanner} = await import('/tours/planner.js');
      const html = await (await fetch('/tours/index.html')).text();
      document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
      const rows = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
        .map((id, index) => ({id, name: `Synthetic tour ${index + 1}`, status: 'draft', stops: []}));
      let hold = false;
      const api = {scope: 'synthetic', library: async () => rows, clients: async () => [],
        tour: async id => !hold || id === rows[0].id ? rows.find(row => row.id === id) : new Promise(resolve => { window.resolveTour = () => resolve(rows[1]); })};
      window.planner = mountPlanner({document, window, api});
      await window.planner.ready;
      hold = true;
      document.querySelector('.tour-button').click();
    });
    assert.equal(await page.locator('#detail-title').textContent(), 'Synthetic tour 1');
    const stale = await page.evaluate(async () => {
      const dialog = document.querySelector('#tour-dialog');
      const closed = new Promise(resolve => dialog.addEventListener('close', event => resolve({trusted: event.isTrusted, open: dialog.open}), {once: true}));
      document.querySelector('#detail-close').click();
      document.querySelectorAll('.tour-button')[1].click();
      return closed;
    });
    assert.deepEqual(stale, {trusted: true, open: true});
    assert.deepEqual(await page.evaluate(async () => (await import('/js/doc-context.js')).pageDocContext.snapshot().selected),
      {kind: 'tour', id: '22222222-2222-4222-8222-222222222222'});
    await page.evaluate(() => window.resolveTour());
    assert.equal(await page.locator('#detail-title').textContent(), 'Synthetic tour 2');
    assert.equal(await page.locator('#detail-message').textContent(), '');
    const closed = await page.evaluate(async () => {
      const {pageDocContext} = await import('/js/doc-context.js');
      const dialog = document.querySelector('#tour-dialog');
      const event = new Promise(resolve => dialog.addEventListener('close', event => resolve(event.isTrusted), {once: true}));
      document.querySelector('#detail-close').click();
      const trusted = await event;
      const result = {trusted, open: dialog.open, selected: pageDocContext.snapshot().selected, focus: document.activeElement.dataset.tourId};
      window.planner.dispose();
      return result;
    });
    assert.deepEqual(closed, {trusted: true, open: false, selected: null, focus: '22222222-2222-4222-8222-222222222222'});
  });

  test(`Tour Day preserves reopened note audio until a true native close at ${width}px`, async t => {
    const page = await open(t, width);
    await page.evaluate(async () => {
      const {mountTourDay} = await import('/tours/day.js');
      const {detail} = await import('/test/fixtures/tour-day.synthetic.mjs');
      const html = await (await fetch('/tours/day.html')).text();
      document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
      history.replaceState(null, '', `?tour=${detail.id}`);
      const note = {id: 'synthetic-note', scope: 'synthetic', tour_id: detail.id, property_id: detail.stops[0].property_id,
        status: 'local', captured_at: '2026-10-01T10:00:00Z', audio: new Blob(['synthetic audio'], {type: 'audio/webm'})};
      const api = {session: async () => ({scope: 'synthetic', user_ref: 'synthetic'}), tour: async () => detail};
      const store = {list: async () => [note], putTour: async () => {}};
      window.tourDay = mountTourDay({document, window, api, store, prepareOffline: async () => {},
        mapFactory: () => ({dispatch() {}, update() {}, navigationLinks: () => [], destroy() {}})});
      await window.tourDay.ready;
      document.querySelector('.note-card').click();
    });
    const reopened = await page.evaluate(async () => {
      const dialog = document.querySelector('#day-dialog');
      const closed = new Promise(resolve => dialog.addEventListener('close', event => resolve({trusted: event.isTrusted, open: dialog.open}), {once: true}));
      document.querySelector('#day-dialog-close').click();
      document.querySelector('.note-card').click();
      window.noteAudioUrl = dialog.querySelector('audio').src;
      const stale = await closed;
      const audio = await fetch(window.noteAudioUrl).then(response => response.text(), () => null);
      return {stale, open: dialog.open, audio, focusInside: dialog.contains(document.activeElement)};
    });
    assert.deepEqual(reopened, {stale: {trusted: true, open: true}, open: true, audio: 'synthetic audio', focusInside: true});
    const closed = await page.evaluate(async () => {
      const dialog = document.querySelector('#day-dialog');
      const event = new Promise(resolve => dialog.addEventListener('close', event => resolve(event.isTrusted), {once: true}));
      dialog.close();
      const trusted = await event;
      const readable = await fetch(window.noteAudioUrl).then(() => true, () => false);
      const result = {trusted, open: dialog.open, readable, noteFocused: document.activeElement.matches('.note-card')};
      window.tourDay.dispose();
      return result;
    });
    assert.deepEqual(closed, {trusted: true, open: false, readable: false, noteFocused: true});
  });
}
