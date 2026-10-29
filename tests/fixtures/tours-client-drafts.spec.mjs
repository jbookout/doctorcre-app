import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const clientId = '11111111-1111-4111-8111-111111111111';
const client = { id: clientId, name: 'Synthetic Practice', city: 'Synthetic City', state: 'FL', vertical: 'Synthetic specialty', notes: 'Synthetic client notes' };

const otherClientId = '22222222-2222-4222-8222-222222222222';
const otherClient = { ...client, id: otherClientId, name: 'Synthetic Other Practice' };

async function routePlanner(page, state) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost') return route.abort();
    if (url.pathname === '/auth/session') return route.fulfill({ json: { actor: { slug: 'joe' }, csrf_token: 'synthetic-fixture' } });
    if (url.pathname === `/api/v1/business/clients/${clientId}` && state.failDetail) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    if (url.pathname.startsWith('/api/')) {
      const data = url.pathname === '/api/tours/library' ? { tours: [] }
        : url.pathname === `/api/v1/business/clients/${clientId}` ? { record: state.client }
        : url.pathname === `/api/v1/business/clients/${otherClientId}` ? { record: otherClient }
        : url.pathname === '/api/v1/business/clients' ? { rows: [state.client, otherClient], page: 1, page_count: 1 } : {};
      return route.fulfill({ json: { data, csrf_token: 'synthetic-fixture', actor: { slug: 'joe' }, items: [], counts: {} } });
    }
    const file = url.pathname === '/tours' ? 'tours/index.html' : url.pathname.slice(1);
    try {
      const body = await readFile(new URL('../../' + file, import.meta.url));
      return route.fulfill({ body, contentType: /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html' });
    } catch { return route.fulfill({ status: 404, body: '' }); }
  });
}

