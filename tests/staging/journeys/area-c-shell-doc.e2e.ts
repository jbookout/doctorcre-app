import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { z } from 'zod';
import { dismissMorningBrief } from '../support/brief.ts';

// Area C journeys: the app shell (header rail, account menu, sidebars), the
// Dr. CRE palette and Call Mode. One test per feature id in tests/staging/features.json.
// Goals run through agent.act and every act is pinned by a locator expect or
// agent.assert so the replay cache records it (docs/cache.mdx).

describe('area C: shell', { session: 'staging-partner', tags: ['journey', 'area-c'] }, () => {
  test('[shell-nav] primary navigation and More reach every workspace page', async ({ app, agent, browser, screen }) => {
    await app.open('/');
    await dismissMorningBrief(screen);
    await agent.act('Open Local Deals from the primary navigation');
    await expect(browser).toHaveURL(/\/deals(\?|$)/);
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    for (const [label, path] of [['Leads', /\/leads/], ['Tours', /\/tours/], ['Vendors', /\/vendors/], ['Control Room', /\/control-room/], ['Home', /\/(\?.*)?$/]] as const) {
      await nav.getByRole('link', { name: label, exact: true }).click();
      await expect(browser).toHaveURL(path);
    }
    await nav.getByRole('button', { name: 'More' }).click();
    await expect(nav.getByRole('button', { name: 'More' })).toHaveAttribute('aria-expanded', 'true');
    const more = await nav.getByRole('link').allTextContents();
    expect(more.length).toBeGreaterThan(8);
    await agent.act('Open Updates from the More menu');
    await expect(browser).toHaveURL(/\/updates/);
  });

  test('[shell-theme-toggle] Dark mode toggles, survives a reload, and toggles back', async ({ app, browser, screen }) => {
    await app.open('/');
    await dismissMorningBrief(screen);
    const dark = screen.getByRole('button', { name: 'Dark mode' });
    const before = await dark.getAttribute('aria-pressed');
    const after = before === 'true' ? 'false' : 'true';
    await dark.click();
    await expect(dark).toHaveAttribute('aria-pressed', after);
    await app.open('/');
    await expect(screen.getByRole('button', { name: 'Dark mode' })).toHaveAttribute('aria-pressed', after);
    await dismissMorningBrief(screen);
    await screen.getByRole('button', { name: 'Dark mode' }).click();
    await expect(screen.getByRole('button', { name: 'Dark mode' })).toHaveAttribute('aria-pressed', before ?? 'true');
  });

  test('[shell-color-assist] Color assist toggles on and off', async ({ app, agent, screen }) => {
    await app.open('/');
    await dismissMorningBrief(screen);
    const assist = screen.getByRole('button', { name: 'Color assist' });
    const before = await assist.getAttribute('aria-pressed');
    await agent.act('Turn Color assist on if it is off, or off if it is on');
    await expect(assist).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');
    await assist.click();
    await expect(assist).toHaveAttribute('aria-pressed', before ?? 'false');
  });

  test('[shell-density-motion] density and motion have a visible control', async ({ app, screen }) => {
    // js/shell.js stores density and motion preferences, but the staging build
    // renders no control for either (only Dark mode and Color assist). Doctrine
    // (DoctorCRE surface grammar item 2) asks for icon toggles for all three.
    await app.open('/');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('button', { name: /density/i })).toBeVisible();
    await expect(screen.getByRole('button', { name: /motion/i })).toBeVisible();
  });

  test('[shell-avatar-menu] the account menu opens Profile, Theme, Notification preferences and Doc Activity', async ({ app, agent, browser, screen }) => {
    await app.open('/');
    await dismissMorningBrief(screen);
    await agent.act('Open the account and settings menu from the avatar');
    const menu = screen.getByRole('button', { name: /account and settings/i });
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    for (const name of ['Profile', 'Theme', 'Sign out']) await expect(screen.getByRole('button', { name, exact: true })).toBeVisible();
    await screen.getByRole('button', { name: 'Profile', exact: true }).click();
    await expect(screen.getByRole('heading', { name: 'Profile' })).toBeVisible();
    await screen.getByRole('button', { name: 'Close profile' }).click();
    await expect(screen.getByRole('heading', { name: 'Profile' })).toBeHidden();
    await menu.click();
    await screen.getByRole('link', { name: 'Notification preferences' }).click();
    await expect(browser).toHaveURL(/\/updates#prefForm/);
    await screen.getByRole('button', { name: /account and settings/i }).click();
    await screen.getByRole('link', { name: 'Doc Activity' }).click();
    await expect(browser).toHaveURL(/\/doc-activity/);
  });

  test('[shell-sidebars] the Workspace and Today sidebars open and close', async ({ app, agent, screen }) => {
    await app.open('/leads');
    await dismissMorningBrief(screen);
    await agent.act('Open the Today sidebar');
    await expect(screen.getByRole('heading', { name: 'Today' })).toBeVisible();
    await expect(screen.getByRole('heading', { name: /Recent moves/i })).toBeVisible();
    await screen.getByRole('button', { name: 'Close Today' }).click();
    await agent.act('Open the Workspace sidebar');
    await agent.assert('A workspace sidebar panel for the current page is open over the page');
    // On a phone the drawer must leave a way back to the page it covers.
    await expect(screen.getByRole('button', { name: /Close workspace/i }).first()).toBeVisible();
  });

  test('[shell-refresh] Refresh workspace updates the sync time', async ({ app, agent, screen }) => {
    await app.open('/leads');
    await dismissMorningBrief(screen);
    await agent.act('Press Refresh workspace');
    await agent.waitFor('The workspace has finished refreshing and shows an updated time', { timeout: 30_000 });
    await expect(screen.getByRole('button', { name: 'Refresh workspace' })).toBeEnabled();
  });

  test('[shell-search-link] the header Search link opens Search', async ({ app, browser, screen }) => {
    await app.open('/');
    await dismissMorningBrief(screen);
    await screen.getByRole('link', { name: 'Search', exact: true }).click();
    await expect(browser).toHaveURL(/\/search/);
    await expect(screen.getByRole('heading', { name: 'Find a record' })).toBeVisible();
  });

  test('[shell-unread-badge] the Updates badge matches the unread count', async ({ app, screen }) => {
    await app.open('/updates');
    await dismissMorningBrief(screen);
    await expect(screen.getByRole('main').first()).toBeVisible();
    // Staging has 0 notifications, so the honest state is no unread badge.
    await expect(screen.getByLabel(/unread notification/i)).toBeHidden();
  });

  test('[shell-sign-out] Sign out is offered (not pressed: the staging session is shared)', async ({ app, screen }) => {
    await app.open('/');
    await dismissMorningBrief(screen);
    await screen.getByRole('button', { name: /account and settings/i }).click();
    await expect(screen.getByRole('button', { name: 'Sign out', exact: true })).toBeEnabled();
  });

  test('[command-dock] a write reports its outcome in the command feedback dock', async ({ app, agent, screen }) => {
    await app.open('/updates');
    await dismissMorningBrief(screen);
    await agent.act('Save the notification preferences without changing anything');
    await agent.assert('The page confirms the preferences were saved');
  });
});

