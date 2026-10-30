import { test, expect } from '@playwright/test';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
let server;
test.beforeAll(async () => { server = await startFixtureServer(); });
test.afterAll(async () => { await server?.stop(); });
for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`partner resolves a three-document conflict at ${width} in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
    await page.goto(`${server.url}/deals?deal=d14`);
    const terms = page.getByRole('region', { name: 'Terms', exact: true });
    await expect(terms.getByRole('heading', { name: 'Base rent', exact: true })).toBeVisible();
    await expect(terms.locator('.fact-observation')).toHaveCount(3);
    await expect(terms).toContainText('Demo Lease.pdf');
    await expect(terms).toContainText('Demo Counteroffer.pdf');
    await expect(terms).toContainText('Demo Amendment.pdf');
    await expect(terms).toContainText('Excerpt no longer available');
    await expect(terms).toContainText('No canonical value recorded');
    await expect(terms).toContainText('OCR · verify');
    await terms.scrollIntoViewIfNeeded();
    await page.evaluate(() => document.fonts.ready);
    const path = testInfo.outputPath(`terms-${width}-${theme}.png`);
    await page.evaluate(() => {
      const terms = document.querySelector('#panelTerms');
      const header = document.querySelector('.workspace-header');
      const offset = getComputedStyle(header).position === 'sticky' ? header.getBoundingClientRect().height : 0;
      const topbar = document.querySelector('.app-layout-tabbar').getBoundingClientRect().height;
      scrollTo({ top: scrollY + terms.getBoundingClientRect().top - offset - topbar - 16, behavior: 'instant' });
    });
    expect(await terms.getByRole('heading', { name: 'Terms', exact: true }).evaluate(node => node.getBoundingClientRect().top)).toBeGreaterThan(56);
    await page.screenshot({ path, animations: 'disabled' });
    await testInfo.attach('Three sourced values', { path, contentType: 'image/png' });
    const review = terms.locator('form[data-fact-review]');
    await review.getByLabel('Choose a value').selectOption({ label: '$26/SF/yr · NNN · Demo Amendment.pdf' });
    await review.getByLabel('Reason').fill('Demo amendment supersedes the earlier documents.');
    await review.getByRole('button', { name: 'Save review', exact: true }).click();
    await expect(terms.locator('.fact-canonical')).toContainText('$26/SF/yr');
    await expect(terms).toContainText('Review saved');
    await expect(terms.locator('.fact-observation')).toHaveCount(3);
    const edit = terms.getByRole('button', { name: 'Review term', exact: true });
    await edit.click();
    await review.getByLabel('Decision').selectOption('correct');
    await review.getByLabel('Value', { exact: true }).fill('27');
    await review.getByLabel('Document', { exact: true }).selectOption({ label: 'Demo Amendment.pdf' });
    await review.getByLabel('First page').fill('3');
    await review.getByLabel('Last page').fill('3');
    await review.getByLabel('Cited text').fill('Demo corrected rent is $27 per square foot.');
    await review.getByLabel('Reason').fill('Demo reviewed correction.');
    await review.getByRole('button', { name: 'Save review', exact: true }).click();
    await expect(terms.locator('.fact-canonical')).toContainText('$27/SF/yr');
    await terms.getByText('Record a term', { exact: true }).click();
    const record = terms.locator('form[data-fact-record]');
    if (width === 1440) {
      const rows = await record.evaluate(form => [...form.querySelectorAll('[name=page_start], [name=page_end]')].map(input => input.parentElement.offsetTop));
      expect(rows[1]).toBe(rows[0]);
    }
    await record.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`record-${width}-${theme}.png`), animations: 'disabled' });
    await record.getByLabel('Value', { exact: true }).fill('28');
    await record.getByLabel('Cited text').fill('Demo later clause.');
    await record.getByRole('button', { name: 'Record term', exact: true }).click();
    await expect(terms.locator('.fact-observation')).toHaveCount(5);
    await expect(record.locator('[data-write-status]')).not.toHaveText('Saving…');
    await review.getByLabel('Decision').selectOption('reject');
    await review.getByLabel('Reason').fill('Demo later clause does not apply.');
    await review.getByRole('button', { name: 'Save review', exact: true }).click();
    await expect(terms.locator('.fact-canonical')).toContainText('$27/SF/yr');
    await expect(terms).toContainText('Review saved');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => {
      for (const node of document.querySelectorAll('body *')) {
        if (!node.closest('#panelTerms') && ['fixed', 'sticky'].includes(getComputedStyle(node).position)) node.style.visibility = 'hidden';
      }
    });
    await terms.screenshot({ path: testInfo.outputPath(`terms-${width}-${theme}-resolved.png`), animations: 'disabled' });
  });
}

test('stale evidence refreshes the review without applying the old decision', async ({ page }) => {
  await page.goto(`${server.url}/deals?deal=d14`);
  const terms = page.getByRole('region', { name: 'Terms', exact: true });
  const review = terms.locator('form[data-fact-review]');
  await review.getByLabel('Decision', { exact: true }).selectOption('reject');
  await review.getByLabel('Reason').fill('Demo original review.');
  await page.getByRole('button', { name: 'Refresh deal', exact: true }).click();
  await expect(review.getByLabel('Reason')).toHaveValue('Demo original review.');
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const item = (await state.client.listFactReview({ entity_ref: 'd14' })).items[0];
    await state.client.recordHumanFact({ entity_ref: 'd14', idempotency_key: crypto.randomUUID(), observation: {
      fact_key: 'base_rent_per_sf', value: '29', unit: 'USD/SF/year', expense_basis: 'nnn',
      source: { document_ref: item.observations[0].source.document_ref, page_start: 4, page_end: 4, cited_text: 'Demo new evidence.' },
    } });
  });
  await review.getByRole('button', { name: 'Save review' }).click();
  await expect(terms).toContainText('Terms changed since you opened this review');
  await expect(terms.locator('.fact-observation')).toHaveCount(4);
  await expect(terms.locator('.fact-canonical')).toContainText('No canonical value recorded');
  await expect(review.getByLabel('Reason')).toHaveValue('Demo original review.');
});

test('unknown save retries the identical request and freezes its reviewed fields', async ({ page }) => {
  await page.goto(`${server.url}/deals?deal=d14`);
  const terms = page.getByRole('region', { name: 'Terms', exact: true });
  const review = terms.locator('form[data-fact-review]');
  await review.getByLabel('Decision', { exact: true }).selectOption('reject');
  await review.getByLabel('Reason').fill('Demo keep the canonical term.');
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const send = state.client.resolveFactReview.bind(state.client);
    window.factRequests = [];
    state.client.resolveFactReview = async args => {
      window.factRequests.push(structuredClone(args));
      const receipt = await send(args);
      if (window.factRequests.length === 1) throw new TypeError('Demo interrupted response');
      return receipt;
    };
  });
  await review.getByRole('button', { name: 'Save review' }).click();
  await expect(review.getByRole('button', { name: 'Check outcome' })).toBeVisible();
  await expect(review.getByLabel('Reason')).toBeDisabled();
  await expect(terms.getByRole('button', { name: 'Refresh terms' })).toBeDisabled();
  await review.getByRole('button', { name: 'Check outcome' }).click();
  await expect(terms).toContainText('Review saved');
  const requests = await page.evaluate(() => window.factRequests);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
});

test('missing attachment metadata does not turn prepared documents into source choices', async ({ page }) => {
  await page.goto(`${server.url}/deals`);
  await expect(page.locator('.card-open:visible').first()).toBeVisible();
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const read = state.client.getDeal.bind(state.client);
    state.client.getDeal = async id => {
      const detail = await read(id); delete detail.attachments;
      return { ...detail, documents: [{ id: 'demo-prepared-document', note: 'Demo prepared document' }] };
    };
  });
  await page.locator('.card-open:visible').filter({ hasText: 'Demo Surgical Practice' }).first().click();
  const terms = page.getByRole('region', { name: 'Terms', exact: true });
  await expect(terms).toContainText('Stored documents unavailable');
  await expect(terms).toContainText('Document name unavailable');
  await expect(terms.locator('[data-fact-record]')).toHaveCount(0);
  await expect(terms.getByLabel('Decision').locator('option[value="correct"]')).toHaveAttribute('disabled', '');
});

test('a refused record preserves its selected unit and source for correction', async ({ page }) => {
  await page.goto(`${server.url}/deals?deal=d14`);
  const terms = page.getByRole('region', { name: 'Terms', exact: true });
  await terms.getByText('Record a term', { exact: true }).click();
  const record = terms.locator('form[data-fact-record]');
  await record.getByLabel('Term', { exact: true }).selectOption('term_months');
  await record.getByLabel('Value', { exact: true }).fill('5');
  await record.getByLabel('Unit', { exact: true }).selectOption('years');
  await record.getByLabel('Cited text').fill('Demo lease term is five years.');
  await page.evaluate(async () => {
    const { state } = await import('/js/pipeline.js');
    const send = state.client.recordHumanFact.bind(state.client); let first = true;
    state.client.recordHumanFact = async args => {
      if (first) { first = false; throw Object.assign(new Error('Demo refusal'), { payload: { error: 'validation_error' } }); }
      return send(args);
    };
  });
  await record.getByRole('button', { name: 'Record term', exact: true }).click();
  await expect(record).toContainText('Term not saved');
  await expect(record.getByLabel('Unit', { exact: true })).toHaveValue('years');
  await record.getByRole('button', { name: 'Record term', exact: true }).click();
  await expect(terms).toContainText('Term recorded for review');
  const leaseTerm = terms.locator('[data-fact-key="term_months"]');
  await expect(leaseTerm.locator('.fact-observation')).toContainText('5 years');
  const review = leaseTerm.locator('form');
  await review.getByLabel('Choose a value').selectOption({ index: 1 });
  await review.getByLabel('Reason').fill('Demo five-year lease.');
  await review.getByRole('button', { name: 'Save review' }).click();
  await expect(leaseTerm.locator('.fact-canonical')).toContainText('60 months');
});


test('distinct decimal term values remain distinct when displayed', async ({ page }) => {
  await page.goto(`${server.url}/deals?deal=d14`);
  const terms = page.getByRole('region', { name: 'Terms', exact: true });
  await terms.getByText('Record a term', { exact: true }).click();
  const record = terms.locator('form[data-fact-record]');
  for (const value of ['24.375', '24.38', '12345678901234567890.123456789012345678']) {
    await record.getByLabel('Value', { exact: true }).fill(value);
    await record.getByLabel('Cited text').fill('Demo sourced value.');
    await record.getByRole('button', { name: 'Record term', exact: true }).click();
    await expect(record.locator('[data-write-status]')).not.toHaveText('Saving…');
  }
  await expect(terms).toContainText('$24.375/SF/yr');
  await expect(terms).toContainText('$24.38/SF/yr');
  await expect(terms).toContainText('$12,345,678,901,234,567,890.123456789012345678/SF/yr');
});
