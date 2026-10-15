import { setTimeout as pause } from 'node:timers/promises';
import businessJourneys from '../../contracts/e2e-staging-business-journeys.v1.json' with { type: 'json' };
import invoiceJourney from '../../contracts/e2e-staging-invoice-journey.v1.json' with { type: 'json' };
import { requireSupervisedRun } from './run-limits.mjs';
import { STAGING_ORIGIN } from './session.mjs';
import { stagingAuth } from './auth-contract.mjs';
import { COLUMNS } from '../../js/pipeline-model.js';
import { projectInvoices } from '../../js/invoice-tracker-model.js';

const journeyError = code => Object.assign(new Error(code), { code });
const clickSelector = async (page, selector, timeout) => {
  try { return await page.locator(selector).click({ timeout }); }
  catch { throw journeyError('business-journey-selector-unavailable'); }
};
const fillSelector = async (page, selector, value, timeout) => {
  try { return await page.locator(selector).fill(value, { timeout }); }
  catch { throw journeyError('business-journey-selector-unavailable'); }
};

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
  if (invoiceOnly) return runInvoiceJourney({ page, fixtureGuard, release, deal, run, invoiceProofPath, timeout,
    actor: identity.session.actor.slug });
  const click = selector => clickSelector(page, selector, timeout);
  const fill = (selector, value) => fillSelector(page, selector, value, timeout);
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
          if (row.state === 'unresolved' || row.state === 'inflight' && Date.now() >= deadline)
            throw journeyError('business-journey-settlement-unverified');
          if (row.state === 'acknowledged' && (!readback || row.independent_readback?.matched === true)) return row;
          if (Date.now() >= deadline) throw journeyError(readback
            ? 'business-journey-readback-incomplete' : 'business-journey-receipt-missing');
          await pause(25, undefined, { signal: run.signal });
        }
      };
      const refresh = async () => {
        await click('[data-refresh-detail]');
        return waitForReceipt(true);
      };
      let observation;
      if (definition.operation === 'patch-deal-field') {
        const initial = await page.locator(definition.prepare_selector).inputValue();
        if (initial !== definition.initial_phase)
          throw new Error('Business journey initial fixture phase refused; reconciliation required');
        const columns = await page.locator('.kanban-column').evaluateAll(nodes => nodes.map(node => node.dataset.column));
        if (columns.length !== COLUMNS.length || columns.some((slug, index) => slug !== COLUMNS[index].slug))
          throw new Error('Business journey board columns refused; reconciliation required');
        const initialColumn = COLUMNS.find(column => column.slug === initial);
        const target = COLUMNS.find(column => column.slug === definition.value);
        const card = page.locator(`.kanban-card[data-id="${deal}"]`);
        if (!initialColumn || !target || await card.getAttribute('data-phase') !== initialColumn.value)
          throw new Error('Business journey drag source or target refused; reconciliation required');
        if (new URL(page.url()).searchParams.get('deal') === deal) await click('#panelClose');
        const presenceSpec = { journey: id, step: definition.id, deal, field: 'phase', release };
        const drop = async () => {
          const admission = await fixtureGuard.admitBusinessJourneyPresence({ ...presenceSpec, phase: 'admit' });
          try {
            await card.dragTo(page.locator(`.kanban-column[data-column="${target.slug}"]`), { timeout });
            await page.locator('#completionDialog').waitFor({ state: 'visible', timeout });
          } catch { throw journeyError('business-journey-selector-unavailable'); }
          const settled = await fixtureGuard.admitBusinessJourneyPresence({ ...presenceSpec, phase: 'settle',
            admission_id: admission.admission_id });
          if (settled.state !== 'settled' || !settled.receipt_sha256)
            throw journeyError('business-journey-settlement-unverified');
        };
        await drop();
        await click('#completionCancel');
        await page.locator('#completionDialog').waitFor({ state: 'hidden', timeout });
        if (await card.getAttribute('data-phase') !== initialColumn.value)
          throw new Error('Business journey cancelled drag changed the phase; reconciliation required');
        const cancelled = await fixtureGuard.admitBusinessJourneyStep({ ...spec, phase: 'status' });
        if (cancelled.state !== 'admitted' || cancelled.dispatched_outcome !== 'not dispatched')
          throw new Error('Business journey cancelled move dispatched unexpectedly; reconciliation required');
        await drop();
        await click(definition.selector);
        const receipt = await waitForReceipt();
        await card.waitFor({ state: 'visible', timeout });
        await click('#retryRead');
        await page.waitForFunction(({ deal, phase }) => document.querySelector(`.kanban-card[data-id="${deal}"]`)?.dataset.phase === phase,
          { deal, phase: target.value }, { timeout });
        const movedColumn = page.locator(`.kanban-column[data-column="${target.slug}"]`);
        if (await movedColumn.locator(`.kanban-card[data-id="${deal}"]`).count() !== 1)
          throw new Error('Business journey destination column refused; reconciliation required');
        await click(`.kanban-card[data-id="${deal}"]`);
        await page.locator('#detailPhase').waitFor({ state: 'visible', timeout });
        await refresh();
        await page.waitForFunction(value => document.querySelector('#detailPhase')?.value === value,
          definition.value, { timeout });
        const phase = await page.locator('#detailPhase').inputValue();
        const phaseDay = receipt.response.binding.effect.event_recorded_at?.slice(0, 10);
        const phaseRail = page.locator('.phase-rail li[aria-current="step"] time');
        if (!phaseDay || await phaseRail.getAttribute('datetime') !== phaseDay)
          throw new Error('Business journey recorded phase date refused; reconciliation required');
        const timelineRange = page.locator('#timelineRange');
        await timelineRange.selectOption('full', { timeout });
        const phaseTimeline = page.locator('.deal-timeline');
        await phaseTimeline.waitFor({ state: 'visible', timeout });
        if (await timelineRange.inputValue() !== 'full' || !await phaseTimeline.locator('.timeline-chart').isVisible())
          throw new Error('Business journey full timeline refused; reconciliation required');
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
        await fill(definition.date_selector, admitted.argument_template.due_on);
        await fill(definition.source_selector, admitted.argument_template.source);
        await click('#dealDateCancel');
        await page.locator('#dealDateDialog').waitFor({ state: 'hidden', timeout });
        const cancelled = await fixtureGuard.admitBusinessJourneyStep({ ...spec, phase: 'status' });
        if (cancelled.state !== 'admitted' || cancelled.dispatched_outcome !== 'not dispatched')
          throw new Error('Business journey cancelled date dispatched unexpectedly; reconciliation required');
        await click(definition.prepare_selector);
        await fill(definition.date_selector, admitted.argument_template.due_on);
        await fill(definition.source_selector, admitted.argument_template.source);
        await click(definition.selector);
        const receipt = await waitForReceipt();
        await page.waitForFunction(() => !document.querySelector('#dealDateDialog')?.open, undefined, { timeout });
        await refresh();
        const dateId = receipt.response.binding.effect.critical_date_id;
        const card = page.locator(`[data-date-id="${dateId}"]`);
        await card.waitFor({ state: 'visible', timeout });
        if (await page.locator(`[data-add-date="${definition.kind}"]`).count() !== 0)
          throw new Error('Business journey added date control remained visible; reconciliation required');
        const countdown = card.locator('[data-countdown]');
        await countdown.waitFor({ state: 'visible', timeout });
        const countdownText = (await countdown.textContent())?.trim();
        if (await countdown.getAttribute('data-countdown') !== receipt.response.binding.effect.due_on ||
            !countdownText || countdownText === '—')
          throw new Error('Business journey date countdown refused; reconciliation required');
        await click(`[data-date-id="${dateId}"] summary`);
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

async function runInvoiceJourney({ page, fixtureGuard, release, deal, run, invoiceProofPath, timeout, actor }) {
  const click = selector => clickSelector(page, selector, timeout);
  const fill = (selector, value) => fillSelector(page, selector, value, timeout);
  const spec = { journey: 'W15', step: 'paid', deal, release };
  const invoke = (phase, values = {}) => fixtureGuard.admitBusinessJourneyStep({ ...spec, phase, ...values });
  const binding = invoiceProofPath ? await invoke('import-fixture', { proofPath: invoiceProofPath }) : await invoke('fixture-status');
  const id = binding.proof.fixture.commission_id;
  const invoiceSets = async () => {
    run.check();
    let read;
    try {
      read = await page.evaluate(async () => {
        const { createLiveClient } = await import('/js/live-client.js');
        const { localToday } = await import('/js/calendar-model.js');
        return { payload: await createLiveClient().getInvoiceTracker(), today: localToday() };
      });
    } catch { throw journeyError('business-journey-readback-incomplete'); }
    if (read?.payload?.actor !== actor) throw journeyError('business-journey-readback-incomplete');
    const team = projectInvoices(read.payload, { scope: 'team', today: read.today });
    const mine = projectInvoices(read.payload, { scope: 'mine', today: read.today });
    if (!team || !mine) throw journeyError('business-journey-readback-incomplete');
    return { team, mine };
  };
  const expectedKeys = rows => rows.map(row => row.key).sort();
  const requireInvoiceRows = async rows => {
    try {
      await page.waitForFunction(expected => {
        const actual = [...document.querySelectorAll('#invoiceRows .invoice-row[data-invoice-key]')]
          .map(node => node.dataset.invoiceKey).sort();
        return JSON.stringify(actual) === JSON.stringify(expected);
      }, expectedKeys(rows), { timeout });
    } catch { throw new Error('Invoice tracker filter set refused; reconciliation required'); }
  };
  const requireHomeScope = async (scope, sets) => {
    const expected = sets[scope].filter(row => row.overdue).map(row => `invoice:${row.key}`).sort();
    try {
      await page.waitForFunction(expected => {
        const root = document.querySelector('#homeInvoices');
        if (!root) return false;
        const displayed = root.hidden ? [] : [...root.querySelectorAll('[data-home-key^="invoice:"]')]
          .map(item => item.dataset.homeKey).sort();
        return JSON.stringify(displayed) === JSON.stringify(expected);
      }, expected, { timeout });
    } catch { throw new Error('Invoice Home overdue set refused; reconciliation required'); }
  };
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
      if (value.state === 'unavailable' || Date.now() >= deadline)
        throw journeyError('business-journey-readback-incomplete');
      await pause(25, undefined, { signal: run.signal });
    }
  };
  const refreshHome = async () => {
    await invoke('fixture-refresh');
    await click('#refreshHome');
    const value = await measured();
    await page.waitForFunction(() => document.querySelector('#refreshHome')?.getAttribute('aria-busy') === 'false', undefined, { timeout });
    return value;
  };
  const refreshInvoices = async () => {
    await invoke('fixture-refresh');
    await click('#refreshInvoices');
    return measured();
  };
  await page.locator('#refreshHome').waitFor({ state: 'visible', timeout });
  await refreshHome();
  if (prior?.journey.state === 'observed') {
    await invoke('admit');
    await fixtureGuard.assertCoverage();
    return { schema: 'staging-business-journey-result.v1', completed: ['W15'], steps: [{ journey: 'W15', step: 'paid', state: 'previously-observed' }],
      release: { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit }, full_v1_qualified: false };
  }
  await page.goto(STAGING_ORIGIN + '/invoices', { timeout });
  await page.locator('#refreshInvoices').waitFor({ state: 'visible', timeout });
  const invoiceSnapshot = await refreshInvoices();
  const beforeSets = await invoiceSets();
  const beforeRow = beforeSets.team.find(row => row.key === id);
  if (beforeRow?.status !== 'unpaid' || !beforeSets.mine.some(row => row.key === id))
    throw journeyError('business-journey-readback-incomplete');
  const statusRow = page.locator(`[data-invoice-key="${id}"]`);
  await click('[data-status="unpaid"]');
  await statusRow.waitFor({ state: 'visible', timeout });
  await requireInvoiceRows(beforeSets.team.filter(row => row.status === 'unpaid'));
  const ageBucket = await statusRow.getAttribute('data-age');
  if (ageBucket !== String(beforeRow.bucket)) throw new Error('Invoice age bucket refused; reconciliation required');
  await click(`#invoiceAging [data-age="${ageBucket}"]`);
  await statusRow.waitFor({ state: 'visible', timeout });
  await requireInvoiceRows(beforeSets.team.filter(row => row.status === 'unpaid' && row.bucket === beforeRow.bucket));
  if (await page.locator('#invoiceFiltered').textContent() === '') throw new Error('Invoice age filter was not applied');
  await click('#allAges');
  if (await page.locator('#allAges').getAttribute('aria-pressed') !== 'true') throw new Error('Invoice age reset refused');
  await requireInvoiceRows(beforeSets.team.filter(row => row.status === 'unpaid'));
  await click('#clearInvoiceFilters');
  if (await page.locator('[data-status="all"]').getAttribute('aria-pressed') !== 'true' ||
      await page.locator('#invoiceOwner').inputValue() !== '' || await page.locator('#invoiceSearch').inputValue() !== '')
    throw new Error('Invoice filter reset refused');
  await requireInvoiceRows(beforeSets.team);
  await click('[data-status="awaiting"]');
  await requireInvoiceRows(beforeSets.team.filter(row => row.status === 'awaiting'));
  if (invoiceSnapshot.proof.fixture.commission_id !== id || beforeSets.team.some(row => row.key === id && row.status === 'awaiting'))
    throw new Error('Invoice fixture status set changed; reconciliation required');
  await page.goto(STAGING_ORIGIN + '/', { timeout });
  await page.locator('#refreshHome').waitFor({ state: 'visible', timeout });
  await refreshHome();
  const beforeHomeSets = await invoiceSets();
  if (!beforeHomeSets.mine.some(row => row.key === id && row.overdue) ||
      !beforeHomeSets.team.some(row => row.key === id && row.overdue))
    throw journeyError('business-journey-readback-incomplete');
  const flag = page.locator(`[data-home-key="invoice:${id}"]`);
  for (const scope of ['mine', 'team']) {
    await click(`[data-scope="${scope}"]`);
    if (await page.locator(`[data-scope="${scope}"]`).getAttribute('aria-pressed') !== 'true')
      throw new Error('Invoice Home scope selection refused');
    await requireHomeScope(scope, beforeHomeSets);
  }
  if (new URL(await flag.getAttribute('href'), STAGING_ORIGIN).searchParams.get('invoice') !== id) throw new Error('Invoice fixture link refused');
  const before = { commission_id: (await flag.getAttribute('data-home-key')).slice('invoice:'.length), home_attention_present: await flag.isVisible() };
  await click(`[data-home-key="invoice:${id}"]`);
  await page.locator('#invoiceDetail').waitFor({ state: 'visible', timeout });
  const fresh = await invoke('fixture-status');
  const max = await page.locator('#invoicePaidDate').getAttribute('max');
  const received = [max, fresh.before_tracker_readback?.row?.as_of].sort()[0];
  await invoke('admit', { received_on: received, before_observation: before });
  await fill(invoiceJourney.journeys[0].steps[0].date_selector, received);
  await click(invoiceJourney.journeys[0].steps[0].selector);
  const deadline = Date.now() + run.limits.settlementMs;
  let row;
  for (;;) {
    run.check(); row = await invoke('status');
    if (fixtureGuard.refusals.length) await fixtureGuard.assertCoverage();
    if (row.state === 'acknowledged') break;
    if (row.state === 'unresolved' || Date.now() >= deadline)
      throw journeyError('business-journey-settlement-unverified');
    await pause(25, undefined, { signal: run.signal });
  }
  await page.waitForFunction(() => document.querySelector('.invoice-status-value')?.textContent === 'Paid' && document.querySelector('#invoicePayment')?.hidden, undefined, { timeout });
  const status = await page.locator('.invoice-status-value').textContent();
  const paymentHidden = await page.locator('#invoicePayment').evaluate(node => node.hidden);
  const day = await page.locator('#invoiceTimeline .invoice-milestone:last-child time').getAttribute('datetime');
  await click('#closeInvoiceDetail');
  await page.goto(STAGING_ORIGIN + '/invoices', { timeout });
  await page.locator('#refreshInvoices').waitFor({ state: 'visible', timeout });
  await refreshInvoices();
  const paidSets = await invoiceSets();
  if (!paidSets.team.some(row => row.key === id && row.status === 'paid'))
    throw journeyError('business-journey-readback-incomplete');
  await click('[data-status="paid"]');
  await statusRow.waitFor({ state: 'visible', timeout });
  await requireInvoiceRows(paidSets.team.filter(row => row.status === 'paid'));
  if (await statusRow.locator('.invoice-state').textContent() !== 'Paid')
    throw new Error('Invoice paid status filter did not show the recorded paid row');
  row = await invoke('status');
  if (!row.independent_readback?.matched) throw new Error('Invoice marker independent coverage incomplete');
  await page.goto(STAGING_ORIGIN + '/', { timeout });
  await page.locator('#refreshHome').waitFor({ state: 'visible', timeout });
  await refreshHome();
  const paidHomeSets = await invoiceSets();
  for (const scope of ['mine', 'team']) {
    await click(`[data-scope="${scope}"]`);
    if (await page.locator(`[data-scope="${scope}"]`).getAttribute('aria-pressed') !== 'true' ||
        paidHomeSets[scope].some(item => item.key === id && item.overdue))
      throw new Error('Paid invoice remained in a Home attention scope; reconciliation required');
    await requireHomeScope(scope, paidHomeSets);
  }
  const observation = { commission_id: id, received_on: day, status, payment_form_hidden: paymentHidden,
    home_attention_removed: await page.locator(`[data-home-key="invoice:${id}"]`).count() === 0 };
  row = await invoke('observe', { observation });
  await fixtureGuard.assertCoverage();
  return { schema: 'staging-business-journey-result.v1', completed: ['W15'],
    steps: [{ journey: 'W15', step: 'paid', state: row.journey.state, ui_sha256: row.journey.ui.observation_sha256,
      readback_sha256: row.independent_readback.response_sha256 }],
    release: { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit }, full_v1_qualified: false };
}