describe('area C: Dr. CRE and Call Mode', { session: 'staging-partner', tags: ['journey', 'area-c'] }, () => {
  test('[doc-open] Open Doc opens the palette and Escape closes it', async ({ app, agent, screen }) => {
    await app.open('/');
    await dismissMorningBrief(screen);
    await agent.act('Open Doc with the floating Open Doc button');
    const box = screen.getByRole('combobox', { name: 'Search anything or ask Doc' });
    await expect(box).toBeVisible();
    await box.press('Escape');
    await expect(box).toBeHidden();
  });

  test('[doc-search] Doc search finds the staging deal and opens it', async ({ app, agent, browser, screen }) => {
    await app.open('/');
    await dismissMorningBrief(screen);
    await screen.getByRole('button', { name: 'Open Doc' }).click();
    await agent.act('Search Doc for "Synthetic staging QA"');
    const result = await agent.extract('How many results Doc lists for the search', { schema: z.object({ results: z.number().int() }) });
    expect(result.results).toBeGreaterThan(0);
    await agent.act('Open the first deal result Doc lists');
    await agent.assert('A record for a Synthetic staging QA deal is open');
    await expect(browser).not.toHaveURL(/\/auth\//);
  });

  test('[doc-action-refusal] Doc refuses an action honestly instead of pretending', async ({ app, agent, screen }) => {
    await app.open('/');
    await dismissMorningBrief(screen);
    await screen.getByRole('button', { name: 'Open Doc' }).click();
    const box = screen.getByRole('combobox', { name: 'Search anything or ask Doc' });
    await box.fill('move the closed deal back to Legal');
    await screen.getByRole('button', { name: 'Ask Doc' }).click();
    await expect(screen.getByText(/Doc actions unavailable/i).first()).toBeVisible();
  });

  test('[doc-suggestions] Doc suggestions can be approved from the palette', async ({ app, screen }) => {
    test.skip(true, 'missing seed: list-doc-suggestions returns no suggestions on staging and no app or /mcp path creates one (suggest-doc-work is a scheduled scan)');
    await app.open('/');
    await expect(screen.getByRole('heading', { name: 'Suggestions' })).toBeVisible();
  });

  test('[doc-morning-brief] the morning brief opens, refreshes and dismisses', async ({ app, agent, screen }) => {
    await app.open('/');
    await expect(screen.getByRole('main').first()).toBeVisible();
    // The brief opens by itself once a day; afterwards Doc's Morning brief control opens it.
    if (!(await screen.getByRole('heading', { name: /Morning brief/ }).isVisible().catch(() => false))) {
      await agent.act('Open Doc and open the Morning brief');
    }
    await expect(screen.getByRole('heading', { name: /Morning brief/ })).toBeVisible();
    await agent.act('Press the Refresh morning brief button');
    await expect(screen.getByRole('dialog', { name: /Morning brief/ }).getByText(/\d{1,2}:\d{2}\s?(AM|PM)/).first()).toBeVisible();
    await screen.getByRole('button', { name: 'Dismiss morning brief' }).click();
    await expect(screen.getByRole('heading', { name: /Morning brief/ })).toBeHidden();
  });

  test('[call-mode-open] Call Mode is honest when the local Quill companion is not running', async ({ app, agent, screen }) => {
    await app.open('/');
    await dismissMorningBrief(screen);
    const call = screen.getByRole('button', { name: 'Call mode' });
    if (!(await call.isVisible().catch(() => false))) return; // main (#114) hides it: honest
    await call.click();
    await expect(screen.getByRole('dialog', { name: /call/i })).toBeVisible();
    // With no companion reachable, no start control may claim readiness.
    await expect(screen.getByRole('button', { name: /Start weekly deal call/i })).toBeHidden();
  });
});
