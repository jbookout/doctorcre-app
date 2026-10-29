import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, waitForAsync, settles } from './browser-harness.mjs';
const root = new URL('../', import.meta.url);
async function open(t, path = '/deals') {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.clock.install();
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (['/api/system-work/session', '/auth/session'].includes(url.pathname)) return route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-only' } });
    if (url.pathname.startsWith('/api/') || url.pathname === '/app-release') return route.fulfill({ json: {} });
    const file = url.pathname === '/deals' ? 'pipeline.html' : url.pathname.slice(1);
    try { return route.fulfill({ body: await readFile(new URL(file, root)), contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://localhost' + path);
  await waitForAsync(page, async () => (await import('/js/pipeline.js')).state.deals.size > 0);
  return page;
}
async function room(page, id = 'd14') {
  await page.locator(`.kanban-card[data-id="${id}"] .card-open`).click();
  await page.locator('#dealUpdate').waitFor();
}

test('unsent deal updates survive close, another deal, refresh, and reopen without sending', async t => {
  const page = await open(t);
  await room(page);
  await page.locator('#dealUpdate').fill('Synthetic callback notes still being composed');
  await page.locator('#panelClose').click();
  await page.locator('.kanban-card:not([data-id="d14"]) .card-open').first().click();
  await page.locator('#dealUpdate').waitFor();
  await page.locator('#dealUpdate').fill('Synthetic second deal draft');
  await page.locator('#panelClose').click();
  await room(page);
  assert.equal(await page.locator('#dealUpdate').inputValue(), 'Synthetic callback notes still being composed');
  assert.match(await page.locator('#detailUpdateStatus').textContent(), /unsent/i);
  await page.locator('[data-refresh-detail]').click();
  assert.equal(await page.locator('#dealUpdate').inputValue(), 'Synthetic callback notes still being composed');
  assert.equal(await page.locator('.deal-note').filter({ hasText: 'Synthetic callback notes still being composed' }).count(), 0);
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
  assert.equal(await page.locator('#dealUpdate').inputValue(), '');
  await page.locator('#panelClose').click(); await room(page);
  assert.equal(await page.locator('#dealUpdate').inputValue(), '');
});

test('phone Back closes a board-opened room and Forward restores its unsent draft', async t => {
  const page = await open(t);
  const before = await page.evaluate(() => history.length);
  await room(page);
  await page.locator('#dealUpdate').fill('Synthetic phone interruption');
  assert.equal(await page.evaluate(() => history.length), before + 1);
  await page.goBack();
  await settles(async () => assert.equal(await page.locator('#recordPanel').isVisible(), false));
  assert.equal(new URL(page.url()).pathname, '/deals');
  await page.goForward(); await page.locator('#dealUpdate').waitFor();
  assert.equal(await page.locator('#dealUpdate').inputValue(), 'Synthetic phone interruption');
});

test('direct-linked room closes safely to its board', async t => {
  const page = await open(t, '/deals?deal=d14');
  await page.locator('#dealUpdate').waitFor();
  await page.locator('#panelClose').click();
  await settles(async () => assert.equal(await page.locator('#recordPanel').isVisible(), false));
  assert.equal(new URL(page.url()).pathname, '/deals');
  assert.equal(new URL(page.url()).searchParams.has('deal'), false);
});

test('drafts are revoked when the board verifies a different actor', async t => {
  const page = await open(t); await room(page);
  await page.locator('#dealUpdate').fill('Synthetic private draft');
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const read = state.client.getBoard;
    state.client.getBoard = async (...args) => ({ ...await read(...args), actor: 'dell' });
    await state.boardSync.refreshBoard({ reason: 'synthetic-account-change' });
  });
  await settles(async () => assert.equal(await page.locator('#dealUpdate').inputValue(), ''));
  await page.locator('#panelClose').click(); await room(page);
  assert.equal(await page.locator('#dealUpdate').inputValue(), '');
});

test('confirmed save clears a draft even when its room closed before the reply', async t => {
  const page = await open(t); await room(page);
  await page.locator('#dealUpdate').fill('Synthetic saved update');
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const send = state.client.addDealNote;
    state.client.addDealNote = (...args) => new Promise(resolve => { window.releaseUpdate = async () => resolve(await send(...args)); });
  });
  await page.getByRole('button', { name: 'Add update', exact: true }).click();
  await page.locator('#panelClose').click();
  await page.evaluate(() => window.releaseUpdate());
  await room(page);
  await settles(async () => assert.equal(await page.locator('#dealUpdate').inputValue(), ''));
});

