// Journey 2, file a call and see the deal update (WR629). The call is filed
// through the real Call Mode path into the real record layer; nothing the app
// reads here is stubbed.
import type { Page } from '@playwright/test';
import { test, expect, type FiledCall } from './harness';

test.describe.configure({ mode: 'serial' });

const BAYSIDE = 'Synthetic Bayside Dental Relocation';
const HARBOR = 'Synthetic Harbor Clinic Expansion';
const PINECREST = 'Synthetic Pinecrest Lab Lease';
let guideCall: FiledCall | undefined;

// The companion's capture and post-call logs travel with any failure.
async function filed(call: FiledCall) {
  await test.info().attach('call-mode logs', { body: call.logs(), contentType: 'text/plain' });
  return call;
}

// Home's call reads have answered, so an empty list means empty, not loading.
async function openHome(page: Page) {
  const read = (name: string) => page.waitForResponse(response => response.url().endsWith('/mcp')
    && response.request().postDataJSON()?.params?.name === name && response.ok());
  const reads = Promise.all([read('read-call-outcomes'), read('read-post-call-followups')]);
  await page.goto('/?mode=live');
  await reads;
}

test('a call whose filing fails is not shown as filed, and Home says it needs attention', async ({ signedIn: page, carr, companion }) => {
  await companion(await filed(await carr.fileCall({ distiller: 'failing' })));
  await openHome(page);
  await expect(page.locator('#homeCallTasks')).toContainText('No call follow-ups');
  await expect(page.locator('.call-outcome')).toHaveCount(0);

  await page.getByRole('button', { name: 'Call mode' }).click();
  const status = page.locator('#postCallStatus');
  await expect(status).toContainText('The post-call report needs attention.');
  await expect(status).toContainText('Local processing stopped: local post-call distiller failed');
});

test('a filed call shows its decisions and tasks on Home and updates the deal page', async ({ signedIn: page, carr }) => {
  guideCall = await filed(await carr.fileCall());
  await openHome(page);

  // The decisions it applied, each with what was said.
  const outcome = page.locator('.call-outcome');
  await expect(outcome).toHaveCount(1);
  await expect(outcome.locator('h4')).toHaveText(/^Applied from the .+ pipeline call$/);
  const change = (deal: string, text: string) => outcome.locator('li').filter({ hasText: deal }).filter({ hasText: text });
  await expect(change(BAYSIDE, 'Phase moved to Negotiation, started Oct 20'))
    .toContainText('The LOI was signed on October 20, 2026, so Bayside moves to negotiation');
  await expect(change(BAYSIDE, 'Next step: Send the lease draft to the landlord · due Nov 6')).toBeVisible();
  await expect(change(HARBOR, 'Next step: Schedule the second walkthrough · due Nov 3')).toBeVisible();
  await expect(outcome, 'the disputed deal stays a card, not a change').not.toContainText(PINECREST);

  // The tasks and draft it raised, each from the call.
  const task = page.locator('#homeCallTasks article').filter({ hasText: 'Call the Harbor lender' });
  await expect(task.locator('.home-call-source')).toHaveText(new RegExp(`^From your call with ${HARBOR}, `));
  await expect(task.getByRole('button', { name: 'Add Dell task' })).toBeVisible();
  const draft = page.locator('#homeCallTasks article').filter({ hasText: 'Bayside lease update' });
  await expect(draft.locator('.home-call-source')).toHaveText(new RegExp(`^From your call with ${BAYSIDE}, `));

  // The deal page carries the updated fields and the call's activity.
  await page.goto(`/deals?deal=${carr.deals[BAYSIDE]}&mode=live`);
  const fact = (term: string) => page.locator('#workspaceFacts div').filter({ has: page.locator('dt', { hasText: term }) }).locator('dd');
  await expect(fact('Phase')).toHaveText('Negotiating');
  await expect(page.locator('.deal-current-action')).toContainText('Next action: Send the lease draft to the landlord');
  await page.getByRole('tab', { name: 'Timeline' }).click();
  const timeline = page.locator('#workspace-timeline');
  await expect(timeline).toContainText('patch deal field · phase → Negotiation');
  await expect(timeline).toContainText('set next step · next_step → Send the lease draft to the landlord');
});

