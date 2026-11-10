import { test, expect, type Locator, type Page, type Response } from '@playwright/test';

import { admitItems, clearAdmission, inboxItems } from './privacy';

type Completion = { action: string; event: string };
const completions = new WeakMap<Page, Completion>();
const rpc = (name: string) => (response: Response) => new URL(response.url()).pathname === '/mcp' && response.request().postDataJSON()?.params?.name === name;
async function receipt(response: Response): Promise<Record<string, unknown>> {
  const envelope = await response.json();
  expect(response.ok() && envelope.result?.isError !== true).toBe(true);
  const payload: unknown = JSON.parse(envelope.result.content.find((entry: { type: string }) => entry.type === 'text').text);
  expect(typeof payload === 'object' && payload !== null).toBe(true);
  return payload as Record<string, unknown>;
}

export const designated = /^(?:\[test\]|test\b|qa\b)/i;
export const marker = (number: number) => new RegExp(`^(?:\\[test\\]|test|qa)\\s+walk[ -]0?${number}(?:\\b|[ :])`, 'i');
export function needs(missing: boolean, what: string): void {
  test.skip(missing, `needs designated test record: ${what}`);
}
export async function visible(locator: Locator): Promise<void> {
  await expect.poll(() => locator.isVisible()).toBe(true);
}
export async function home(page: Page): Promise<void> {
  await page.goto('/');
  await visible(page.getByRole('heading', { name: 'Welcome home.', exact: true }));
  await expect.poll(async () => !(await page.locator('.inbox-health').innerText()).includes('Updating')).toBe(true);
  expect(await page.locator('.inbox-health').innerText().then(text => !/unavailable/i.test(text))).toBe(true);
  const expand = page.getByRole('button', { name: /^See all \d+$/ });
  for (let n = 0; n < 6 && await expand.count(); n++) await expand.first().click();
}
export async function card(page: Page, number?: number): Promise<Locator> {
  clearAdmission(page.context());
  await home(page);
  const row = page.locator('[data-inbox-row]').filter({ has: page.locator('h3 a').filter({ hasText: number ? marker(number) : designated }) }).first();
  needs(await row.count() === 0, number ? `Home card named TEST WALK ${number}` : 'Home card marked TEST or QA');
  await visible(row);
  if (number !== undefined) {
    const candidates = page.locator('[data-inbox-row]').filter({ has: page.locator('h3 a').filter({ hasText: marker(number) }) });
    const ids = await candidates.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-inbox-row')));
    const snapshot = await inboxItems(page.context());
    const items = snapshot.filter(item => ids.includes(item.item_id) && marker(number).test(item.title));
    needs(items.length !== ids.length || items.some(item => !item.deal_id) || new Set(items.map(item => item.deal_id)).size !== 1, `TEST WALK ${number} cards with canonical owning deal IDs`);
    const check = await page.context().newPage();
    try {
      await check.goto('/deals');
      await visible(check.locator('#listView'));
      await check.locator('#listView').click();
      await expect.poll(() => check.locator('#boardStatusLabel').innerText().then(text => !/updating/i.test(text))).toBe(true);
      expect(await check.locator('#boardAsOf').innerText()).not.toMatch(/unavailable/i);
      const deals = await check.locator('[data-open-deal].deal-link').filter({ hasText: marker(number) }).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-open-deal')));
      needs(items.some(item => !deals.includes(item.deal_id)), `owning deal ID matching designated TEST WALK ${number} deal`);
    } finally { await check.close(); }
    const completion = ['complete-one-action', 'reopen-one-action'];
    const disposition = ['settle-home-inbox', 'unsettle-home-inbox', 'snooze-home-inbox'];
    const verbs = number === 3 ? [...completion, ...disposition] : number === 10 || number === 33 ? disposition : number === 15 ? [...completion, 'set-home-waiting', 'clear-home-waiting'] : [1, 12, 13, 14].includes(number) ? completion : [];
    needs(verbs.length === 0, `TEST WALK ${number} mutation with proven canonical record ownership`);
    admitItems(page.context(), items, verbs);
  }
  return row;
}
export async function deal(page: Page, number?: number): Promise<string> {
  await page.goto('/deals');
  await visible(page.locator('#listView'));
  await page.locator('#listView').click();
  await expect.poll(() => page.locator('#boardStatusLabel').innerText().then(text => !/updating/i.test(text))).toBe(true);
  expect(await page.locator('#boardAsOf').innerText()).not.toMatch(/unavailable/i);
  const opener = page.locator('[data-open-deal].deal-link').filter({ hasText: number ? marker(number) : designated }).first();
  needs(await opener.count() === 0, number ? `deal named TEST WALK ${number}` : 'deal marked TEST or QA');
  const id = await opener.getAttribute('data-open-deal');
  expect(Boolean(id)).toBe(true);
  await opener.click();
  await visible(page.locator('#recordPanel'));
  await visible(page.locator('.deal-opening-snapshot'));
  return id!;
}
export async function tab(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('tab', { name }).click();
  if (name.test('Tours')) {
    const tours = page.locator('#workspace-tours');
    await expect(tours.locator('.deal-tour-list').or(tours.getByText(/^No tours for this deal\./)).or(tours.getByText(/^Tours unavailable\./))).toBeVisible();
    await expect(tours).not.toContainText('Tours unavailable.');
  }
}
export async function undo(page: Page): Promise<void> {
  const button = page.locator('.inbox-notice').getByRole('button', { name: /^Undo/ }).last();
  await visible(button);
  const completion = completions.get(page);
  const pending = completion ? page.waitForResponse(rpc('reopen-one-action')) : null;
  await button.click();
  if (pending && completion) {
    const response = await pending;
    const args = response.request().postDataJSON().params.arguments;
    expect(args.action_id === completion.action && args.completion_event_id === completion.event).toBe(true);
    const stored = await receipt(response);
    expect(stored.action_id === completion.action && stored.completion_event_id === completion.event && stored.status === 'open').toBe(true);
    completions.delete(page);
  }
  await expect.poll(() => page.locator('.inbox-notice').innerText().then(text => text.includes('Undone.'))).toBe(true);
}
export async function complete(page: Page, row: Locator): Promise<string> {
  const id = await row.getAttribute('data-inbox-row');
  const pending = page.waitForResponse(rpc('complete-one-action'));
  const review = row.locator('.home-inline-review');
  await (await review.count() ? review : row).getByRole('button', { name: 'Mark done', exact: true }).click();
  const response = await pending;
  const args = response.request().postDataJSON().params.arguments;
  const stored = await receipt(response);
  expect(stored.ok === true && stored.status === 'done' && stored.action_id === args.action_id).toBe(true);
  expect(typeof stored.completion_event_id === 'string' && /^[0-9a-f-]{36}$/i.test(stored.completion_event_id)).toBe(true);
  completions.set(page, { action: args.action_id, event: stored.completion_event_id as string });
  await visible(page.locator('.inbox-notice').getByRole('button', { name: /^Undo/ }).last());
  return id!;
}
export async function reloadCard(page: Page, id: string): Promise<Locator> {
  await page.goto(`/inbox/card/${encodeURIComponent(id)}`);
  const row = page.locator('[data-inbox-row]').filter({ has: page.locator('a[aria-current="true"]') });
  await visible(row);
  return row;
}
export async function noOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
