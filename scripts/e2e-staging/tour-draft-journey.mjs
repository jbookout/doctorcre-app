import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import contract from '../../contracts/e2e-staging-tour-drafts.v1.json' with { type: 'json' };
import { assertStagingContextCoverage } from './engine.mjs';
import { requireSupervisedRun } from './run-limits.mjs';
import { STAGING_ORIGIN } from './session.mjs';
import { stagingAuth } from './auth-contract.mjs';
import { qualifyTourJourney } from './tour-journey.mjs';
import { observedV1Action } from './v1-qualification.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => { throw new Error('W6 owned local draft qualification refused'); };
const absentArea = () => { throw Object.assign(new Error('W6 owned local draft area unavailable; qualification refused'),
  { code: 'tour-draft-client-area-unavailable' }); };
const sourcePairFor = value => ({ source_commit: value.app, carr_source_commit: value.carr });

async function readOwnClient({ clientId, timeout }) {
  const response = await fetch(`/api/v1/business/clients/${encodeURIComponent(clientId)}`, {
    credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) return null;
  const payload = await response.json();
  return (payload?.data || payload)?.record;
}

export async function runTourDraftJourney({ page, plan, sourcePair, fixtureBinding, run } = {}) {
  run = requireSupervisedRun(undefined, run);
  run.check();
  if (new URL(page?.url?.() || 'about:blank').origin !== STAGING_ORIGIN ||
      new URL(page.url()).pathname !== '/tours' ||
      sourcePair?.carr !== contract.producer.carr_source_commit ||
      plan?.schema !== 'doctorcre-staging-records-plan.v1' || plan.state !== 'complete' || plan.inflight ||
      plan.release?.source_commit !== sourcePair.app || plan.release?.carr_source_commit !== sourcePair.carr ||
      !plan.records?.tour_draft_party?.id || !plan.records?.tour_draft_client?.id ||
      !plan.records?.tour?.id || !plan.observed_at ||
      plan.receipts?.tour_draft_party?.party_id !== plan.records.tour_draft_party.id ||
      plan.receipts?.tour_draft_client?.client_id !== plan.records.tour_draft_client.id ||
      plan.records.tour_draft_party.city !== 'Pensacola' || plan.records.tour_draft_party.state !== 'FL' ||
      plan.records.tour_draft_client.party_id !== plan.records.tour_draft_party.id) fail();
  for (const [path, expected] of Object.entries(contract.sources)) {
    if (createHash('sha256').update(await readFile(new URL('../../' + path, import.meta.url))).digest('hex') !== expected) fail();
  }
  await assertStagingContextCoverage(page.context());
  const timeout = Math.max(1, Math.min(run.limits.httpTimeoutMs, run.limits.settlementMs));
  const identity = await page.evaluate(async limit => {
    const [app, session] = await Promise.all([
      fetch('/app-release', { credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.timeout(limit) }).then(response => response.json()),
      fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.timeout(limit) }).then(response => response.json()),
    ]);
    return { app, session };
  }, timeout);
  if (identity.app?.service !== 'doctorcre-app' || identity.app.environment !== 'staging' ||
      identity.app.source_commit !== sourcePair.app ||
      !stagingAuth.session.matches(identity.session)) fail();
  const client = await page.evaluate(readOwnClient, { clientId: plan.records.tour_draft_client.id, timeout });
  const area = [client?.city, client?.state].filter(Boolean).join(', ');
  if (client?.id !== plan.records.tour_draft_client.id || client.name !== plan.records.tour_draft_client.name ||
      area !== 'Pensacola, FL' || area.length > 200)
    fail();
  if (!area) absentArea();
  const action = (name, ui, readback) => observedV1Action({ id: 'W6', case: 'tours-drafts', action: name,
    sourcePair: sourcePairFor(sourcePair), runId: run.snapshot().id, fixtureRun: plan.run, ui, readback });
  const actions = [];
  const clientPicker = page.locator('#plan-client');
  await clientPicker.locator(`option[value="${client.id}"]`).waitFor({ state: 'attached', timeout });
  await clientPicker.selectOption(client.id, { timeout });
  await page.waitForFunction(expected => document.querySelector('#plan-area')?.value === expected, area, { timeout });
  const name = await page.locator('#plan-name').inputValue();
  if (!name.startsWith(client.name) || !name.endsWith(' · Tour')) fail();
  actions.push(action('client-prefill', { name: digest(name), area: digest(area), selected: true },
    { client_id: client.id, client_name: digest(client.name), party_id: plan.records.tour_draft_party.id,
      source_pair: sourcePair }));
  await page.locator('#plan-area').fill('Typed synthetic QA area', { timeout });
  await page.locator('#plan-undo').click({ timeout });
  if (await page.locator('#plan-area').inputValue() !== area) fail();
  actions.push(action('edit-undo', { restored_area: digest(area) }, { client_id: client.id,
    party_id: plan.records.tour_draft_party.id, area: digest(area) }));
  const day = new Date(Date.parse(plan.observed_at.slice(0, 10) + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
  await page.locator('#plan-date').fill(day, { timeout });
  const market = page.locator('[data-market]').first();
  await market.waitFor({ state: 'visible', timeout });
  const marketArea = await market.getAttribute('data-market');
  if (!marketArea || marketArea.length > 200) fail();
  await market.click({ timeout });
  if (await page.locator('#space-area').inputValue() !== marketArea) fail();
  await page.locator('#space-minSize').fill('1800', { timeout });
  const requirements = 'Synthetic QA ground floor and accessible entry';
  await page.locator('#space-requirements').fill(requirements, { timeout });
  await page.locator('#save-search').click({ timeout });
  await page.waitForFunction(() => document.querySelector('#space-message')?.textContent?.includes('saved'), undefined, { timeout });
  actions.push(action('draft-save', { market: digest(marketArea), size: '1800', requirements: digest(requirements) },
    { client_id: client.id, party_id: plan.records.tour_draft_party.id, storage: 'authenticated-tab-draft' }));
  await page.reload({ waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(expected => document.querySelector('#space-requirements')?.value === expected,
    requirements, { timeout });
  const restored = {
    client: await page.locator('#plan-client').inputValue(), name: await page.locator('#plan-name').inputValue(),
    area: await page.locator('#plan-area').inputValue(), date: await page.locator('#plan-date').inputValue(),
    market: await page.locator('#space-area').inputValue(), size: await page.locator('#space-minSize').inputValue(),
    requirements: await page.locator('#space-requirements').inputValue(),
  };
  if (restored.client !== client.id || restored.name !== name || restored.area !== area || restored.date !== day ||
      restored.market !== marketArea || restored.size !== '1800' || restored.requirements !== requirements) fail();
  actions.push(action('draft-reload', { values: digest(restored), party_id: plan.records.tour_draft_party.id },
    { client_id: client.id, source_pair: sourcePair }));
  const tour = await qualifyTourJourney({ page, plan, sourcePair, fixtureBinding, run });
  actions.push(action('upcoming-detail', { ui: tour.ui.sha256 }, { detail: tour.backend_readback.sha256,
    tour_id: plan.records.tour.id }));
  await assertStagingContextCoverage(page.context());
  return { schema: contract.schema, actions, tour, source_pair: sourcePairFor(sourcePair),
    run_id: run.snapshot().id, fixture_run: plan.run, full_v1_qualified: false };
}
