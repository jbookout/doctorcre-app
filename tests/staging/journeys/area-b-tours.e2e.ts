import { describe } from '@e2e-dev/web';
import { expect, unique } from 'e2e';
import { z } from 'zod';
import { verbTest as test } from '../api/fixture.ts';

// Area B journeys: Tours planner, Route editor, Tour day, Share page.
// One test per feature id. Staging has 1 draft tour, 0 properties, no microphone.
const tags = ['journey', 'area-b'];
const opts = { session: 'staging-partner', tags } as const;

// The "Morning brief" dialog opens on every fresh load and swallows pointer events.
async function ready(app: any, screen: any, path: string) {
  await app.open(path);
  const brief = screen.getByRole('button', 'Dismiss morning brief');
  if (await brief.isVisible().catch(() => false)) await brief.tap();
}

describe('area B: tours planner', () => {
  test('[tours-plan-form] plan a tour draft and undo an edit', opts, async ({ app, screen, agent }) => {
    await ready(app, screen, '/tours');
    const name = `E2E ${Date.now()} plan`;
    await agent.act('In Plan a Tour, choose the client Synthetic Staging Fixture under For');
    await expect(screen.getByLabel('For').first()).toHaveValue(/.+/);
    await agent.act('In Plan a Tour, type {name} into Tour name', { params: { name: unique(name) } });
    await expect(screen.getByLabel('Tour name')).toHaveValue(name);
    await expect(screen.getByRole('button', 'Undo tour edit')).toBeEnabled();
    await agent.act('Press Undo tour edit');
    await expect(screen.getByText('Change undone.').first()).toBeVisible();
    await expect(screen.getByLabel('Tour name')).not.toHaveValue(name);
  });

  test('[tours-packet-files] add a packet file and review the packet draft', opts, async ({ app, screen, agent }) => {
    await ready(app, screen, '/tours');
    await expect(screen.getByRole('button', 'Compile packet')).toBeDisabled();
    await screen.getByLabel('For').first().selectOption({ label: 'Synthetic Staging Fixture' });
    await screen.getByLabel('Tour name').fill(`E2E ${Date.now()} packet`);
    await screen.getByLabel('CoStar reports & files', { exact: false }).setInputFiles(['README.md']);
    await expect(screen.getByText('1 files')).toBeVisible();
    await agent.act('Press Review packet draft');
    await expect(screen.getByText('Packet compilation unavailable')).toBeVisible();
    await expect(screen.getByText('Private draft')).toBeVisible();
    await expect(screen.getByText('README.md').last()).toBeVisible();
  });

  test('[tours-search-space] save a space search draft; Find spaces stays disabled', opts, async ({ app, screen, agent }) => {
    await ready(app, screen, '/tours');
    await expect(screen.getByRole('button', 'Find spaces')).toBeDisabled();
    const area = `E2E ${Date.now()} Mobile, AL`;
    await agent.act('In the Search for Space card, type {area} into its Area field', { params: { area: unique(area) } });
    await expect(screen.getByLabel('Area').last()).toHaveValue(area);
    await screen.getByLabel('Minimum SF').fill('2000');
    await agent.act('Press Save search draft');
    await expect(screen.getByText('Search draft saved.')).toBeVisible();
    await expect(screen.getByText('MLS unavailable')).toBeVisible();
  });

  test('[tours-library] find a tour and open its details', opts, async ({ app, screen, agent, api }) => {
    await ready(app, screen, '/tours');
    const response = await api('/api/tours/library');
    expect(response.status).toBe(200);
    const body = expect(await response.json()).toMatchSchema(z.object({ data: z.object({ tours: z.array(z.object({ id: z.string(), tour_name: z.string() }).passthrough()) }) }).passthrough());
    expect(body.data.tours.length).toBeGreaterThan(0);
    await agent.act('Type draft tour into Find a tour');
    await expect(screen.getByLabel('Find a tour')).toHaveValue('draft tour');
    await expect(screen.getByRole('button').filter({ hasText: 'draft tour' }).first()).toBeVisible();
    await agent.act('Open the first tour listed under Upcoming');
    await expect(screen.getByRole('button', 'Close tour details')).toBeVisible();
    await agent.act('Close tour details');
    await expect(screen.getByRole('button', 'Close tour details')).toBeHidden();
  });

  test('[tours-territory] territory buttons set the search area', opts, async ({ app, screen, agent }) => {
    await ready(app, screen, '/tours');
    await agent.act('Press the Pensacola territory button');
    await expect(screen.getByRole('button', 'Pensacola')).toHaveAttribute('aria-pressed', 'true');
    await expect(screen.getByLabel('Area').last()).toHaveValue('Pensacola, FL');
    await agent.act('Press the Panama City territory button');
    await expect(screen.getByRole('button', 'Panama City')).toHaveAttribute('aria-pressed', 'true');
    await expect(screen.getByRole('button', 'Pensacola')).toHaveAttribute('aria-pressed', 'false');
    await expect(screen.getByLabel('Area').last()).toHaveValue('Panama City, FL');
  });
});

