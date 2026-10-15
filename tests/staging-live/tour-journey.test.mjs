import assert from 'node:assert/strict';
import test from 'node:test';
import contract from '../../contracts/e2e-staging-tour-journey.v1.json' with { type: 'json' };
import { qualifyTourJourney } from '../../scripts/e2e-staging/tour-journey.mjs';

const app = 'a'.repeat(40), carr = '5ddaa8f39507de3f3343c5cc5177d3d07168e9eb';
const tourId = '22222222-2222-4222-8222-222222222222';
const clientId = '11111111-1111-4111-8111-111111111111';
const routeId = '33333333-3333-4333-8333-333333333333';
const stopId = '44444444-4444-4444-8444-444444444444';
const propertyId = '55555555-5555-4555-8555-555555555555';
const runId = '66666666-6666-4666-8666-666666666666';
const key = '77777777-7777-4777-8777-777777777777';
const sourcePair = { app, carr };
const plan = {
  schema: 'doctorcre-staging-records-plan.v1', origin: contract.origin, state: 'complete', run: runId,
  release: { source_commit: app, carr_source_commit: carr }, inflight: null,
  keys: { tour: key }, names: { tour: 'Synthetic staging QA tour' },
  records: { client: { id: clientId }, tour: { id: tourId, name: 'Synthetic staging QA tour' } },
  receipts: {},
};
const fixtureBinding = {
  schema: contract.fixture_binding.schema, provenance: 'private_installer_raw_readback',
  run: runId, source_pair: sourcePair, tour_id: tourId, route_version_id: routeId,
  excluded_stop_id: stopId, synthetic_property_id: propertyId,
};
const excludedStop = {
  id: stopId, property_id: propertyId, stop_state: 'excluded', route_sequence: null, route_label: null,
  access_coordinate_status: 'unknown', property_name: null, property_address: null, name: null, address: null,
  position: null, label: 'Tour stop', locked_appointment: false, dwell_minutes: 30, buffer_minutes: 10,
};
const detail = {
  id: tourId, name: plan.names.tour, status: 'draft', subject_type: 'client', subject_id: clientId,
  route_version_state: 'draft', accepted_route_version: 0, route_version_id: routeId,
  routes: [{ id: routeId, route_version: 1, accepted: false, routing_source: 'manual',
    routing_provider: null, routing_rights_receipt_id: null, created_by: 'joe', stops: [excludedStop] }],
  stops: [excludedStop], projection_id: null,
};

function makeRun() {
  return { limits: { httpTimeoutMs: 1000, settlementMs: 1000 }, check() {} };
}

function makePage({ apiDetail = detail, afterDetail = apiDetail, title = plan.names.tour, pills = ['draft', '0 stops'], stopRows = 0,
  dayLinks = 0, externalLinks = 0, dialog = true, appSha = app, actor = 'joe', writeRequest = false } = {}) {
  const selectors = [], requests = [], calls = { detail: 0, opened: 0 };
  const response = { service: 'doctorcre-app', environment: 'staging', source_commit: appSha };
  const page = {
    url: () => `${contract.origin}/tours`,
    on(event, listener) { if (event === 'request') requests.push(listener); },
    off(event, listener) { if (event === 'request') requests.splice(requests.indexOf(listener), 1); },
    async evaluate(fn, arg) {
      const source = String(fn);
      if (source.includes('__tourJourneyIdentity__')) return {
        release: response,
        session: { actor: { slug: actor }, e2e_principal: 'e2e-joe' },
      };
      if (source.includes('__tourJourneyReadDetail__')) {
        calls.detail += 1;
        return structuredClone(calls.detail > 1 ? afterDetail : apiDetail);
      }
      throw new Error(`Unexpected page evaluate: ${source.slice(0, 80)}`);
    },
    locator(selector) {
      selectors.push(selector);
      return {
        async waitFor({ state } = {}) {
          if (selector.includes('[data-tour-id=')) assert.equal(state, 'visible');
          if (selector === '#tour-dialog' && dialog) return;
          if (selector === '#detail-title') return;
          throw new Error(`Unexpected waitFor ${selector}`);
        },
        async click() {
          if (selector.includes('[data-tour-id=')) {
            calls.opened += 1;
            if (writeRequest) for (const listener of requests) listener({ method: () => 'POST' });
          }
        },
        async textContent() { return title; },
        async allTextContents() { return pills; },
        async count() {
          if (selector.startsWith('#upcoming-tours [data-tour-id=')) return 1;
          if (selector === '#detail-content ol.detail-stops > li') return stopRows;
          if (selector === '#detail-content a[href^="/tours/day.html"]') return dayLinks;
          if (selector.includes('href^="http"') || selector.includes('href^="geo:"') || selector.includes('href^="maps:"') || selector.includes('maps.google') || selector.includes('apple.com/maps') || selector.includes('href^="tel:"')) return externalLinks;
          throw new Error(`Unexpected count ${selector}`);
        },
      };
    },
  };
  return { page, selectors, calls, requests };
}

test('contract pins the normal Tour reader and UI selectors without claiming V1 write coverage', () => {
  assert.equal(contract.schema, 'doctorcre-staging-tour-journey.v1');
  assert.equal(contract.readback.path, '/api/tours/detail?tour_id={records.tour.id}');
  assert.equal(contract.ui.path, '/tours');
  assert.equal(contract.ui.excluded_stop_visibility, 'filtered_from_visible_stop_list');
  assert.equal(contract.output.full_v1_qualified, false);
  assert.ok(contract.output.unqualified_write_journeys.includes('accept-route'));
});

