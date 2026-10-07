import { describe } from '@e2e-dev/web';
import { expect, unique } from 'e2e';
import { z } from 'zod';
import { verbTest as test } from '../api/fixture.ts';
import { dismissMorningBrief } from '../support/brief.ts';

// Area C2 journeys: Status and the Control Room. One test per feature id in
// tests/staging/features.json. The Control Room is extremely dense, so tab
// selection and filters use deterministic `screen` actions and each agent.act
// pursues one goal inside a single tab. Every act is pinned by a locator
// expect or agent.assert so the replay cache records it (docs/cache.mdx).

const TABS = [
  ['System Job Board', /\/control-room(\?|$)/],
  ['Connections', /tab=connections/],
  ['Automations', /tab=automations/],
  ['Action Items', /tab=attention/],
  ['Agents', /tab=agents/],
  ['System Map', /tab=system-map/],
  ['Sessions', /tab=sessions/],
] as const;

describe('area C2: status', { session: 'staging-partner', tags: ['journey', 'area-c'] }, () => {
  test('[status-overview] the status page states availability, coverage times and build identity', async ({ app, agent, screen, api }) => {
    await app.open('/status');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('heading', { name: 'Status' }).first()).toBeVisible();
    await expect(screen.getByRole('heading', { name: 'Last updated' })).toBeVisible();
    await agent.waitFor('The status headline no longer says Updating and states whether DoctorCRE is available', { timeout: 30_000 });
    await expect(screen.getByText(/^App build [0-9a-f]{7} · /)).toBeVisible();
    // Independent check: the build identity on screen is the one /app-release serves.
    const release: any = await (await api('/app-release')).json();
    expect(typeof release.source_commit).toBe('string');
    await expect(screen.getByText(new RegExp(`^App build ${String(release.source_commit).slice(0, 7)} · `))).toBeVisible();
    const coverage = await agent.extract('How many sources are listed under Last updated with a clock time', { schema: z.object({ sources: z.number().int() }) });
    expect(coverage.sources).toBeGreaterThanOrEqual(5);
    await agent.assert('The Last updated section lists the app, Incidents, Active work, Requests for Joe and Work census each with an updated time');
  });

  test('[status-assurance-health] a scoped assurance read answers for exactly the workflow asked about', async ({ app, agent, screen, verb }) => {
    await app.open('/status');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('heading', { name: 'Assurance health' })).toBeVisible();
    await agent.act('Type {workflow} into the Workflow field, type 1 into the Version field and press Availability', { params: { workflow: unique(`e2e-workflow-${Date.now()}`) } });
    await expect(screen.getByLabel('Version')).toHaveValue('1');
    const workflow = await screen.getByLabel('Workflow').inputValue();
    expect(workflow).toMatch(/^e2e-workflow-/);
    await expect(screen.getByText(`${workflow} · v1 · this scope only`)).toBeVisible({ timeout: 20_000 });
    await agent.assert(`The Assurance health block for ${workflow} version 1 states a health word for that workflow only`);
    const answer = await verb('read-assurance-health', { scope: { workflow_key: workflow, workflow_version: 1 } });
    const word = answer.isError ? 'unknown' : String(answer.data?.state ?? 'unknown');
    await expect(screen.getByText(new RegExp(`^${word} · `)).first()).toBeVisible();
    // An invalid scope is refused plainly instead of reading something else.
    await screen.getByLabel('Version').fill('0');
    await screen.getByRole('button', { name: 'Availability' }).click();
    await expect(screen.getByText(/Enter a workflow, a positive whole version/).first()).toBeVisible();
  });

  test('[status-providers] provider status links are shown and never followed', async ({ app, screen }) => {
    await app.open('/status');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('link', { name: 'Cloudflare status' })).toHaveAttribute('href', 'https://www.cloudflarestatus.com/');
    await expect(screen.getByRole('link', { name: 'Neon status' })).toHaveAttribute('href', 'https://neonstatus.com/');
    await expect(screen.getByRole('link', { name: 'GitHub status' })).toHaveAttribute('href', 'https://www.githubstatus.com/');
    await expect(screen.getByRole('link', { name: 'GitHub status' })).toHaveAttribute('target', '_blank');
  });
});

