import { setTimeout as pause } from 'node:timers/promises';
import businessJourneys from '../../contracts/e2e-staging-business-journeys.v1.json' with { type: 'json' };
import invoiceJourney from '../../contracts/e2e-staging-invoice-journey.v1.json' with { type: 'json' };
import { requireSupervisedRun } from './run-limits.mjs';
import { STAGING_ORIGIN } from './session.mjs';
import { stagingAuth } from './auth-contract.mjs';
import { COLUMNS } from '../../js/pipeline-model.js';

export async function runBusinessJourneys({ page, fixtureGuard, release, deal, run,
  journeys = businessJourneys.journeys.map(journey => journey.id), invoiceProofPath } = {}) {
  run = requireSupervisedRun(undefined, run);
  run.check();
  const url = new URL(page.url());
  const invoiceOnly = journeys?.length === 1 && journeys[0] === 'W15';
  if (url.origin !== STAGING_ORIGIN || (invoiceOnly ? !['/', '/invoices'].includes(url.pathname) :
      url.pathname !== '/deals' || url.searchParams.get('deal') !== deal) || !Array.isArray(journeys) || !journeys.length ||
      new Set(journeys).size !== journeys.length || journeys.some(id => id !== 'W15' && !businessJourneys.journeys.some(journey => journey.id === id)) ||
      journeys.includes('W15') && !invoiceOnly)
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
  if (invoiceOnly) return runInvoiceJourney({ page, fixtureGuard, release, deal, run, invoiceProofPath, timeout });
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

async function runInvoiceJourney({ page, fixtureGuard, release, deal, run, invoiceProofPath, timeout }) {
  const spec = { journey: 'W15', step: 'paid', deal, release };
  const invoke = (phase, values = {}) => fixtureGuard.admitBusinessJourneyStep({ ...spec, phase, ...values });
  const binding = invoiceProofPath ? await invoke('import-fixture', { proofPath: invoiceProofPath }) : await invoke('fixture-status');
  const id = binding.proof.fixture.commission_id;
  const currentURL = new URL(page.url());
  if (currentURL.pathname === '/invoices' && currentURL.searchParams.get('invoice') !== id) throw new Error('Invoice fixture route refused');
  const prior = await invoke('status');
  if (prior && prior.journey.state !== 'observed') await invoke('admit');
  if (currentURL.pathname !== '/') await page.goto(STAGING_ORIGIN + '/', { timeout });
  const measured = async () => {
    const deadline = Date.now() + run.limits.settlementMs;
    for (;;) {
      run.check();
      const value = await invoke('fixture-status');
      if (value.current_tracker_readback) return value;
      if (value.state === 'unavailable' || Date.now() >= deadline) throw new Error('Invoice fixture independent readback unproved');
      await pause(25, undefined, { signal: run.signal });
    }
  };
  const refreshHome = async () => {
    await invoke('fixture-refresh');
    await page.locator('#refreshHome').click({ timeout });
    const value = await measured();
    await page.waitForFunction(() => document.querySelector('#refreshHome')?.getAttribute('aria-busy') === 'false', undefined, { timeout });
    return value;
  };
  await page.locator('#refreshHome').waitFor({ state: 'visible', timeout });
  await refreshHome();
  if (prior?.journey.state === 'observed') {
    await invoke('admit');
    await fixtureGuard.assertCoverage();
    return { schema: 'staging-business-journey-result.v1', completed: ['W15'], steps: [{ journey: 'W15', step: 'paid', state: 'previously-observed' }],
      release: { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit }, full_v1_qualified: false };
  }
  const flag = page.locator(`[data-home-key="invoice:${id}"]`);
  for (const scope of ['mine', 'team']) {
    await page.locator(`[data-scope="${scope}"]`).click({ timeout });
    await flag.waitFor({ state: 'visible', timeout });
  }
  if (new URL(await flag.getAttribute('href'), STAGING_ORIGIN).searchParams.get('invoice') !== id) throw new Error('Invoice fixture link refused');
  const before = { commission_id: (await flag.getAttribute('data-home-key')).slice('invoice:'.length), home_attention_present: await flag.isVisible() };
  await flag.click({ timeout });
  await page.locator('#invoiceDetail').waitFor({ state: 'visible', timeout });
  const fresh = await invoke('fixture-status');
  const max = await page.locator('#invoicePaidDate').getAttribute('max');
  const received = [max, fresh.before_tracker_readback?.row?.as_of].sort()[0];
  await invoke('admit', { received_on: received, before_observation: before });
  await page.locator(invoiceJourney.journeys[0].steps[0].date_selector).fill(received, { timeout });
  await page.locator(invoiceJourney.journeys[0].steps[0].selector).click({ timeout });
  const deadline = Date.now() + run.limits.settlementMs;
  let row;
  for (;;) {
    run.check(); row = await invoke('status');
    if (fixtureGuard.refusals.length) await fixtureGuard.assertCoverage();
    if (row.state === 'acknowledged') break;
    if (row.state === 'unresolved' || Date.now() >= deadline) throw new Error('Invoice marker unresolved; reconciliation required');
    await pause(25, undefined, { signal: run.signal });
  }
  await page.waitForFunction(() => document.querySelector('.invoice-status-value')?.textContent === 'Paid' && document.querySelector('#invoicePayment')?.hidden, undefined, { timeout });
  const status = await page.locator('.invoice-status-value').textContent();
  const paymentHidden = await page.locator('#invoicePayment').evaluate(node => node.hidden);
  const day = await page.locator('#invoiceTimeline .invoice-milestone:last-child time').getAttribute('datetime');
  await page.locator('#closeInvoiceDetail').click({ timeout });
  await invoke('fixture-refresh');
  await page.locator('#refreshInvoices').click({ timeout });
  await measured();
  row = await invoke('status');
  if (!row.independent_readback?.matched) throw new Error('Invoice marker independent coverage incomplete');
  await page.goto(STAGING_ORIGIN + '/', { timeout });
  await page.locator('#refreshHome').waitFor({ state: 'visible', timeout });
  await refreshHome();
  const observation = { commission_id: id, received_on: day, status, payment_form_hidden: paymentHidden,
    home_attention_removed: await page.locator(`[data-home-key="invoice:${id}"]`).count() === 0 };
  row = await invoke('observe', { observation });
  await fixtureGuard.assertCoverage();
  return { schema: 'staging-business-journey-result.v1', completed: ['W15'],
    steps: [{ journey: 'W15', step: 'paid', state: row.journey.state, ui_sha256: row.journey.ui.observation_sha256,
      readback_sha256: row.independent_readback.response_sha256 }],
    release: { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit }, full_v1_qualified: false };
}
