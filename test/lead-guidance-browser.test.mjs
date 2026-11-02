import test from 'node:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';
import { detail, workspace } from './leads-workspace-fixture.mjs';

await mkdir('test-artifacts', { recursive: true });
const screenshots = await mkdtemp('test-artifacts/lead-guidance-');

const guidance = {
  handling_advice: 'Respect the recorded timing before preparing a draft.',
  strategy: { basis: 'stage_based_guidance', objective: 'Confirm the decision makers.',
    discovery: ['Who approves the decision?', 'What constraints and timing are firm?'],
    decision_window: null, confidence: 'unrecorded', next_step: 'Respect the recorded next action date 2028-05-19.',
    channel: 'Use a verified contact route. ' + 'Confirm the recorded route with the owning partner. '.repeat(8), risk: 'Do not infer intent from a sourcing signal.' },
};

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`lead guidance uses the detail snapshot at ${width} in ${theme}`, async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    let reads = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/mcp') reads++; });
    await routeLeads(page, { getDetail: row => ({ ...detail(row),
      ...(row.id.endsWith('1') ? guidance : { handling_advice: 'Do not contact. Ask the owning partner to review the hold.',
        contact_eligible: false, strategy: { ...guidance.strategy, objective: 'Resolve the recorded hold.' } }) }) });
    await page.goto('http://localhost/leads');
    await page.locator('#leadBoard[aria-busy="false"]').waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    const before = reads;
    await page.locator('[data-open]').first().click();
    await page.getByRole('heading', { name: 'Handling advice', exact: true }).waitFor();
    assert.equal(reads, before + 1);
    assert.match(await page.locator('#leadGuidance').innerText(), /Respect the recorded timing/);
    assert.equal(await page.locator('.lead-guidance-restriction').count(), 0);
    await page.locator('#leadGuidance summary').click();
    assert.match(await page.locator('#leadGuidance').innerText(), /2028-05-19/);
    assert.match(await page.locator('#leadGuidance').innerText(), /Decision window\s+Unavailable/);
    assert.match(await page.locator('#leadGuidance').innerText(), /not verified prospect intent/);
    assert.equal(await page.locator('#leadGuidance').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    assert.equal(await page.locator('#leadGuidance summary').evaluate(el => el.getBoundingClientRect().height >= 44), true);
    if (width === 1280) assert.equal(await page.getByText('Decision window', { exact: true }).evaluate(el =>
      el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) + 1), true);
    await page.locator('#leadGuidance').screenshot({ path: `${screenshots}/${width}-${theme}-strategy.png` });
    await page.locator('#closeDetail').click();
    await page.locator('[data-open]').nth(1).click();
    await page.getByText('Do not contact. Ask the owning partner to review the hold.', { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('#leadGuidance').innerText(), /Respect the recorded timing/);
    assert.equal(await page.locator('.lead-guidance-restriction').count(), 1);
    await page.locator('#leadGuidance').screenshot({ path: `${screenshots}/${width}-${theme}-restriction.png` });
  });
}


test('guidance refresh preserves correspondence and focus, clears missing fields and expired sessions', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  let current = guidance;
  await routeLeads(page, { getDetail: row => ({ ...detail(row), ...current }) });
  await page.goto('http://localhost/leads');
  await page.locator('#leadBoard[aria-busy="false"]').waitFor();
  await page.locator('[data-open]').first().click();
  await page.locator('#leadGuidance summary').click();
  const entry = page.locator('.correspondence details').first();
  await entry.locator('summary').click();
  current = { ...guidance, handling_advice: 'Updated server advice.' };
  await page.locator('#refreshBoard').evaluate(button => button.click());
  await page.getByText('Updated server advice.', { exact: true }).waitFor();
  assert.equal(await entry.getAttribute('open'), '');
  assert.equal(await entry.locator('summary').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('#leadGuidance details').getAttribute('open'), '');
  current = { handling_advice: null, strategy: null };
  await page.locator('#refreshBoard').evaluate(button => button.click());
  await page.getByText('Handling advice unavailable.', { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('#leadGuidance').innerText(), /2028-05-19/);
  await page.route('http://localhost/api/system-work/session', route => route.fulfill({ status: 401, json: { error: 'not_authenticated' } }));
  await page.locator('#refreshBoard').evaluate(button => button.click());
  await page.waitForFunction(() => !document.querySelector('#leadDetail').open);
  assert.equal(await page.locator('#leadGuidance').count(), 0);
});

test('loading, late replies, refused and unavailable details never retain old guidance', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await routeLeads(page, { getDetail: row => ({ ...detail(row), ...guidance }) });
  await page.goto('http://localhost/leads');
  await page.locator('#leadBoard[aria-busy="false"]').waitFor();
  let release;
  const held = new Promise(resolve => release = resolve);
  let started;
  const waiting = new Promise(resolve => started = resolve);
  await page.route('http://localhost/mcp', async route => {
    const args = route.request().postDataJSON().params.arguments;
    if (!args.lead_id) return route.fallback();
    started();
    await held;
    return route.fallback();
  }, { times: 1 });
  await page.locator('[data-open]').first().click();
  await waiting;
  assert.equal(await page.locator('#leadGuidance').count(), 0);
  await page.locator('#closeDetail').click();
  await page.locator('[data-open]').nth(1).click();
  await page.getByRole('heading', { name: 'Handling advice', exact: true }).waitFor();
  release();
  await page.waitForLoadState('networkidle');
  assert.match(await page.locator('#detailTitle').innerText(), /Example 2/);
  await page.locator('#closeDetail').click();
  for (const status of [422, 503]) {
    await page.route('http://localhost/mcp', route => {
      if (!route.request().postDataJSON().params.arguments.lead_id) return route.fallback();
      return route.fulfill({ status, json: { error: 'unavailable' } });
    }, { times: 1 });
    await page.locator('[data-open]').first().click();
    await page.locator('#detailBody [role="alert"]').waitFor();
    assert.equal(await page.locator('#leadGuidance').count(), 0);
    await page.locator('#closeDetail').click();
  }
});


test('online resume preserves the open strategy and dialog scroll on a phone', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  let current = guidance;
  await routeLeads(page, { getDetail: row => ({ ...detail(row), ...current }) });
  await page.goto('http://localhost/leads');
  await page.locator('#leadBoard[aria-busy="false"]').waitFor();
  await page.locator('[data-open]').first().click();
  await page.locator('#leadGuidance summary').click();
  const scroll = await page.locator('#leadDetail').evaluate(el => { el.scrollTop = 600; return el.scrollTop; });
  assert.equal(scroll, 600);
  current = { ...guidance, handling_advice: 'Advice refreshed after online resume.' };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByText(current.handling_advice, { exact: true }).waitFor();
  assert.deepEqual(await page.locator('#leadDetail').evaluate(el => ({
    strategyOpen: el.querySelector('#leadGuidance details').open, scroll: el.scrollTop,
  })), { strategyOpen: true, scroll });
});

test('server hold for archived stage displays a restriction banner', async t => {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await routeLeads(page, { getDetail: row => ({ ...detail(row), ...guidance,
      stage: 'archived', suppressed: false, contact_eligible: true, contact_state: 'active',
      handling_advice: 'Do not contact. Review the recorded restriction or terminal stage with the owning partner.',
    }) });
    await page.goto('http://localhost/leads');
    await page.locator('#leadBoard[aria-busy="false"]').waitFor();
    await page.locator('[data-open]').first().click();
    await page.getByRole('heading', { name: 'Handling advice', exact: true }).waitFor();
    assert.equal(await page.locator('.lead-guidance-restriction').count(), 1);
});