test('an actor change clears the previous detail from Doc while its replacement is pending', async t => {
  const page = await open(t);
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const read = state.client.getDeal;
    state.client.getDeal = async (...args) => {
      const detail = await read(...args);
      return { ...detail, deal: { ...detail.deal, next_step: 'Synthetic actor-only detail' } };
    };
  });
  await room(page);
  await page.locator('#dealUpdate').fill('Synthetic actor-only draft');
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const read = state.client.getBoard;
    state.client.getBoard = async (...args) => ({ ...await read(...args), actor: 'dell' });
    state.client.getDeal = () => new Promise(() => {});
    await state.boardSync.refreshBoard({ reason: 'synthetic-actor-change-with-held-detail' });
  });
  assert.equal(await page.locator('#detailUpdateForm').count(), 0);
  const context = await page.evaluate(async () => (await import('/js/doc-context.js')).pageDocContext.snapshot());
  assert.doesNotMatch(JSON.stringify(context), /Synthetic actor-only detail/);
});

test('phone Back closes the room and its open Context drawer together', async t => {
  const page = await open(t); await room(page);
  await page.locator('#panelContextOpen').click();
  await page.locator('#contextDrawer[open]').waitFor();
  await page.goBack();
  await settles(async () => assert.equal(await page.locator('#recordPanel').isVisible(), false));
  assert.equal(await page.locator('#contextDrawer').isVisible(), false);
  assert.equal(await page.locator('#contextDrawerBody').textContent(), '');
  assert.equal(new URL(page.url()).searchParams.has('deal'), false);
});

test('a deal requirement email uses only entered requirements and copies the edited preview', async t => {
  const page = await open(t); await room(page);
  await page.getByText('Draft requirement email', { exact: true }).click();
  await page.getByLabel('Use', { exact: true }).fill('Dental office');
  await page.getByLabel('Size', { exact: true }).fill('2,500–3,000 SF');
  await page.getByLabel('Location', { exact: true }).fill('Pensacola');
  await page.getByLabel('Timing', { exact: true }).fill('Spring 2027');
  await page.getByLabel('Budget', { exact: true }).fill('$30/SF/year');
  await page.getByLabel('Approved requirements', { exact: true }).fill('Ground floor and accessible parking');
  await page.getByRole('button', { name: 'Generate email preview', exact: true }).click();
  assert.equal(await page.getByLabel('Email subject').inputValue(), 'Space requirement · Dental office · Pensacola');
  const body = await page.getByLabel('Email message').inputValue();
  for (const value of ['Dental office', '2,500–3,000 SF', 'Pensacola', 'Spring 2027', '$30/SF/year', 'Ground floor and accessible parking']) assert.ok(body.includes(value));
  assert.ok(!body.includes('Demo Surgical Practice'), 'client identity is not added to outgoing text');
  await page.getByLabel('Email message').scrollIntoViewIfNeeded();
  assert.ok(await page.locator('#recordPanel').evaluate(panel => panel.scrollWidth <= panel.clientWidth + 1), 'phone dialog has no horizontal overflow');
  await mkdir(new URL('../test-artifacts/requirement-preview/', import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL('../test-artifacts/requirement-preview/390-preview.png', import.meta.url).pathname });
  await page.getByRole('button', { name: 'Copy email draft', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: new URL('../test-artifacts/requirement-preview/390-copy.png', import.meta.url).pathname });
  await page.getByLabel('Email subject').fill('Edited anonymous requirement');
  await page.getByLabel('Email message').fill('Please share ground-floor options in Pensacola.');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedRequirement = text; } } }));
  await page.getByRole('button', { name: 'Copy email draft', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedRequirement), 'Subject: Edited anonymous requirement\n\nPlease share ground-floor options in Pensacola.');
  assert.equal(await page.locator('a[href^="mailto:"]').count(), 0);
});

