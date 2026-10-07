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

test('[deals-client-vendor-context] BUG: drawer says the deal has no client although it has one', opts, async ({ app, screen, verb }) => {
  const name = `E2E ${Date.now()} bug context deal`;
  const id = await seedDeal(verb, name);
  expect(((await verb('get-deal-room', { deal: name })).data as any).client_name).toBe('Synthetic Staging Fixture');
  await ready(app, screen, `/deals?deal=${id}`);
  await screen.getByRole('button', 'Client & vendor context').tap();
  await expect(screen.getByRole('heading', 'Client & vendor context').last()).toBeVisible();
  await expect(screen.getByText('This deal is not linked to a client record.')).toBeHidden();
});
