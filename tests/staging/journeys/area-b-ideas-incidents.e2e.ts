import { describe } from '@e2e-dev/web';
import { expect, unique } from 'e2e';
import { verbTest as test } from '../api/fixture.ts';

// Area B journeys: Ideas & Events, Incidents.
const opts = { session: 'staging-partner', tags: ['journey', 'area-b'] } as const;

async function ready(app: any, screen: any, path: string) {
  await app.open(path);
  const brief = screen.getByRole('button', 'Dismiss morning brief');
  if (await brief.isVisible().catch(() => false)) await brief.tap();
}

describe('area B: ideas and events', () => {
  test('[ideas-browse] search and open ideas', opts, async () => {
    test.skip(true, 'BLOCKED: needs one parked idea. add-loop kind=idea returns no_block on staging (the loop importer has not run) and loop-board kind=idea has 0 rows');
  });

  test('[events-add-edit] add and edit an industry event', opts, async ({ app, screen, agent, verb }) => {
    await ready(app, screen, '/ideas-events?tab=events');
    const title = `E2E ${Date.now()} summit`;
    await expect(screen.getByRole('button', 'Add event')).toBeVisible();
    await agent.act('Press Add event');
    await expect(screen.getByLabel('Event name')).toBeVisible();
    await agent.act('Fill the event form: Event name {title}, Organizer E2E Association, Owner Joe, Starts 2026-12-02 9:00 AM, Ends 2026-12-02 11:00 AM, Reference https://example.com/e2e-event, then press Save event', { params: { title: unique(title) } });
    await expect(screen.getByText(`${title} saved. Events refreshed from the record.`)).toBeAttached();
    const added = await verb('list-industry-events', {});
    const row = (added.data.events as any[]).find(e => e.title === title);
    expect(row, 'event persisted in the record').toBeTruthy();
    // After a save the page reloads the list from the record and must show the event card.
    await expect(screen.getByRole('button').filter({ hasText: title }).first()).toBeVisible();
    await agent.act('Open the event {title} and change Organizer to E2E Association Revised, then press Save event', { params: { title: unique(title) } });
    await expect(screen.getByText(`${title} saved. Events refreshed from the record.`)).toBeAttached();
    await expect.poll(async () => ((await verb('list-industry-events', {})).data.events as any[]).find(e => e.title === title)?.organizer, { timeout: 15_000 }).toBe('E2E Association Revised');
    const latest = ((await verb('list-industry-events', {})).data.events as any[]).find(e => e.title === title);
    await verb('update-industry-event', { idempotency_key: crypto.randomUUID(), event_id: latest.id, base_version: Number(latest.version), status: 'cancelled' });
  });
});

describe('area B: incidents', () => {
  test('[incidents-list-detail] open incident detail', opts, async () => {
    test.skip(true, 'BLOCKED: needs one incident. open-incident fails no_such_service for every service key tried (carr-mcp, nightly-record-layer, doctorcre-app) because the staging store has no registered service; incident-board has 0 rows');
  });

  test('[incidents-link-work-request] link a work request to an incident', opts, async () => {
    test.skip(true, 'BLOCKED: needs one incident (see incidents-list-detail: no registered incident service on staging) plus a public Work Request ref');
  });
});
