import { verbTest as test } from '../api/fixture.ts';
import { expect, unique } from 'e2e';
import { randomUUID } from 'node:crypto';

const key = () => randomUUID();
const opts = { session: 'staging-partner', tags: ['bugbash'] } as const;
async function ready(app: any, screen: any, path: string) {
  await app.open(path);
  const d = screen.getByRole('button', 'Dismiss morning brief');
  await d.waitFor({ timeout: 9_000 }).catch(() => {});
  if (await d.isVisible()) await d.tap();
}
async function seedDeal(verb: any, name: string) {
  const made = await verb('new-deal', { idempotency_key: key(), client: 'C-001', name, deal_type: 'startup', phase: 'pending' });
  expect(made.isError, JSON.stringify(made.data)).toBe(false);
  expect((await verb('patch-deal-field', { idempotency_key: key(), deal: name, field: 'owner', value: 'joe', base_event_id: null })).isError).toBe(false);
  return made.data.deal_id as string;
}
const boardDeal = async (verb: any, name: string) => ((await verb('deal-room-board', {})).data.deals as any[]).find(d => d.name === name);
async function openSidebar(screen: any) {
  const t = screen.getByRole('button', 'Workspace sidebar');
  if ((await t.getAttribute('aria-expanded')) !== 'true') await t.tap();
}
async function openList(app: any, screen: any) {
  await ready(app, screen, '/deals?view=national');
  await screen.getByRole('button', 'All Deals').tap();
  await openSidebar(screen);
}

test('[charts-tabs] BUG: Home has no Charts tab to return to', opts, async ({ app, screen, agent }) => {
  await ready(app, screen, '/?view=charts');
  await agent.act('open the Overview tab');
  await expect(screen.getByRole('heading', 'Control room').first()).toBeVisible();
  await expect(screen.getByRole('link', { name: 'Charts', exact: true })).toBeVisible();
});
