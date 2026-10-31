// Journey 2, file a call and see the deal update (WR629). The call is filed
// through the real Call Mode path into the real record layer; nothing the app
// reads here is stubbed.
import type { Page } from '@playwright/test';
import { test, expect } from './harness';

test.describe.configure({ mode: 'serial' });

const BAYSIDE = 'Synthetic Bayside Dental Relocation';
const HARBOR = 'Synthetic Harbor Clinic Expansion';
const PINECREST = 'Synthetic Pinecrest Lab Lease';

// Home's call reads have answered, so an empty list means empty, not loading.
async function openHome(page: Page) {
  const read = (name: string) => page.waitForResponse(response => response.url().endsWith('/mcp')
    && response.request().postDataJSON()?.params?.name === name && response.ok());
  const reads = Promise.all([read('read-call-outcomes'), read('read-post-call-followups')]);
  await page.goto('/?mode=live');
  await reads;
}

test('a call whose filing fails is not shown as filed, and Home says it needs attention', async ({ signedIn: page, carr, companion }) => {
  await companion(await carr.fileCall({ distiller: 'failing' }));
  await openHome(page);
  await expect(page.locator('#homeCallTasks')).toContainText('No call follow-ups');
  await expect(page.locator('.call-outcome')).toHaveCount(0);

  await page.getByRole('button', { name: 'Call mode' }).click();
  const status = page.locator('#postCallStatus');
  await expect(status).toContainText('The post-call report needs attention.');
  await expect(status).toContainText('Local processing stopped: local post-call distiller failed');
});

test('a filed call shows its decisions and tasks on Home and updates the deal page', async ({ signedIn: page, carr }) => {
  await carr.fileCall();
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