for (const theme of ['light', 'dark']) {
  test(`Search field values remain readable at 390 ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await routePlanner(page, { failDetail: false, client: { ...client } });
    await page.goto('http://localhost/tours');
    await expect(page.locator('#planner-updated')).toContainText('Updated');
    await page.locator('#space-client').selectOption(clientId);
    const area = page.locator('#space-area');
    const transaction = page.locator('#space-transaction');
    await expect(area).toHaveValue('Synthetic City, FL');
    for (const control of [area, transaction]) {
      const fits = await control.evaluate(element => {
        const style = getComputedStyle(element);
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const text = element instanceof HTMLSelectElement ? element.selectedOptions[0].textContent : element.value;
        const available = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - (element instanceof HTMLSelectElement ? 20 : 0);
        return context.measureText(text).width <= available;
      });
      expect(fits, `${await control.getAttribute('id')} text fits`).toBe(true);
    }
    await area.fill('A deliberately long synthetic area name that cannot fit in a phone field');
    await expect(area).toHaveAttribute('title', 'A deliberately long synthetic area name that cannot fit in a phone field');
    await expect(area).toHaveCSS('text-overflow', 'ellipsis');
    await page.locator('#space-title').click();
    await page.screenshot({ path: testInfo.outputPath('planner.png'), fullPage: true });
  });
}

for (const width of [390, 820, 1440]) for (const theme of ['light', 'dark']) {
  test(`Tour client drafts and Research work at ${width} ${theme}`, async ({ page }, testInfo) => {
    const state = { failDetail: false, client: { ...client } };
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await routePlanner(page, state);
    await page.goto('http://localhost/tours');
    await expect(page.locator('#planner-updated')).toContainText('Updated');
    if (width === 820) {
      const plan = await page.locator('.plan-card').boundingBox();
      const search = await page.locator('.space-card').boundingBox();
      expect(search.x).toBe(plan.x);
      expect(search.y).toBeGreaterThan(plan.y + plan.height);
    }
    await page.locator('#space-client').selectOption(clientId);
    await expect(page.locator('#space-area')).toHaveValue('Synthetic City, FL');
    await page.locator('#space-area').fill('Synthetic saved region');
    await page.locator('#space-minSize').fill('2100');
    await page.locator('#space-use').fill('');
    await page.locator('#space-client').selectOption('');
    await page.locator('#space-client').selectOption(clientId);
    await expect(page.locator('#space-minSize')).toHaveValue('2100');
    await expect(page.locator('#space-use')).toHaveValue('');
    state.failDetail = true;
    await page.locator('#plan-client').selectOption(clientId);
    await expect(page.locator('#plan-client-retry')).toBeVisible();
    await page.locator('#plan-name').fill('Synthetic retained tour');
    await page.locator('#review-packet').click();
    await expect(page.locator('#tour-dialog')).not.toBeVisible();
    await expect(page.locator('#plan-message')).toContainText('Client details temporarily unavailable.');
    state.failDetail = false;
    await page.locator('#plan-client-retry').click();
    await expect(page.locator('#plan-client-retry')).toBeHidden();
    await expect(page.locator('#plan-name')).toHaveValue('Synthetic retained tour');
    await expect(page.locator('#plan-area')).toHaveValue('Synthetic saved region');
    if (width === 390) {
      const actions = page.locator('.planner-grid .widget-actions button');
      await expect(actions).toHaveCount(4);
      for (const button of await actions.all()) {
        const lines = await button.evaluate(element => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getClientRects().length;
        });
        expect(lines, `${await button.innerText()} should fit on one line`).toBe(1);
      }
    }
    await page.locator('#plan-purpose').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('client-draft.png'), fullPage: true });
    await page.locator('#plan-purpose').selectOption('research');
    await expect(page.locator('#plan-client-picker')).toBeHidden();
    await page.locator('#plan-name').fill('Synthetic Research');
    await page.locator('#review-packet').click();
    await expect(page.locator('#tour-dialog')).toBeVisible();
    await expect(page.locator('#detail-content')).toContainText('Research');
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.locator('#plan-purpose')).toHaveValue('research');
    await expect(page.locator('#plan-name')).toHaveValue('Synthetic Research');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#plan-purpose').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('research-draft.png'), fullPage: true });
  });
}


test('Tour managed notes refresh after client reselection while typed notes survive', async ({ page }) => {
  const state = { failDetail: false, client: { ...client } };
  await routePlanner(page, state);
  await page.goto('http://localhost/tours');
  await expect(page.locator('#planner-updated')).toContainText('Updated');
  await page.locator('#plan-client').selectOption(clientId);
  await expect(page.locator('#plan-notes')).toHaveValue('Synthetic client notes');
  await page.locator('#plan-client').selectOption(otherClientId);
  await expect(page.locator('#plan-name')).toHaveValue('Synthetic Other Practice · Tour');
  state.client.notes = 'Synthetic refreshed source notes';
  await page.locator('#plan-client').selectOption(clientId);
  await expect(page.locator('#plan-message')).toHaveText('');
  await page.getByRole('button', { name: 'Refresh tours', exact: true }).click();
  await expect(page.locator('#plan-notes')).toHaveValue('Synthetic refreshed source notes');
  await page.reload();
  await expect(page.locator('#plan-client')).toHaveValue(clientId);
  state.client.notes = 'Synthetic source notes after reload';
  await page.getByRole('button', { name: 'Refresh tours', exact: true }).click();
  await expect(page.locator('#plan-notes')).toHaveValue('Synthetic source notes after reload');
  await page.locator('#plan-notes').fill('Synthetic typed notes');
  await page.locator('#plan-client').selectOption(otherClientId);
  await expect(page.locator('#plan-name')).toHaveValue('Synthetic Other Practice · Tour');
  state.client.notes = 'Synthetic newest source notes';
  state.client.name = 'Synthetic refreshed practice';
  await page.locator('#plan-client').selectOption(clientId);
  await expect(page.locator('#plan-message')).toHaveText('');
  await page.getByRole('button', { name: 'Refresh tours', exact: true }).click();
  await expect(page.locator('#plan-name')).toHaveValue('Synthetic Practice · Tour');
  await page.getByRole('button', { name: 'Use current name', exact: true }).click();
  await expect(page.locator('#plan-name')).toHaveValue('Synthetic refreshed practice · Tour');
  await expect(page.locator('#plan-notes')).toHaveValue('Synthetic typed notes');
});

test('Search cleared space type stays blank in Plan after prefill and refresh', async ({ page }) => {
  const state = { failDetail: false, client: { ...client } };
  await routePlanner(page, state);
  await page.goto('http://localhost/tours');
  await expect(page.locator('#planner-updated')).toContainText('Updated');
  await page.locator('#space-client').selectOption(clientId);
  await expect(page.locator('#space-use')).toHaveValue('Synthetic specialty');
  await page.locator('#space-use').fill('');
  await page.locator('#plan-client').selectOption(clientId);
  await expect(page.locator('#plan-name')).toHaveValue('Synthetic Practice · Tour');
  await expect(page.locator('#space-use')).toHaveValue('');
  await expect(page.locator('#plan-use')).toHaveValue('');
  state.client.notes = 'Synthetic notes after refresh';
  await page.getByRole('button', { name: 'Refresh tours', exact: true }).click();
  await expect(page.locator('#plan-notes')).toHaveValue('Synthetic notes after refresh');
  await expect(page.locator('#plan-use')).toHaveValue('');
  await page.reload();
  await expect(page.locator('#plan-name')).toHaveValue('Synthetic Practice · Tour');
  await expect(page.locator('#plan-use')).toHaveValue('');
  state.client.notes = 'Synthetic notes after reload';
  await page.getByRole('button', { name: 'Refresh tours', exact: true }).click();
  await expect(page.locator('#plan-notes')).toHaveValue('Synthetic notes after reload');
  await expect(page.locator('#plan-use')).toHaveValue('');
});

for (const width of [390, 820, 1440]) for (const theme of ['light', 'dark']) {
  test(`Search constraints reach only their own packet at ${width} ${theme}`, async ({ page }, testInfo) => {
    const state = { failDetail: false, client: { ...client } };
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await routePlanner(page, state);
    await page.goto('http://localhost/tours');
    await expect(page.locator('#planner-updated')).toContainText('Updated');
    await page.locator('#space-client').selectOption(clientId);
    await expect(page.locator('#space-area')).toHaveValue('Synthetic City, FL');
    for (const [field, value] of Object.entries({ area: 'Synthetic saved region', minSize: '2100', maxSize: '3500', budget: '28', availableBy: '2027-02-01', parking: '12 spaces', requirements: 'Ground floor <script>inert</script>' })) await page.locator(`#space-${field}`).fill(value);
    await page.locator('#space-rentBasis').selectOption('sf_year');
    await page.locator('#space-transaction').selectOption('Lease');
    await page.getByRole('button', { name: 'Plan from search', exact: true }).click();
    await expect(page.locator('#plan-client')).toHaveValue(clientId);
    await expect(page.locator('#plan-name')).toBeFocused();
    await expect(page.locator('#plan-area')).toHaveValue('Synthetic saved region');
    await page.locator('#review-packet').click();
    const criteria = page.locator('#packet-search-criteria');
    await expect(criteria.locator('dd')).toHaveText(['Synthetic saved region', 'Synthetic specialty', '2100', '3500', '28', '$/SF/year', 'Lease', '2027-02-01', '12 spaces', 'Ground floor <script>inert</script>']);
    await expect(criteria.locator('script')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('search-packet.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await page.locator('#space-client').selectOption(otherClientId);
    await expect(page.locator('#space-client-retry')).toBeHidden();
    await page.locator('#space-minSize').fill('9999');
    await page.locator('#review-packet').click();
    await expect(criteria).toContainText('2100');
    await expect(criteria).not.toContainText('9999');
    await page.keyboard.press('Escape');
    await page.locator('#space-client').selectOption(clientId);
    await expect(page.locator('#space-minSize')).toHaveValue('2100');
    await page.locator('#space-requirements').fill('');
    await page.reload();
    await expect(page.locator('#planner-updated')).toContainText('Updated');
    await expect(page.locator('#space-requirements')).toHaveValue('');
    await page.locator('#review-packet').click();
    await expect(criteria).toContainText('2100');
    await expect(criteria).not.toContainText('Must-haves');
    await page.keyboard.press('Escape');
    await page.locator('#space-client').selectOption('');
    await page.locator('#space-area').fill('Synthetic Research region');
    await page.locator('#space-minSize').fill('800');
    await page.getByRole('button', { name: 'Plan from search', exact: true }).click();
    await expect(page.locator('#plan-purpose')).toHaveValue('research');
    await expect(page.locator('#plan-client-picker')).toBeHidden();
    await page.locator('#review-packet').click();
    await expect(criteria).toContainText('Synthetic Research region');
    await expect(criteria).toContainText('800');
    await expect(criteria).not.toContainText('2100');
    await page.screenshot({ path: testInfo.outputPath('research-search-packet.png'), fullPage: true });
  });
}

for (const theme of ['light', 'dark']) {
  test(`Client record updates and name choices fit a phone in ${theme}`, async ({ page }, testInfo) => {
    const state = { failDetail: false, client: { ...client } };
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await routePlanner(page, state);
    await page.goto('http://localhost/tours');
    await expect(page.locator('#planner-updated')).toContainText('Updated');
    await page.locator('#plan-client').selectOption(clientId);
    await expect(page.locator('#plan-name')).toHaveValue('Synthetic Practice · Tour');
    await page.locator('#space-client').selectOption(clientId);
    await expect(page.locator('#space-area')).toHaveValue('Synthetic City, FL');
    await page.locator('#plan-area').fill('Synthetic chosen region');
    state.client = { ...state.client, name: 'Synthetic updated practice', city: 'Synthetic refreshed city', notes: 'Synthetic refreshed notes <script>inert</script>' };
    await page.getByRole('button', { name: 'Refresh tours', exact: true }).click();
    await expect(page.locator('#plan-name')).toHaveValue('Synthetic Practice · Tour');
    await expect(page.locator('#plan-notes')).toHaveValue(state.client.notes);
    await expect(page.locator('#plan-area')).toHaveValue('Synthetic chosen region');
    await page.locator('#review-packet').click();
    await expect(page.locator('#tour-dialog')).not.toBeVisible();
    await expect(page.locator('#keep-client-name')).toBeFocused();
    await page.locator('#plan-client-name-review').evaluate(element => element.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: testInfo.outputPath('client-name-compare-390.png') });
    for (const id of ['plan', 'space']) {
      const updates = page.locator(`#${id}-client-updates`);
      await updates.getByText('Review field changes', { exact: true }).click();
      await expect(updates.locator('script')).toHaveCount(0);
      await updates.evaluate(element => element.scrollIntoView({ block: 'center' }));
      const box = await updates.boundingBox();
      expect(box.y).toBeGreaterThanOrEqual(60);
      expect(box.y + box.height).toBeLessThanOrEqual(732);
      await page.screenshot({ path: testInfo.outputPath(`${id}-client-updates-390.png`) });
    }
    const controls = page.locator('#plan-client-name-review button');
    for (const control of await controls.all()) {
      const box = await control.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      const lines = await control.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); return range.getClientRects().length; });
      expect(lines).toBe(1);
    }
    await page.getByRole('button', { name: 'Keep draft name', exact: true }).click();
    await expect(page.locator('#plan-client-name-review')).toBeHidden();
    await expect(page.locator('#plan-name')).toHaveValue('Synthetic Practice · Tour');
    await page.reload();
    await expect(page.locator('#planner-updated')).toContainText('Updated');
    await expect(page.locator('#plan-name')).toHaveValue('Synthetic Practice · Tour');
    await expect(page.locator('#plan-client-name-review')).toBeHidden();
    state.client.name = 'Synthetic latest practice';
    await page.locator('#plan-client').selectOption(otherClientId);
    await expect(page.locator('#plan-name')).toHaveValue('Synthetic Other Practice · Tour');
    await expect(page.locator('#plan-client-updates')).toBeHidden();
    await page.locator('#plan-client').selectOption(clientId);
    await expect(page.locator('#plan-name')).toHaveValue('Synthetic Practice · Tour');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