test('qualifies a guarded owned-Tour readback and the planner’s safe 0-stop observation', async () => {
  const f = makePage();
  const result = await qualifyTourJourney({ page: f.page, plan, sourcePair, fixtureBinding, run: makeRun() });
  assert.equal(f.calls.detail, 2, 'read independently before and after opening the Tour in the UI');
  assert.equal(f.calls.opened, 1);
  assert.ok(f.selectors.includes('#upcoming-tours [data-tour-id="' + tourId + '"], #history-tours [data-tour-id="' + tourId + '"]'));
  assert.ok(f.selectors.includes('#detail-content ol.detail-stops > li'));
  assert.equal(result.schema, contract.output.schema);
  assert.equal(result.full_v1_qualified, false);
  assert.deepEqual(result.unqualified_write_journeys, contract.output.unqualified_write_journeys);
  assert.equal(result.backend_readback.excluded_stop_id, stopId);
  assert.equal(result.backend_readback.property_name, null);
  assert.equal(result.backend_readback.property_address, null);
  assert.equal(result.ui.shown_stops, 0);
  assert.equal(result.ui.accepted_day_link_count, 0);
  assert.equal(result.plan_binding.tour_creation_key_source, 'plan_reference_only');
  assert.equal(Object.hasOwn(result, 'receipts'), false);
  assert.equal(Object.hasOwn(result, 'events'), false);
});

test('rejects a mismatched Tour or client binding before touching the UI', async () => {
  for (const changed of [
    { plan: { ...plan, records: { ...plan.records, tour: { ...plan.records.tour, id: '88888888-8888-4888-8888-888888888888' } } } },
    { detail: { ...detail, subject_id: '99999999-9999-4999-8999-999999999999' } },
  ]) {
    const f = makePage({ apiDetail: changed.detail || detail });
    await assert.rejects(qualifyTourJourney({ page: f.page, plan: changed.plan || plan,
      sourcePair, fixtureBinding, run: makeRun() }), /refused/);
    assert.equal(f.calls.opened, 0);
  }
});

test('rejects wrong source pins, incomplete plans, and fabricated tour receipts', async () => {
  const cases = [
    { sourcePair: { ...sourcePair, app: 'b'.repeat(40) } },
    { plan: { ...plan, state: 'pending' } },
    { plan: { ...plan, receipts: { tour: { ok: true } } } },
    { fixtureBinding: { ...fixtureBinding, run: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } },
  ];
  for (const changed of cases) {
    const f = makePage();
    await assert.rejects(qualifyTourJourney({ page: f.page, plan: changed.plan || plan,
      sourcePair: changed.sourcePair || sourcePair, fixtureBinding: changed.fixtureBinding || fixtureBinding, run: makeRun() }), /refused/);
    assert.equal(f.calls.opened, 0);
  }
  const staleLiveRelease = makePage({ appSha: 'b'.repeat(40) });
  await assert.rejects(qualifyTourJourney({ page: staleLiveRelease.page, plan, sourcePair, fixtureBinding, run: makeRun() }), /refused/);
  assert.equal(staleLiveRelease.calls.opened, 0);
});

test('rejects unknown ownership, accepted routes, extra stops, and falsely known property facts', async () => {
  const variants = [
    { ...detail, owner: 'unknown-owner' },
    { ...detail, routes: [{ ...detail.routes[0], created_by: 'unknown-owner' }] },
    { ...detail, routes: [{ ...detail.routes[0], accepted: true }] },
    { ...detail, routes: [{ ...detail.routes[0], stops: [excludedStop, { ...excludedStop, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] }],
      stops: [excludedStop, { ...excludedStop, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] },
    { ...detail, stops: [{ ...excludedStop, property_name: 'Invented Property' }] },
  ];
  for (const apiDetail of variants) {
    const f = makePage({ apiDetail });
    await assert.rejects(qualifyTourJourney({ page: f.page, plan, sourcePair, fixtureBinding, run: makeRun() }), /refused/);
    assert.equal(f.calls.opened, 0);
  }
});

test('rejects UI evidence that shows a stop, exposes a day/native link, or disagrees with the Tour name', async () => {
  for (const options of [
    { stopRows: 1, pills: ['draft', '1 stop'] },
    { dayLinks: 1 },
    { externalLinks: 1 },
    { title: 'Another tour' },
    { writeRequest: true },
  ]) {
    const f = makePage(options);
    await assert.rejects(qualifyTourJourney({ page: f.page, plan, sourcePair, fixtureBinding, run: makeRun() }), /refused/);
  }
});

test('rejects a route or excluded-stop identity that changes on the post-UI fresh read', async () => {
  const changedDetail = structuredClone(detail);
  changedDetail.route_version_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  changedDetail.routes[0].id = changedDetail.route_version_id;
  const f = makePage({ afterDetail: changedDetail });
  await assert.rejects(qualifyTourJourney({ page: f.page, plan, sourcePair, fixtureBinding, run: makeRun() }), /refused/);
  assert.equal(f.calls.detail, 2);
});
