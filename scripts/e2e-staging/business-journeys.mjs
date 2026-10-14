import { setTimeout as pause } from 'node:timers/promises';
import businessJourneys from '../../contracts/e2e-staging-business-journeys.v1.json' with { type: 'json' };
import { requireSupervisedRun } from './run-limits.mjs';
import { STAGING_ORIGIN } from './session.mjs';
import { stagingAuth } from './auth-contract.mjs';
import { COLUMNS } from '../../js/pipeline-model.js';

export async function runBusinessJourneys({ page, fixtureGuard, release, deal, run,
  journeys = businessJourneys.journeys.map(journey => journey.id) } = {}) {
  run = requireSupervisedRun(undefined, run);
  run.check();
  const url = new URL(page.url());
  if (url.origin !== STAGING_ORIGIN || url.pathname !== '/deals' ||
      url.searchParams.get('deal') !== deal || !Array.isArray(journeys) || !journeys.length ||
      new Set(journeys).size !== journeys.length || journeys.some(id => !businessJourneys.journeys.some(journey => journey.id === id)))
    throw new Error('Business journey fixture route or scope refused');
  const identity = await page.evaluate(async () => {
    const release = await fetch('/app-release', { credentials: 'same-origin', cache: 'no-store' });
    const session = await fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!release.ok || !session.ok) return null;
    const app = await release.json(), actor = await session.json();
    return { service: app.service, environment: app.environment, source_commit: app.source_commit,
      session: { actor: { slug: actor.actor?.slug }, e2e_principal: actor.e2e_principal } };
  });
  if (identity?.service !== 'doctorcre-app' || identity.environment !== 'staging' ||
      identity.source_commit !== release?.source_commit ||
      release?.carr_source_commit !== businessJourneys.producer.source_commit)
    throw new Error('Business journey source pair refused');
  if (!stagingAuth.session.matches(identity.session)) throw new Error('Business journey signed-in session refused');
  const timeout = Math.min(run.limits.httpTimeoutMs, run.limits.settlementMs);
  const click = selector => page.locator(selector).click({ timeout });
  const complete = [], steps = [];
  for (const id of journeys) {
    for (const definition of businessJourneys.journeys.find(journey => journey.id === id).steps) {
      run.check();
      const spec = { journey: id, step: definition.id, deal, release };
      const admitted = await fixtureGuard.admitBusinessJourneyStep({ ...spec, phase: 'admit' });
      if (admitted.journey.state === 'observed') {
        steps.push({ journey: id, step: definition.id, state: 'previously-observed' });
        continue;
      }
      const deadline = Date.now() + run.limits.settlementMs;
      const waitForReceipt = async (readback = false) => {
        for (;;) {
          run.check();
          const row = await fixtureGuard.admitBusinessJourneyStep({ ...spec, phase: 'status' });
          if (fixtureGuard.refusals.length) await fixtureGuard.assertCoverage();
          if (['unresolved', 'inflight'].includes(row.state) && Date.now() >= deadline || row.state === 'unresolved')
            throw new Error('Business journey dispatch unresolved; reconciliation required');
          if (row.state === 'acknowledged' && (!readback || row.independent_readback?.matched === true)) return row;
          if (Date.now() >= deadline) throw new Error('Business journey coverage incomplete; reconciliation required');
          await pause(25, undefined, { signal: run.signal });
        }
      };
      const refresh = async () => {
        await click('[data-refresh-detail]');
        return waitForReceipt(true);
      };
      let observation;
      if (definition.operation === 'patch-deal-field') {
        if (await page.locator(definition.prepare_selector).inputValue() !== definition.initial_phase)
          throw new Error('Business journey initial fixture phase refused; reconciliation required');
        await page.locator(definition.prepare_selector).selectOption(definition.value, { timeout });
        await click(definition.selector);
        const receipt = await waitForReceipt();
        await refresh();
        await page.waitForFunction(value => document.querySelector('#detailPhase')?.value === value,
          definition.value, { timeout });
        const phase = await page.locator('#detailPhase').inputValue();
        await click('#panelClose');
        if (!await page.locator('#appToday').isVisible()) await click('#appTodayToggle');
        const event = receipt.response.binding.effect.event_id;
        const undo = page.locator(`button[data-undo="${event}"]`);
        await undo.waitFor({ state: 'visible', timeout });
        observation = { phase, event_id: await undo.getAttribute('data-undo') };
      } else if (definition.operation === 'revert-deal-field') {
        const event = admitted.argument_template.event_id;
        await click(`button[data-undo="${event}"]`);
        const receipt = await waitForReceipt();
        const badge = page.locator(`[data-receipt="${event}"] .receipt-badge.undone`);
        await badge.waitFor({ state: 'visible', timeout });
        const badgeText = await badge.textContent();
        const phase = receipt.response.binding.effect.new_value;
        await page.waitForFunction(({ deal, value }) => document.querySelector(`.kanban-card[data-id="${deal}"]`)?.dataset.phase === value,
          { deal, value: COLUMNS.find(column => column.slug === phase).value }, { timeout });
        await click(`.kanban-card[data-id="${deal}"]`);
        await page.locator('#detailPhase').waitFor({ state: 'visible', timeout });
        await refresh();
        await page.waitForFunction(value => document.querySelector('#detailPhase')?.value === value, phase, { timeout });
        observation = { phase: await page.locator('#detailPhase').inputValue(), reverted_event_id: event, badge: badgeText };
      } else if (definition.operation === 'add-critical-date') {
        await click(definition.prepare_selector);
        await page.locator(definition.date_selector).fill(admitted.argument_template.due_on, { timeout });
        await page.locator(definition.source_selector).fill(admitted.argument_template.source, { timeout });
        await click(definition.selector);
        const receipt = await waitForReceipt();
        await page.waitForFunction(() => !document.querySelector('#dealDateDialog')?.open, undefined, { timeout });
        await refresh();
        const dateId = receipt.response.binding.effect.critical_date_id;
        const card = page.locator(`[data-date-id="${dateId}"]`);
        await card.waitFor({ state: 'visible', timeout });
        await card.locator('summary').click({ timeout });
        await card.locator('.note-original').waitFor({ state: 'visible', timeout });
        observation = { critical_date_id: await card.getAttribute('data-date-id'),
          due_on: await card.locator('time').getAttribute('datetime'), source: await card.locator('.note-original').textContent() };
      } else throw new Error('Business journey operation refused');
      const observed = await fixtureGuard.admitBusinessJourneyStep({ ...spec, phase: 'observe', observation });
      steps.push({ journey: id, step: definition.id, state: observed.journey.state,
        ui_sha256: observed.journey.ui.observation_sha256,
        readback_sha256: observed.independent_readback.response_sha256 });
    }
    complete.push(id);
  }
  await fixtureGuard.assertCoverage();
  return { schema: 'staging-business-journey-result.v1', completed: complete, steps,
    release: { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit },
    full_v1_qualified: false, unqualified_journeys: [...businessJourneys.unqualified_journeys] };
}