describe('area C2: Control Room', { session: 'staging-partner', tags: ['journey', 'area-c'] }, () => {
  test('[cr-tabs] every Control Room section tab opens its section', async ({ app, agent, browser, screen }) => {
    await app.open('/control-room');
    await dismissMorningBrief(screen);
    const tablist = screen.getByRole('tablist', { name: 'Control Room sections' });
    await expect(tablist).toBeVisible();
    await agent.act('Open the Agents tab');
    await expect(tablist.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true');
    await expect(browser).toHaveURL(/tab=agents/);
    for (const [name, url] of TABS) {
      await tablist.getByRole('tab', { name }).click();
      await expect(tablist.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
      await expect(browser).toHaveURL(url);
    }
    // The URL is the section: a reload of a tab URL lands on the same tab.
    await app.open('/control-room?tab=sessions');
    await expect(screen.getByRole('tablist', { name: 'Control Room sections' }).getByRole('tab', { name: 'Sessions' })).toHaveAttribute('aria-selected', 'true');
  });

  test('[cr-job-board] the job board key, Live Library and stage filter work', async ({ app, agent, screen }) => {
    await app.open('/control-room');
    await dismissMorningBrief(screen);
    const cards = screen.getByText(/^\d+ OF \d+ CARDS$/);
    await expect(cards).toBeVisible({ timeout: 30_000 });
    const label = (await cards.textContent()) ?? '';
    const total = Number(label.match(/OF (\d+)/)?.[1]);
    expect(Number(label.match(/^(\d+)/)?.[1])).toBe(total);
    await agent.act('Press the Key button');
    await agent.assert('A key is open that explains the stage colours, executor glyphs and pulse speeds of the cards');
    await screen.getByRole('button', { name: 'Key' }).click();
    // Live Library switches the work list to completed work and back.
    await screen.getByRole('button', { name: 'Live Library' }).click();
    await expect(screen.getByRole('button', { name: 'Unfinished work' })).toHaveAttribute('aria-pressed', 'true');
    await screen.getByRole('button', { name: 'Unfinished work' }).click();
    await expect(screen.getByRole('button', { name: 'Live Library' })).toHaveAttribute('aria-pressed', 'false');
    // The Queued column holds cards, so the Stage filter must be able to narrow the board to it.
    const queued = await agent.extract('The number of cards the Queued column holds, shown as the number next to its title', { schema: z.object({ queued: z.number().int() }) });
    expect(queued.queued).toBeGreaterThan(0);
    const filters = screen.getByRole('form', { name: 'Filter cards' });
    await expect(filters.getByLabel('Stage').getByRole('option', { name: 'Queued' })).toHaveCount(1);
    await filters.getByLabel('Stage').selectOption('Queued');
    await expect(cards).toHaveText(`${queued.queued} OF ${total} CARDS`);
    await filters.getByLabel('Stage').selectOption('All');
    await expect(cards).toHaveText(`${total} OF ${total} CARDS`);
  });

  test('[cr-job-board-search] searching the system work list with no match says so, and clearing restores it', async ({ app, screen }) => {
    await app.open('/control-room');
    await dismissMorningBrief(screen);
    await expect(screen.getByText(/^\d+ OF \d+ CARDS$/)).toBeVisible({ timeout: 30_000 });
    const search = screen.getByRole('searchbox', { name: 'Search' });
    const term = unique(`zzz-no-such-work-${Date.now()}`);
    await search.fill(term.value);
    await screen.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(screen.getByText('No unfinished work matches these filters.')).toBeVisible({ timeout: 20_000 });
    await search.fill('');
    await screen.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(screen.getByText('No unfinished work matches these filters.')).toBeHidden({ timeout: 20_000 });
  });

  test('[cr-connections] each provider card states status honestly and Manage leads somewhere', async ({ app, agent, screen, verb }) => {
    await app.open('/control-room');
    await dismissMorningBrief(screen);
    await agent.act('Open the Connections tab');
    await expect(screen.getByRole('tab', { name: 'Connections' })).toHaveAttribute('aria-selected', 'true');
    await expect(screen.getByRole('heading', { name: 'Connections' })).toBeVisible();
    for (const name of ['Claude', 'Codex', 'Grok', 'Jev', 'Tailscale', 'Neon', 'GitHub', 'Cloudflare', 'Local compute', 'Model tools']) {
      await expect(screen.getByRole('heading', { name, level: 3 })).toBeVisible();
    }
    const dashboard = await verb('read-resource-dashboard', {});
    expect(dashboard.isError).toBe(false);
    expect(dashboard.data?.providers?.length ?? 0).toBeGreaterThanOrEqual(5);
    // Staging has no collector observations: every card must say so instead of inventing a status.
    await expect(screen.getByText('Status unavailable')).toHaveCount(10);
    const manage = screen.getByRole('link', { name: 'Manage ↗' });
    await expect(manage).toHaveCount(10);
    // External providers: the link names its destination and opens in a new tab (the harness blocks the visit itself).
    await expect(manage.nth(0)).toHaveAttribute('href', 'https://claude.ai/settings/usage');
    await expect(manage.nth(0)).toHaveAttribute('target', '_blank');
    await expect(manage.nth(0)).toHaveAttribute('rel', /noopener/);
  });

  test('[cr-connections-manage-in-app] Manage for Local compute and Model tools targets an in-app section that opens', async ({ app, screen }) => {
    await app.open('/control-room?tab=connections');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('heading', { name: 'Connections' })).toBeVisible();
    const manage = screen.getByRole('link', { name: 'Manage ↗' });
    // Both are in-app destinations that the card opens in a new tab (the harness does not follow new tabs),
    // so open each destination in this tab and check it lands on the named section.
    for (const [index, href, tab] of [[8, '/control-room?tab=system-map', 'System Map'], [9, '/control-room?tab=agents', 'Agents']] as const) {
      await expect(manage.nth(index)).toHaveAttribute('href', href);
      await expect(manage.nth(index)).toHaveAttribute('target', '_blank');
      await app.open(href);
      await expect(screen.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
      await app.open('/control-room?tab=connections');
      await expect(screen.getByRole('heading', { name: 'Connections' })).toBeVisible();
    }
  });

  test('[cr-action-items] action items read the incident board and say when none match', async ({ app, agent, screen, verb }) => {
    await app.open('/control-room');
    await dismissMorningBrief(screen);
    await agent.act('Open the Action Items tab');
    await expect(screen.getByRole('tab', { name: 'Action Items' })).toHaveAttribute('aria-selected', 'true');
    await expect(screen.getByRole('heading', { name: 'Action Items' })).toBeVisible();
    const board = await verb('incident-board', { state: 'open' });
    expect(board.isError).toBe(false);
    const rows = (board.data?.incidents ?? board.data?.items ?? board.data?.rows ?? []) as unknown[];
    const count = rows.length;
    await expect(screen.getByRole('button', { name: new RegExp(`^All · ${count}$`) })).toHaveAttribute('aria-pressed', 'true');
    if (count === 0) await expect(screen.getByText('No incident matches this severity')).toBeVisible();
  });

  test('[cr-agents] a message sent into the Model Room appears in its turns and in the record', async ({ app, agent, screen, verb }) => {
    const message = unique(`E2E ${Date.now()} read-only check, no action needed`);
    await app.open('/control-room?tab=agents');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('heading', { name: 'Model Room' })).toBeVisible();
    await agent.act('Type {message} into the Message box under Send into this room and press Send', { params: { message } });
    await expect(screen.getByText(message.value).first()).toBeVisible({ timeout: 30_000 });
    const latest = await verb('read-room-latest', { room: 'model-room', limit: 50, mode: 'conversation' });
    expect(JSON.stringify(latest.data)).toContain(message.value);
    await app.open('/control-room?tab=agents');
    await expect(screen.getByText(message.value).first()).toBeVisible({ timeout: 30_000 });
  });

  test('[cr-system-map] the system map reads its coverage and Doc\'s tour starts and exits', async ({ app, agent, screen }) => {
    await app.open('/control-room?tab=system-map');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('heading', { name: 'Coverage' })).toBeVisible();
    await expect(screen.getByRole('heading', { name: 'mcp-server/src/tools.js' }).first()).toBeVisible();
    await agent.act("Press Start Doc's tour");
    await expect(screen.getByText(/^Step 1 of \d+$/)).toBeVisible();
    await agent.assert('A guided tour of the system map is showing a narrated step with Back, Next and Exit tour controls');
    await screen.getByRole('button', { name: 'Next' }).click();
    await expect(screen.getByText(/^Step 2 of \d+$/)).toBeVisible();
    await screen.getByRole('button', { name: 'Exit tour' }).click();
    await expect(screen.getByRole('button', { name: /Start Doc.s tour/ })).toBeVisible();
  });

  test('[cr-system-map-views] Anatomical is disabled with a stated reason until the layer is narrowed, then Exploded works', async ({ app, screen }) => {
    await app.open('/control-room?tab=system-map');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('button', { name: 'Index' })).toHaveAttribute('aria-pressed', 'true');
    const anatomical = screen.getByRole('button', { name: 'Anatomical' });
    await expect(anatomical).toBeDisabled();
    await expect(screen.getByText(/This page carries too many components to draw as one body/)).toBeVisible();
    await screen.getByRole('button', { name: 'Installed' }).click();
    await expect(anatomical).toBeEnabled({ timeout: 30_000 });
    await anatomical.click();
    await expect(anatomical).toHaveAttribute('aria-pressed', 'true');
    await screen.getByRole('button', { name: 'Exploded' }).click();
    await expect(screen.getByRole('button', { name: 'Exploded' })).toHaveAttribute('aria-pressed', 'true');
    await screen.getByRole('button', { name: 'Index' }).click();
    await expect(screen.getByRole('button', { name: 'Index' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('[cr-sessions] finding a session that does not exist says so, and the verb agrees', async ({ app, agent, screen, verb }) => {
    const name = unique(`e2e-no-such-session-${Date.now()}`);
    await app.open('/control-room?tab=sessions');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('heading', { name: 'Sessions' })).toBeVisible();
    await agent.act('Type {name} into Find a session by name or id', { params: { name } });
    await expect(screen.getByLabel('Find a session by name or id')).toHaveValue(name.value);
    await expect(screen.getByText('No session matches that.')).toBeVisible({ timeout: 20_000 });
    const answer = await verb('read-session-identity', { query: name.value, limit: 5 });
    expect(answer.isError).toBe(false);
    expect(JSON.stringify(answer.data)).not.toContain(name.value + '"');
    await screen.getByLabel('Include closed sessions').check();
    await expect(screen.getByLabel('Include closed sessions')).toBeChecked();
  });

  test('[cr-triage] a work card opens the review dialog and cancelling the confirmation changes nothing', async ({ app, agent, browser, screen }) => {
    // The confirmation is cancelled on purpose so the dialog path is exercised without a write.
    await app.open('/control-room');
    await dismissMorningBrief(screen);
    await expect(screen.getByText(/^\d+ OF \d+ CARDS$/)).toBeVisible({ timeout: 30_000 });
    await screen.getByRole('article').filter({ hasText: 'Synthetic staging MCP catalog route proof' }).getByRole('button', { name: 'progress' }).click();
    const dialog = screen.getByRole('dialog', { name: 'Review system work action' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: /^Progress · / })).toBeVisible();
    await browser.onDialog('dismiss');
    await dialog.getByRole('button', { name: 'Review and confirm' }).click();
    await expect(dialog.getByText('No change requested.')).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
  });

  test('[cr-automations] automations list their jobs and each paused job opens its detail', async ({ app, agent, screen }) => {
    await app.open('/control-room/automations');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('heading', { name: 'Automations' })).toBeVisible();
    await expect(screen.getByRole('button', { name: /^Job watchdog/ })).toBeVisible();
    await agent.act('Open the job named calendar prebrief canary joe daily');
    const popup = screen.getByRole('dialog', { name: 'calendar prebrief canary joe daily' });
    await expect(popup).toBeVisible();
    await agent.assert('A detail popup for the calendar prebrief canary job is open and shows its owner and its status');
    await expect(popup.getByText('paused', { exact: true }).first()).toBeVisible();
    // Charter claim "canary popups say Work Request unavailable": confirmed as wording, and it is truthful here
    // because the job carries no linked Work Request; the linked-read failure text must not appear.
    await expect(popup.getByText('Work Request unavailable')).toBeVisible();
    await expect(popup.getByText('Linked Work Request temporarily unavailable')).toBeHidden();
    await popup.getByRole('button', { name: 'Close job details' }).click();
    await expect(popup).toBeHidden();
  });

  test('[cr-automations-month] the calendar view moves between months', async ({ app, agent, screen }) => {
    await app.open('/control-room?tab=automations');
    await dismissMorningBrief(screen);
    const label = (offset: number) => new Date(new Date().getFullYear(), new Date().getMonth() + offset, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
    await expect(screen.getByRole('button', { name: 'Previous month' })).toBeVisible({ timeout: 30_000 });
    await expect(screen.getByText(label(0), { exact: true })).toBeVisible();
    await agent.act('Go to the next month in the Automations calendar');
    await expect(screen.getByText(label(1), { exact: true })).toBeVisible();
    await agent.assert(`The Automations calendar heading shows ${label(1)}`);
    await screen.getByRole('button', { name: 'Previous month' }).click();
    await expect(screen.getByText(label(0), { exact: true })).toBeVisible();
  });
});