test('the filed call guide keeps pending work through navigation and reopening', async ({ signedIn: page, carr, companion }) => {
  if (!guideCall) throw new Error('The filed-call journey must run first');
  await companion(guideCall);
  await openHome(page);
  await page.locator('.call-outcome').first().getByRole('button', { name: 'Review call', exact: true }).click();
  const guide = page.locator('.call-review-dialog').getByRole('region', { name: 'Review this call' });
  await expect(guide.getByRole('heading', { name: BAYSIDE, exact: true })).toBeVisible();
  await expect(guide.getByText('Before', { exact: true })).toBeVisible();
  await expect(guide.getByText('From this call', { exact: true })).toBeVisible();
  await expect(guide.locator('blockquote')).toContainText('Bayside moves to negotiation');
  await expect(guide.getByRole('button', { name: 'Complete call review' })).toBeDisabled();
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1400 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; localStorage.setItem('dealroom-theme', theme); }, theme);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(guide).toHaveCSS('padding', width === 390 ? '16px' : '24px');
    await page.mouse.move(width - 1, 1399);
    await guide.screenshot({ path: `/tmp/wr617-s2-j3-shots/live-${width}-${theme}-guide.png` });
  }
  await guide.getByRole('button', { name: 'Reviewed', exact: true }).click();
  await guide.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(guide.getByRole('button', { name: 'Reviewed', exact: true })).toBeDisabled();
  await guide.getByRole('button', { name: 'Next', exact: true }).click();
  await guide.getByRole('button', { name: 'Reviewed', exact: true }).click();
  await expect(guide.getByText('Needs your decision', { exact: true })).toBeVisible();
  const pendingText = await guide.locator('dd').last().textContent();
  await page.getByRole('button', { name: 'Close call review', exact: true }).click();
  await page.locator('.call-outcome').first().getByRole('button', { name: 'Review call', exact: true }).click();
  await expect(guide.locator('dd').last()).toHaveText(pendingText || '');
  await guide.getByRole('button', { name: 'Approve or fix this item' }).click();
  const focused = page.locator('#postCallReport button:focus');
  await expect(focused).toBeVisible();
  await expect(page.locator('#postCallOutcomes').getByRole('button', { name: 'Complete call review' })).toBeDisabled();
  await expect(page.locator('#postCallReport')).toContainText('Creates a draft only.');
  await expect(focused).toHaveAttribute('data-post-call-confirm');
  const pendingId = await focused.getAttribute('data-post-call-confirm');
  await focused.click();
  await expect(page.locator(`#postCallReport [data-post-call-confirm="${pendingId}"]`)).toHaveCount(0);
  await expect(page.locator('#postCallOutcomes').getByRole('button', { name: 'Complete call review' })).toBeDisabled();
});

test('Home completes the real filed call after its pending proposals are resolved', async ({ signedIn: page, carr }) => {
  const outcomes = await carr.mcp('read-call-outcomes');
  for (const call of outcomes.calls) for (const item of call.open_cards) {
    await carr.mcp(item.resolver, { candidate_id: item.candidate_id, accept: false });
  }
  await openHome(page);
  await page.locator('.call-outcome').first().getByRole('button', { name: 'Review call', exact: true }).click();
  const guide = page.locator('.call-review-dialog').getByRole('region', { name: 'Review this call' });
  const count = Number(await guide.getByRole('progressbar').getAttribute('max'));
  for (let index = 0; index < count; index++) {
    const reviewed = guide.getByRole('button', { name: 'Reviewed', exact: true });
    if (!await reviewed.isEnabled()) break;
    await reviewed.click();
  }
  await expect(guide.getByRole('button', { name: 'Complete call review' })).toBeEnabled();
  await guide.getByRole('button', { name: 'Complete call review' }).click();
  await expect(guide).toContainText('No call items to review.');
  await expect(page.locator('.call-outcome')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close call review', exact: true }).click();
  await page.reload();
  await expect(page.locator('#homeCallTasks')).toContainText('No call follow-ups');
  await expect(page.locator('.call-outcome')).toHaveCount(0);
});
