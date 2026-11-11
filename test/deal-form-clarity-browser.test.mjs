import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, animationsSettled } from './browser-harness.mjs';
import { ownedFixtureServer as fixtureServer } from './fixture-probe.ts';

for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
  test(`creation choices and locked fields stay readable at ${width}px ${theme}`, async t => {
    const server = await fixtureServer(); t.after(() => server.close());
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
    await page.route('**/js/app.js', route => route.fulfill({ contentType: 'text/javascript', body: source +
      '\nglobalThis.clarityApp={state,loadHome,addAccountForm,addMarketDealForm,showConflict};' }));
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.goto(`${server.origin}/deals?view=national&mode=fixture`);
    await page.locator('.account-card').first().waitFor();
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      window.creationRequests = [];
      window.clarityApp.state.client.createNationalAccount = async request => {
        window.creationRequests.push(structuredClone(request));
        if (!request.force_new) return { needs_confirm: true, candidates: [{ id: 'synthetic-brand', name: 'Synthetic separate brand with a long organization name for candidate review' }] };
        throw new Error('Synthetic unanswered creation');
      };
      window.clarityApp.addAccountForm();
    }, theme);
    const capture = async name => {
      await animationsSettled(page);
      const overflow = await page.locator('#formDialog, #dialogBody').evaluateAll(nodes => nodes.map(node => node.scrollWidth - node.clientWidth));
      assert.ok(overflow.every(value => value <= 1), `${name} has no horizontal overflow: ${overflow}`);
      if (process.env.UI_SCREENSHOT_DIR) {
        await mkdir(process.env.UI_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${process.env.UI_SCREENSHOT_DIR}/${name}-${width}-${theme}.png` });
      }
    };
    await page.locator('#accountName').fill('Synthetic separate brand with a long organization name');
    for (const field of ['name', 'company', 'phone', 'specialty', 'market']) await page.locator(`[name="research_${field}"]`).fill(`https://example.com/synthetic/${field}`);
    await page.locator('[name="research_observed_at"]').fill('2026-10-22T10:00');
    await page.locator('#researchDiscrepancies').fill('Synthetic source discrepancy. '.repeat(30));
    const spacing = await page.locator('#nationalCreationFields').evaluate(outer => {
      const inner = outer.querySelector('fieldset');
      const hint = outer.querySelector('small').getBoundingClientRect();
      const next = outer.querySelector('.field-row').getBoundingClientRect();
      const fields = [...inner.querySelectorAll('.field')].map(node => node.getBoundingClientRect());
      return { outerBorder: getComputedStyle(outer).borderTopWidth, innerBorder: getComputedStyle(inner).borderTopWidth,
        hintGap: next.top - hint.bottom, gaps: fields.slice(1).map((box, i) => box.top - fields[i].bottom) };
    });
    await capture('account');
    await page.locator('#dialogSubmit').click();
    const checkbox = page.locator('[name="confirm_separate"]');
    await checkbox.waitFor();
    const geometry = await checkbox.evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, labelHeight: el.parentElement.getBoundingClientRect().height }));
    assert.ok(geometry.width > 0 && geometry.width < 30, `checkbox width ${geometry.width} must be compact`);
    assert.ok(geometry.height < 30, `checkbox height ${geometry.height} must be compact`);
    assert.ok(geometry.labelHeight >= 44, `label height ${geometry.labelHeight} must be at least 44px`);
    assert.equal(spacing.outerBorder, '0px'); assert.notEqual(spacing.innerBorder, '0px');
    assert.ok(spacing.hintGap >= 8, `hint gap ${spacing.hintGap}`);
    assert.ok(spacing.gaps.every(gap => gap >= 8), `research field gaps ${spacing.gaps}`);
    const locked = page.locator('#accountName');
    const lockedStyle = await locked.evaluate(el => ({ opacity: getComputedStyle(el).opacity, cursor: getComputedStyle(el).cursor }));
    assert.deepEqual(lockedStyle, { opacity: '0.55', cursor: 'not-allowed' });
    const lockedColors = await page.locator('#accountName, #accountOwner, #researchDiscrepancies').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color));
    assert.equal(lockedColors.length, 3);
    assert.equal(lockedColors[0], lockedColors[1], 'locked text inputs use the same muted color as selects');
    assert.equal(lockedColors[0], lockedColors[2], 'locked text inputs use the same muted color as textareas');
    assert.equal(await page.locator('#accountOwner').isDisabled(), true);
    assert.equal(await page.locator('#researchDiscrepancies').isDisabled(), true);
    await locked.scrollIntoViewIfNeeded();
    await capture('locked-fields');
    const savedName = await locked.inputValue();
    await page.evaluate(() => document.activeElement.blur());
    await locked.evaluate(el => el.focus()); await page.keyboard.type('attempted edit');
    assert.equal(await locked.inputValue(), savedName);
    await checkbox.focus(); await page.keyboard.press('Space'); assert.equal(await checkbox.isChecked(), true);
    await page.keyboard.press('Space'); assert.equal(await checkbox.isChecked(), false);
    await capture('separate-brand');
    await checkbox.focus(); await page.keyboard.press('Space');
    await page.locator('#dialogSubmit').click();
    await page.waitForFunction(() => document.querySelector('[name="confirm_separate"]').disabled);
    assert.equal(await checkbox.isChecked(), true);
    await page.evaluate(() => document.activeElement.blur());
    await checkbox.evaluate(el => el.focus()); await page.keyboard.press('Space');
    assert.equal(await checkbox.isChecked(), true);
    assert.equal(await locked.isDisabled(), true);
    await capture('held-creation');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.clarityApp.addAccountForm());
    assert.equal(await locked.inputValue(), savedName);
    assert.equal(await checkbox.isChecked(), true);
    assert.equal(await checkbox.isDisabled(), true);
    assert.equal(await page.evaluate(() => window.creationRequests.length), 2);
    await page.keyboard.press('Escape');
    await page.locator('.account-card').first().click();
    await page.evaluate(() => window.clarityApp.addMarketDealForm());
    await page.locator('#marketClient').fill('Synthetic long sub-client name '.repeat(8));
    await capture('new-sub-client');
    await page.locator('#marketClientMode').selectOption('existing');
    assert.equal(await page.locator('#marketResearch').isHidden(), true);
    assert.equal(await page.locator('#research_name').isDisabled(), true);
    await capture('existing-sub-client');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.clarityApp.showConflict({ conflict_id: 'synthetic-conflict', field: 'next_step',
      a: { actor: 'dell', value: 'Synthetic long next step with reviewed sources. '.repeat(12) },
      b: { actor: 'joe', value: 'Synthetic alternative next step. '.repeat(12) } }));
    await capture('conflict');
    const radio = page.locator('[name="winner"]').first();
    assert.ok(await radio.evaluate(el => el.getBoundingClientRect().width <= 24));
    await radio.focus(); await page.keyboard.press('Space'); assert.equal(await radio.isChecked(), true);
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      const app = window.clarityApp;
      app.state.client.getBoard = async () => ({ actor: 'joe', deals: [], accounts: [] });
      await app.loadHome();
      app.addAccountForm();
    });
    assert.equal(await page.locator('.account-card').count(), 0);
    assert.equal(await checkbox.isDisabled(), true);
    await capture('zero-rows-held');
    await page.reload();
    assert.equal(await page.locator('#formDialog').isVisible(), false);
    assert.equal(await page.locator('[name="confirm_separate"]').count(), 0);
    const clientSource = await readFile(new URL('../js/client.js', import.meta.url), 'utf8');
    await page.route('**/js/client.js', route => route.fulfill({ contentType: 'text/javascript', body: clientSource +
      '\nconst originalCreateClient=createClient; createClient=(_mode,options)=>originalCreateClient("fixture",options);' }));
    await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-session' } }));
    await page.route('**/auth/signout', route => route.fulfill({ status: 401, json: {} }));
    await page.goto(`${server.origin}/deals?view=national&mode=live`);
    await page.locator('.account-card').first().waitFor();
    await page.evaluate(() => window.clarityApp.addAccountForm());
    await page.locator('#accountName').fill('Synthetic unsaved brand');
    await page.keyboard.press('Escape');
    await page.locator('#selfAvatar').click();
    await page.getByText('Sign out', { exact: true }).click();
    await page.waitForURL('**/public-shell/session-ended.html');
    assert.equal(await page.locator('#formDialog, #accountName').count(), 0);
    assert.doesNotMatch(await page.locator('body').textContent(), /Synthetic unsaved brand/);
    assert.deepEqual(errors, []);
  });
}