describe('area B: route editor, tour day and share page', () => {
  test('[route-create-tour] create a tour in the itinerary composer', opts, async ({ app, screen, agent, api }) => {
    await ready(app, screen, '/tours/route-editor.html');
    const name = `E2E ${Date.now()} route tour`;
    await agent.act('Open Start a Tour');
    await expect(screen.getByLabel('Tour name')).toBeVisible();
    await agent.act('Fill the Start a Tour form: Tour name {name}, Subject reference {subject}, Property dataset version {dataset}, Start latitude 30.6954, Start longitude -88.0399, Start Location reference E2E start, End latitude 30.6954, End longitude -88.0399, End Location reference E2E end',
      { params: { name: unique(name), subject: 'E2E-subject', dataset: 'e2e-dataset-1' } });
    await expect(screen.getByLabel('Tour name')).toHaveValue(name);
    await screen.getByRole('button', 'Create Tour').tap();
    await expect(screen.getByRole('heading', { name, level: 2 })).toBeVisible();
    await expect(screen.getByText(name).first()).toBeVisible();
    const response = await api('/api/tours/library');
    expect(JSON.stringify(await response.json())).toContain(name);
  });

  test('[route-property-search] find properties', opts, async ({ app, screen, agent, verb }) => {
    const seed = await verb('search-tour-properties', { query: null, counties: [], property_types: [], min_square_feet: null, max_square_feet: null, availability: [], entrance_verified: null, public_projection_ready: null, photos_available: null, sort: 'updated_desc', cursor: null, limit: 10 });
    expect(seed.isError).toBe(false);
    await ready(app, screen, '/tours/route-editor.html');
    await screen.getByRole('button').filter({ hasText: '· draft' }).first().tap();
    await expect(screen.getByRole('button', 'Find properties')).toBeVisible();
    await agent.act('Press Find properties');
    await expect(screen.getByText('No properties match these filters.')).toBeVisible();
  });

  test('[route-compose] add stops, save draft, undo', opts, async () => {
    test.skip(true, 'BLOCKED: needs a registered Tour property (property dataset). Staging has 0 properties and register-tour-property needs a rights receipt plus source evidence only a rights authority can mint');
  });

  test('[route-accept] accept a reviewed route', opts, async () => {
    test.skip(true, 'BLOCKED: needs a saved draft route version with at least one stop, which needs a Tour property (0 on staging)');
  });

  test('[route-share] confidential link controls stay unissued (N/A by design)', opts, async ({ app, screen, agent }) => {
    // Never press Issue, Rotate or Revoke: the link host is production-named.
    await ready(app, screen, '/tours/route-editor.html');
    await screen.getByRole('button').filter({ hasText: '· draft' }).first().tap();
    await expect(screen.getByText('Not issued')).toBeVisible();
    await expect(screen.getByText('Not generated').first()).toBeVisible();
    await expect(screen.getByLabel('Copy this link now')).toBeHidden();
  });

  test('[route-pdf] render and review packet PDF', opts, async () => {
    test.skip(true, 'BLOCKED: needs an accepted route with property stops (0 properties on staging)');
  });

  test('[tourday-stop-nav] previous and next stop', opts, async () => {
    test.skip(true, 'BLOCKED: needs a Tour with at least two property stops (the only staging tour has 0 properties)');
  });

  test('[tourday-voice-note] record note control is honest without a microphone (N/A by design)', opts, async ({ app, screen, agent, api }) => {
    const library: any = await (await api('/api/tours/library')).json();
    await ready(app, screen, `/tours/day.html?tour=${library.data.tours[0].id}`);
    await agent.assert('the Tour day page shows a disabled Record note button');
    await expect(screen.getByRole('button').filter({ hasText: 'Record note' }).first()).toBeDisabled();
  });

  test('[share-page] /share is served by staging, not redirected to the production report host', opts, async ({ api }) => {
    // redirect: 'manual' (api fixture): a 3xx would expose its Location instead of being followed.
    const response = await api('/share');
    const location = response.headers.get('location') ?? '';
    expect(location, `redirect status ${response.status}`).not.toContain('reports.doctorcre.com');
    expect(response.status).toBe(200);
  });
});
