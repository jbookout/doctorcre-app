import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";

async function open(t, width = 390) {
  const server = await startFixtureServer(); t.after(server.stop);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const response = await page.goto(`${server.url}/client-portal`);
  assert.equal(response.status(), 200);
  return page;
}

test('keyboard unlock focuses the current roadmap in both themes and viewport sizes', async t => {
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    const page = await open(t, width);
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.getByLabel('Portal name').fill('demo-practice');
    await page.getByLabel('Portal password').fill('demo-portal');
    await page.keyboard.press('Enter');
    const heading = page.getByRole('heading', { name: 'Your transaction roadmap' });
    await heading.waitFor();
    assert.equal(await heading.evaluate(element => element === document.activeElement), true);
    assert.equal(await heading.getAttribute('tabindex'), '-1');
    assert.equal(await page.getByLabel('Portal password').inputValue(), '');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('#portalContent input, #portalContent button, #portalContent textarea').count(), 0);
    await mkdir('out/test-artifacts/client-portal', { recursive: true });
    await page.screenshot({ path: `out/test-artifacts/client-portal/${width}-${theme}-focus.png`, fullPage: true });
  }
});

test('fixture portal renders canonical current phase and shared text at phone and desktop widths', async t => {
  for (const width of [390, 1440]) {
    const page = await open(t, width);
    await page.getByLabel('Portal name').fill('demo-practice');
    await page.getByLabel('Portal password').fill('demo-portal');
    await page.getByRole('button', { name: 'Open portal', exact: true }).click();
    await page.getByRole('heading', { name: 'Your transaction roadmap' }).waitFor();
    assert.equal(await page.locator('[aria-current="step"]').innerText(), 'Negotiation\nCurrent step');
    assert.equal(await page.locator('#portalPhases li').count(), 8);
    assert.match(await page.getByRole('region', { name: 'Shared material' }).innerText(), /Demo tour summary/);
    assert.equal(await page.getByLabel('Portal password').inputValue(), '');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await mkdir('out/test-artifacts/client-portal', { recursive: true });
    await page.screenshot({ path: `out/test-artifacts/client-portal/${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Lock portal' }).click();
    assert.equal(await page.locator('#portalContent').innerText(), '');
    assert.equal(await page.getByLabel('Portal password').inputValue(), '');
    await page.getByLabel('Portal password').fill('demo-portal');
    await page.getByRole('button', { name: 'Open portal', exact: true }).click();
    await page.getByRole('heading', { name: 'Your transaction roadmap' }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
    assert.equal(await page.locator('#portalContent').innerText(), '');
    assert.equal(await page.getByLabel('Portal password').inputValue(), '');
  }
});

test('held unlock only focuses the current roadmap and respects focus moved to Lock', async t => {
  for (const action of ['wait', 'focus-lock', 'blur', 'lock', 'obsolete', 'pagehide', 'invalidate', 'mismatched-slug']) {
    await t.test(action, async t => {
      const page = await open(t);
      await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'demo-partner' }, csrf_token: 'synthetic-session' } }));
      let release, complete;
      const pending = new Promise(resolve => { release = resolve; });
      const completed = new Promise(resolve => { complete = resolve; });
      t.after(() => release());
      let reads = 0;
      await page.route('**/mcp', async route => {
        const first = ++reads === 1;
        if (first) await pending;
        await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({
          ok: true, schema_version: 'client-portal.v1', portal: {
            slug: action === 'mismatched-slug' ? 'another-practice' : 'demo-practice',
            roadmap: { current_phase: 'research', phases: [{ slug: 'research', label: first ? 'Research' : 'Current research' }] }, materials: [],
          },
        }) }] } } }).catch(() => {});
        if (first) complete();
      });
      await page.goto(page.url() + '?mode=live');
      await page.getByLabel('Portal name').fill('demo-practice');
      await page.getByLabel('Portal password').fill('synthetic-password');
      const sent = page.waitForRequest(request => new URL(request.url()).pathname === '/mcp');
      await page.keyboard.press('Enter');
      await sent;
      assert.equal(await page.getByLabel('Portal password').inputValue(), '');
      assert.equal(await page.locator('#portalContent').innerText(), '');
      const lock = page.getByRole('button', { name: 'Lock portal' });
      if (action === 'focus-lock') await lock.focus();
      if (action === 'blur') await page.evaluate(() => document.activeElement.blur());
      if (['lock', 'obsolete'].includes(action)) {
        await lock.click();
        assert.equal(await page.getByLabel('Portal password').evaluate(element => element === document.activeElement), true);
      }
      if (action === 'pagehide') await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      if (action === 'invalidate') await page.evaluate(() => window.dispatchEvent(new Event('doctorcre-session-invalidated')));
      const heading = page.getByRole('heading', { name: 'Your transaction roadmap' });
      if (action === 'obsolete') {
        await page.getByLabel('Portal password').fill('synthetic-password');
        await page.keyboard.press('Enter');
        await heading.waitFor();
        await lock.focus();
      }
      release();
      await completed;
      if (['wait', 'focus-lock', 'blur'].includes(action)) await heading.waitFor();
      if (action === 'mismatched-slug') await page.getByText('Portal unavailable. Check the portal name and password, then try again.', { exact: true }).waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (['wait', 'blur'].includes(action)) assert.equal(await heading.evaluate(element => element === document.activeElement), true);
      else if (['focus-lock', 'obsolete'].includes(action)) assert.equal(await lock.evaluate(element => element === document.activeElement), true);
      else {
        assert.equal(await page.locator('#portalContent').innerText(), '');
        if (['lock', 'mismatched-slug'].includes(action)) assert.equal(await page.getByLabel('Portal password').evaluate(element => element === document.activeElement), true);
      }
      if (action === 'obsolete') assert.equal(await page.locator('#portalPhases').innerText(), 'Current research\nCurrent step');
      assert.equal(await page.getByLabel('Portal password').inputValue(), '');
    });
  }
});

test('live portal transport renders shared text safely and clears material before a refused portal switch', async t => {
  const page = await open(t);
  const requests = [];
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'demo-partner' }, csrf_token: 'synthetic-session' } }));
  await page.route('**/mcp', route => {
    const request = route.request().postDataJSON().params; requests.push(request);
    const portal = { slug: 'demo-practice', roadmap: { current_phase: 'research', phases: [
      { slug: 'research', label: 'Research' }, { slug: 'closed', label: 'Closed' },
    ] }, materials: [{ kind: 'document', title: '<img src=x onerror="window.injected=true">', content: '<script>window.injected=true</script>\nShared text.' }], internal_note: 'Synthetic private note' };
    const denied = request.arguments.slug !== 'demo-practice' || request.arguments.password !== 'synthetic-password';
    return route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify(denied
      ? { ok: false, error: 'portal_access_denied' } : { ok: true, schema_version: 'client-portal.v1', portal }) }] } } });
  });
  await page.goto(page.url() + '?mode=live');
  await page.getByLabel('Portal name').fill('demo-practice');
  await page.getByLabel('Portal password').fill('synthetic-password');
  await page.getByRole('button', { name: 'Open portal', exact: true }).click();
  await page.getByRole('heading', { name: 'Your transaction roadmap' }).waitFor();
  assert.equal(await page.locator('#portalContent script, #portalContent img').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.match(await page.locator('#portalContent').innerText(), /<script>window.injected=true<\/script>/);
  assert.doesNotMatch(await page.locator('body').innerText(), /Synthetic private note/);
  assert.doesNotMatch(page.url(), /synthetic-password/);
  assert.equal(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]).includes('synthetic-password')), false);
  await page.getByRole('button', { name: 'Lock portal' }).click();
  for (const { slug, password } of [
    { slug: 'demo-practice', password: 'wrong-password' },
    { slug: 'demo-practice', password: 'locked-password' },
    { slug: 'another-practice', password: 'synthetic-password' },
  ]) {
    await page.getByLabel('Portal name').fill(slug);
    await page.getByLabel('Portal password').fill(password);
    await page.getByRole('button', { name: 'Open portal', exact: true }).click();
    await page.getByText('Portal unavailable. Check the portal name and password, then try again.', { exact: true }).waitFor();
    assert.equal(await page.locator('#portalContent').innerText(), '');
    assert.equal(await page.getByLabel('Portal password').inputValue(), '');
    assert.equal(await page.getByLabel('Portal password').evaluate(element => element === document.activeElement), true);
  }
  await page.getByLabel('Portal name').fill('demo-practice');
  await page.getByLabel('Portal password').fill('synthetic-password');
  await page.getByRole('button', { name: 'Open portal', exact: true }).click();
  await page.getByRole('heading', { name: 'Your transaction roadmap' }).waitFor();
  assert.deepEqual(requests, [
    { name: 'read-client-portal', arguments: { slug: 'demo-practice', password: 'synthetic-password' } },
    { name: 'read-client-portal', arguments: { slug: 'demo-practice', password: 'wrong-password' } },
    { name: 'read-client-portal', arguments: { slug: 'demo-practice', password: 'locked-password' } },
    { name: 'read-client-portal', arguments: { slug: 'another-practice', password: 'synthetic-password' } },
    { name: 'read-client-portal', arguments: { slug: 'demo-practice', password: 'synthetic-password' } },
  ]);
});

test('locking cancels an in-flight read and page retirement clears portal content', async t => {
  const page = await open(t);
  await page.route('**/auth/session', route => route.fulfill({ json: { actor: { slug: 'demo-partner' }, csrf_token: 'synthetic-session' } }));
  let release, complete;
  const pending = new Promise(resolve => { release = resolve; });
  const completed = new Promise(resolve => { complete = resolve; });
  await page.route('**/mcp', async route => {
    await pending;
    await route.fulfill({ json: { result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, schema_version: 'client-portal.v1', portal: {
      slug: 'demo-practice', roadmap: { current_phase: 'research', phases: [{ slug: 'research', label: 'Research' }] }, materials: [],
    } }) }] } } }).catch(() => {}).finally(complete);
  });
  await page.goto(page.url() + '?mode=live');
  await page.getByLabel('Portal name').fill('demo-practice');
  await page.getByLabel('Portal password').fill('synthetic-password');
  const sent = page.waitForRequest(request => new URL(request.url()).pathname === '/mcp');
  await page.getByRole('button', { name: 'Open portal', exact: true }).click();
  await sent;
  await page.getByRole('button', { name: 'Lock portal' }).click();
  release();
  await completed;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.getByLabel('Portal password').waitFor();
  assert.equal(await page.locator('#portalContent').innerText(), '');
  await page.goto(page.url().split('?')[0]);
  await page.getByLabel('Portal name').fill('demo-practice');
  await page.getByLabel('Portal password').fill('demo-portal');
  await page.getByRole('button', { name: 'Open portal', exact: true }).click();
  await page.getByRole('heading', { name: 'Your transaction roadmap' }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  assert.equal(await page.locator('#portalContent').innerText(), '');
  assert.equal(await page.getByLabel('Portal password').inputValue(), '');
});