test('requirement drafts stay with their deal through refresh and revoke on an actor change', async t => {
  const page = await open(t); await room(page);
  await page.getByText('Draft requirement email', { exact: true }).click();
  await page.getByLabel('Email subject').fill('Synthetic first requirement');
  await page.getByLabel('Email message').fill('First deal anonymous requirements');
  await page.locator('[data-refresh-detail]').click();
  assert.equal(await page.getByLabel('Email message').inputValue(), 'First deal anonymous requirements');
  await page.locator('#panelClose').click();
  await page.locator('.kanban-card:not([data-id="d14"]) .card-open').first().click();
  await page.getByText('Draft requirement email', { exact: true }).click();
  assert.equal(await page.getByLabel('Email message').inputValue(), '');
  await page.getByLabel('Email message').fill('Second deal anonymous requirements');
  await page.locator('#panelClose').click(); await room(page);
  await page.getByText('Draft requirement email', { exact: true }).click();
  assert.equal(await page.getByLabel('Email message').inputValue(), 'First deal anonymous requirements');
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const read = state.client.getBoard;
    state.client.getBoard = async (...args) => ({ ...await read(...args), actor: 'dell' });
    await state.boardSync.refreshBoard({ reason: 'synthetic-account-change' });
  });
  await page.getByText('Draft requirement email', { exact: true }).click();
  assert.equal(await page.getByLabel('Email message').inputValue(), '');
});

test('a blocked clipboard keeps the requirement preview selectable and discard removes it', async t => {
  const page = await open(t); await room(page);
  await page.getByText('Draft requirement email', { exact: true }).click();
  await page.getByLabel('Email subject').fill('Synthetic anonymous requirement');
  await page.getByLabel('Email message').fill('Synthetic approved requirements');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('synthetic clipboard denial'); } } }));
  await page.getByRole('button', { name: 'Copy email draft', exact: true }).click();
  assert.match(await page.locator('#requirementEmailStatus').textContent(), /copy manually/i);
  assert.equal(await page.getByLabel('Email message').evaluate(input => input.value.slice(input.selectionStart, input.selectionEnd)), 'Synthetic approved requirements');
  await page.getByRole('button', { name: 'Discard email draft', exact: true }).click();
  assert.equal(await page.getByLabel('Email subject').inputValue(), '');
  assert.equal(await page.getByLabel('Email message').inputValue(), '');
  await page.locator('#panelClose').click(); await room(page);
  await page.getByText('Draft requirement email', { exact: true }).click();
  assert.equal(await page.getByLabel('Email message').inputValue(), '');
});

test('an authorization refusal removes requirement drafts before a pending copy completes', async t => {
  const page = await open(t); await room(page);
  await page.getByText('Draft requirement email', { exact: true }).click();
  await page.getByLabel('Email subject').fill('Synthetic protected draft');
  await page.getByLabel('Email message').fill('Synthetic protected requirements');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise(resolve => window.releaseRequirementCopy = resolve) } }));
  await page.getByRole('button', { name: 'Copy email draft', exact: true }).click();
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    window.restoreRequirementDetail = state.client.getDeal;
    state.client.getDeal = async () => { throw Object.assign(new Error('Synthetic denied'), { status: 403 }); };
  });
  await page.locator('[data-refresh-detail]').click();
  await page.getByRole('link', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(await page.locator('#requirementEmailForm').count(), 0);
  await page.evaluate(() => window.releaseRequirementCopy());
  await page.evaluate(async () => { (await import('/js/pipeline.js')).state.client.getDeal = window.restoreRequirementDetail; });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByText('Draft requirement email', { exact: true }).click();
  assert.equal(await page.getByLabel('Email message').inputValue(), '');
});

test('discard keeps its status when an earlier clipboard request completes', async t => {
  const page = await open(t); await room(page);
  await page.getByText('Draft requirement email', { exact: true }).click();
  await page.getByLabel('Email subject').fill('Synthetic pending copy');
  await page.getByLabel('Email message').fill('Synthetic requirement to discard');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise(resolve => window.releaseDiscardedCopy = resolve) } }));
  await page.getByRole('button', { name: 'Copy email draft', exact: true }).click();
  await page.getByRole('button', { name: 'Discard email draft', exact: true }).click();
  await page.evaluate(() => window.releaseDiscardedCopy());
  assert.equal(await page.locator('#requirementEmailStatus').textContent(), 'Email draft discarded.');
  assert.equal(await page.getByLabel('Email message').inputValue(), '');
});


