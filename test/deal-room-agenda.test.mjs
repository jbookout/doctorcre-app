import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, fixtureServer } from './browser-harness.mjs';

test('agenda rendering preserves text, commands, focus, pending state and recoverable suggestions', async t => {
  const server = await fixtureServer(); t.after(() => server.close());
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${server.origin}/deals?mode=fixture&view=national`);
  await page.locator('.account-card').first().waitFor();
  const result = await page.evaluate(async () => {
    const { mountDealRoomAgenda } = await import('/js/ui.generated.js');
    const host = document.createElement('div');
    document.body.append(host);
    host.innerHTML = '<button></button><aside></aside><div></div>';
    const [button, panel, dock] = host.children;
    const actions = [];
    const view = mountDealRoomAgenda({ button, panel, dock }, action => actions.push(action));
    const props = { buttonHidden: false, disabled: false, review: { title: '<Synthetic>', index: 0, total: 2,
      deal: { id: 'sample', name: '<Sample>', context: 'Austin', reason: 'Needs clarity', phase: 'Research',
        nextStep: 'Call broker', nextDate: 'Not set', marketAgent: 'Unassigned' } },
      confirms: [{ id: 'proposal', label: '<Suggestion>' }], confirmError: null };
    view.render(props);
    const reviewed = panel.querySelector('#agendaReviewed');
    reviewed.focus(); reviewed.click();
    view.render({ ...props, review: { ...props.review, index: 1, deal: { ...props.review.deal, nextStep: 'Updated step' } } });
    const focused = document.activeElement === reviewed;
    const text = panel.textContent;
    const progress = panel.querySelector('#agendaMeter').value;
    view.render({ ...props, disabled: true });
    const disabled = [...host.querySelectorAll('#agendaReviewed,#agendaSkip,#agendaEnd,#agendaClose,[data-confirm]')].every(node => node.disabled) && button.disabled;
    view.render({ ...props, review: null, confirms: [], confirmError: 'unavailable' });
    const retry = dock.querySelector('[data-confirms-retry]')?.textContent;
    const closed = panel.hidden;
    view.render({ ...props, buttonHidden: true, review: null, confirms: [], confirmError: 'denied' });
    const signin = dock.querySelector('a')?.getAttribute('href');
    const hidden = button.hidden;
    view.dispose(); host.remove();
    return { actions, focused, text, progress, disabled, retry, closed, signin, hidden };
  });
  assert.deepEqual(result.actions, ['reviewed']);
  assert.equal(result.focused, true);
  assert.match(result.text, /<Sample>.*Austin.*Updated step/s);
  assert.match(result.text, /Assigned market agent.*Unassigned/s);
  assert.equal(result.progress, 1);
  assert.equal(result.disabled, true);
  assert.equal(result.retry, 'Retry suggestions');
  assert.equal(result.closed, true);
  assert.equal(result.signin, '/auth/login');
  assert.equal(result.hidden, true);
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`agenda journey at ${width}px in ${theme}`, async t => {
    const server = await fixtureServer(); t.after(() => server.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
    await page.route('**/js/app.js', route => route.fulfill({ contentType: 'text/javascript',
      body: source + '\nglobalThis.agendaApp={state,render,renderAgenda,renderConfirms};' }));
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.goto(`${server.origin}/deals?view=national&mode=fixture`);
    await page.locator('.account-card').first().waitFor();
    assert.equal(await page.locator('#agendaButton').isHidden(), true);
    await page.locator('.account-card').first().click();
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      const a = window.agendaApp;
      const first = { ...[...a.state.deals.values()].find(deal => deal.account_client_id === a.state.accountId), id: 'synthetic-one', name: 'Synthetic agenda one', next_step: 'Call the broker', phase: 'Research', operating_state: 'active' };
      a.state.deals = new Map([[first.id, first], ['synthetic-two', { ...first, id: 'synthetic-two', name: 'Synthetic agenda two' }]]);
      a.state.client.startReview = async () => ({ ok: true, session_id: 'synthetic-session' });
      window.agendaCalls = [];
      a.state.client.reviewDeal = args => new Promise(resolve => { window.agendaCalls.push(args); window.releaseAgenda = () => resolve({ ok: true }); });
      window.failAgendaEnd = true;
      a.state.client.endReview = async args => {
        window.agendaCalls.push(args);
        if (window.failAgendaEnd) { window.failAgendaEnd = false; throw new Error('synthetic end failure'); }
        return { ok: true, reviewed: 1 };
      };
    }, theme);
    if (!await page.locator('#agendaButton').isVisible()) await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
    await page.locator('#agendaButton').click();
    await page.locator('#agendaPanel').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    assert.match(await page.locator('#agendaCard').textContent(), /Synthetic agenda one/);
    await page.locator('#agendaReviewed').focus();
    await page.evaluate(() => {
      const a = window.agendaApp;
      a.state.deals.get('synthetic-one').next_step = 'Confirm broker availability';
      a.renderAgenda();
      a.state.confirms = [{ id: 'synthetic-proposal', label: 'Synthetic capture suggestion' }];
      a.renderConfirms();
    });
    assert.equal(await page.locator('#agendaReviewed').evaluate(node => node === document.activeElement), true);
    assert.match(await page.locator('#agendaCard').textContent(), /Confirm broker availability/);
    await mkdir('/tmp/wr616-s4-j3-shots', { recursive: true });
    await page.screenshot({ path: `/tmp/wr616-s4-j3-shots/agenda-${width}-${theme}.png`, fullPage: true });
    await page.locator('#agendaReviewed').click();
    await page.waitForFunction(() => document.querySelector('#agendaReviewed').disabled);
    assert.equal(await page.locator('[data-confirm=yes]').isDisabled(), true);
    await page.evaluate(() => window.releaseAgenda());
    await page.waitForFunction(() => document.querySelector('#agendaProgress').textContent === '2 of 2');
    await page.locator('#agendaSkip').click();
    await page.waitForFunction(() => window.agendaCalls.length === 2);
    await page.evaluate(() => window.releaseAgenda());
    await page.locator('[data-screen-retry]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#agendaPanel').isVisible(), true);
    await page.locator('[data-screen-retry]').click();
    await page.waitForFunction(() => window.agendaApp.state.review === null);
    await page.locator('#agendaPanel').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window.agendaCalls.map(call => call.disposition || call.status)), ['reviewed', 'skipped', 'completed', 'completed']);
    assert.deepEqual(await page.evaluate(() => window.agendaCalls[2]), await page.evaluate(() => window.agendaCalls[3]));
    if (!await page.locator('#agendaButton').isVisible()) await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
    await page.locator('#agendaButton').click();
    await page.locator('#agendaPanel').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.locator('#agendaClose').click();
    await page.locator('#agendaPanel').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.agendaCalls.at(-1).status), 'abandoned');
    if (!await page.locator('#agendaButton').isVisible()) await page.getByRole('button', { name: 'Workspace sidebar', exact: true }).click();
    await page.locator('#agendaButton').click();
    await page.locator('#agendaPanel').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.locator('#agendaEnd').click();
    await page.locator('#agendaPanel').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.agendaCalls.at(-1).status), 'completed');
    assert.deepEqual(errors, []);
  });
}