test('Enter in requirement fields preserves the edited preview until Generate is clicked', async t => {
  const page = await open(t); await room(page);
  await page.getByText('Draft requirement email', { exact: true }).click();
  await page.getByLabel('Use', { exact: true }).fill('Dental office');
  await page.getByLabel('Location', { exact: true }).fill('Pensacola');
  await page.getByRole('button', { name: 'Generate email preview', exact: true }).click();
  await page.getByLabel('Email subject').fill('Edited subject');
  await page.getByLabel('Email message').fill('Edited approved requirements');
  for (const label of ['Email subject', 'Size']) {
    await page.getByLabel(label, { exact: true }).press('Enter');
    assert.equal(await page.getByLabel('Email subject').inputValue(), 'Edited subject');
    assert.equal(await page.getByLabel('Email message').inputValue(), 'Edited approved requirements');
  }
  await page.getByRole('button', { name: 'Generate email preview', exact: true }).click();
  assert.equal(await page.getByLabel('Email subject').inputValue(), 'Space requirement · Dental office · Pensacola');
});


test('long approved requirements generate a valid subject that can be edited and regenerated', async t => {
  const page = await open(t); await room(page);
  await page.getByText('Draft requirement email', { exact: true }).click();
  await page.getByLabel('Use', { exact: true }).fill('Dental office '.repeat(50));
  await page.getByLabel('Location', { exact: true }).fill('Pensacola '.repeat(50));
  await page.getByRole('button', { name: 'Generate email preview', exact: true }).click();
  assert.equal((await page.getByLabel('Email subject').inputValue()).length, 500);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedRequirement = text; } } }));
  await page.getByRole('button', { name: 'Copy email draft', exact: true }).click();
  assert.equal((await page.evaluate(() => window.copiedRequirement)).split('\n')[0].length, 509);
  await page.getByLabel('Email subject').press('End');
  await page.getByLabel('Email subject').press('Backspace');
  assert.equal(await page.locator('#requirementEmailForm').evaluate(form => form.checkValidity()), true);
  await page.getByLabel('Use', { exact: true }).fill('Medical office');
  await page.getByLabel('Location', { exact: true }).fill('Mobile');
  await page.getByRole('button', { name: 'Generate email preview', exact: true }).click();
  assert.equal(await page.getByLabel('Email subject').inputValue(), 'Space requirement · Medical office · Mobile');
});


for (const outcome of ['copied', 'denied']) {
  test(`pending requirement copy reports ${outcome} after an ordinary edit`, async t => {
    const page = await open(t); await room(page);
    await page.getByText('Draft requirement email', { exact: true }).click();
    await page.getByLabel('Email subject').fill('Original subject');
    await page.getByLabel('Email message').fill('Original approved requirements');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: text => new Promise((resolve, reject) => {
        window.copiedRequirement = text;
        window.finishRequirementCopy = denied => denied ? reject(new Error('Synthetic denial')) : resolve();
      }),
    } }));
    await page.getByRole('button', { name: 'Copy email draft', exact: true }).click();
    await page.getByLabel('Email message').fill('Edited approved requirements');
    await page.evaluate(denied => window.finishRequirementCopy(denied), outcome === 'denied');
    assert.equal(await page.getByLabel('Email message').inputValue(), 'Edited approved requirements');
    assert.equal(await page.evaluate(() => window.copiedRequirement), 'Subject: Original subject\n\nOriginal approved requirements');
    if (outcome === 'copied') {
      assert.equal(await page.locator('#requirementEmailStatus').textContent(), 'Email draft copied. Nothing sent.');
    } else {
      assert.match(await page.locator('#requirementEmailStatus').textContent(), /copy manually/i);
      assert.equal(await page.getByLabel('Email message').evaluate(input => input.value.slice(input.selectionStart, input.selectionEnd)), 'Edited approved requirements');
    }
  });
}


test('requirement preview does not retain the old deal name after a room refresh', async t => {
  const page = await open(t); await room(page);
  const oldTitle = await page.locator('#panelTitle').textContent();
  await page.getByText('Draft requirement email', { exact: true }).click();
  await page.getByLabel('Email message').fill('Approved anonymous requirements');
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const read = state.client.getDeal.bind(state.client);
    state.client.getDeal = async (...args) => {
      const detail = await read(...args);
      return { ...detail, deal: { ...detail.deal, name: 'Renamed synthetic deal' } };
    };
  });
  await page.locator('[data-refresh-detail]').click();
  await settles(async () => assert.equal(await page.locator('#panelTitle').textContent(), 'Renamed synthetic deal'));
  assert.ok(!(await page.locator('#requirementEmail').textContent()).includes(oldTitle));
  assert.equal(await page.getByLabel('Email message').inputValue(), 'Approved anonymous requirements');
});
