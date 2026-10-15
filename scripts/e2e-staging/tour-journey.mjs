import { createHash } from 'node:crypto';
import { stagingAuth } from './auth-contract.mjs';
import staging from '../../contracts/e2e-staging.v1.json' with { type: 'json' };
import journeyContract from '../../contracts/e2e-staging-tour-journey.v1.json' with { type: 'json' };

const STAGING_ORIGIN = staging.origin;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;
const fail = () => { throw new Error('Tour journey qualification refused'); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : isObject(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const exactKeys = (value, keys) => isObject(value) && same(Object.keys(value).sort(), [...keys].sort());

function validateBinding({ plan, sourcePair, fixtureBinding }) {
  if (!isObject(plan) || plan.schema !== 'doctorcre-staging-records-plan.v1' || plan.origin !== STAGING_ORIGIN ||
      plan.state !== 'complete' || plan.inflight !== null || !UUID.test(plan.run || '') ||
      !isObject(sourcePair) || !exactKeys(sourcePair, ['app', 'carr']) || !SHA.test(sourcePair.app || '') ||
      sourcePair.carr !== staging.producer.source_commit ||
      !isObject(plan.release) || plan.release.source_commit !== sourcePair.app ||
      plan.release.carr_source_commit !== sourcePair.carr ||
      !isObject(plan.names) || typeof plan.names.tour !== 'string' || !plan.names.tour.trim() ||
      !isObject(plan.keys) || !UUID.test(plan.keys.tour || '') ||
      !isObject(plan.records?.client) || !UUID.test(plan.records.client.id || '') ||
      !isObject(plan.records?.tour) || !UUID.test(plan.records.tour.id || '') ||
      plan.records.tour.name !== plan.names.tour ||
      !isObject(plan.receipts) || Object.hasOwn(plan.receipts, 'tour')) fail();

  const bindingKeys = ['schema', 'provenance', 'run', 'source_pair', 'tour_id', 'route_version_id', 'excluded_stop_id', 'synthetic_property_id'];
  if (!exactKeys(fixtureBinding, bindingKeys) || fixtureBinding.schema !== journeyContract.fixture_binding.schema ||
      fixtureBinding.provenance !== 'private_installer_raw_readback' || fixtureBinding.run !== plan.run ||
      !same(fixtureBinding.source_pair, sourcePair) || fixtureBinding.tour_id !== plan.records.tour.id ||
      !UUID.test(fixtureBinding.route_version_id || '') || !UUID.test(fixtureBinding.excluded_stop_id || '') ||
      !UUID.test(fixtureBinding.synthetic_property_id || '')) fail();
}

function validateDetail(detail, { plan, fixtureBinding, actorSlug }) {
  if (!isObject(detail) || detail.id !== plan.records.tour.id || detail.name !== plan.names.tour ||
      detail.subject_type !== 'client' || detail.subject_id !== plan.records.client.id || detail.status !== 'draft' ||
      detail.route_version_state !== 'draft' || detail.accepted_route_version !== 0 ||
      detail.route_version_id !== fixtureBinding.route_version_id || !Array.isArray(detail.routes) || detail.routes.length !== 1 ||
      !Array.isArray(detail.stops) || detail.projection_id != null) fail();

  const route = detail.routes[0];
  if (!isObject(route) || route.id !== fixtureBinding.route_version_id || route.accepted !== false ||
      !Number.isInteger(route.route_version) || route.route_version < 1 ||
      route.routing_source !== 'manual' || route.stops?.length !== 1 ||
      (route.routing_provider != null) || (route.routing_rights_receipt_id != null) ||
      !Array.isArray(route.stops)) fail();
  if (detail.owner != null && detail.owner !== actorSlug || route.created_by != null && route.created_by !== actorSlug) fail();

  const routeStop = route.stops[0], projectedStop = detail.stops[0];
  if (!isObject(routeStop) || !isObject(projectedStop) || routeStop.id !== fixtureBinding.excluded_stop_id ||
      projectedStop.id !== fixtureBinding.excluded_stop_id || routeStop.property_id !== fixtureBinding.synthetic_property_id ||
      projectedStop.property_id !== fixtureBinding.synthetic_property_id || routeStop.stop_state !== 'excluded' ||
      projectedStop.stop_state !== 'excluded' || routeStop.route_sequence !== null || routeStop.route_label !== null ||
      projectedStop.route_sequence !== null || projectedStop.route_label !== null ||
      routeStop.access_coordinate_status !== 'unknown' || projectedStop.access_coordinate_status !== 'unknown') fail();

  const unknownFields = ['property_name', 'property_address', 'name', 'address'];
  for (const stop of [routeStop, projectedStop]) {
    if (unknownFields.some(field => stop[field] != null) ||
        ['position', 'coordinates', 'coordinate', 'latitude', 'longitude', 'lat', 'lon'].some(field => stop[field] != null)) fail();
  }
  if (!same(detail.stops.map(stop => stop.id), route.stops.map(stop => stop.id))) fail();
  return {
    route_version_id: route.id,
    route_version: route.route_version,
    accepted: false,
    excluded_stop_id: routeStop.id,
    property_id: routeStop.property_id,
    stop_state: routeStop.stop_state,
    access_coordinate_status: routeStop.access_coordinate_status,
    property_name: null,
    property_address: null,
  };
}

/**
 * Read-only qualifier for a Tour already owned by the completed staging plan.
 * The fixture binding carries row identities only; normal App API readback is
 * still authoritative for what the Tour UI consumed. This function never
 * synthesizes a receipt/event and never calls a write endpoint.
 */
export async function qualifyTourJourney({ page, plan, sourcePair, fixtureBinding, run } = {}) {
  if (!page || typeof page.evaluate !== 'function' || typeof page.locator !== 'function' ||
      !run || typeof run.check !== 'function' || !Number.isFinite(run.limits?.httpTimeoutMs) ||
      !Number.isFinite(run.limits?.settlementMs)) fail();
  run.check();
  validateBinding({ plan, sourcePair, fixtureBinding });

  const pageURL = new URL(page.url());
  if (pageURL.origin !== STAGING_ORIGIN || pageURL.pathname !== '/tours') fail();
  const timeout = Math.max(1, Math.min(run.limits.httpTimeoutMs, run.limits.settlementMs));
  const identity = await page.evaluate(async function __tourJourneyIdentity__(timeoutMs) {
    const signal = AbortSignal.timeout(timeoutMs);
    const [releaseResponse, sessionResponse] = await Promise.all([
      fetch('/app-release', { credentials: 'same-origin', cache: 'no-store', signal }),
      fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store', signal }),
    ]);
    if (!releaseResponse.ok || !sessionResponse.ok) throw new Error('Tour journey source read failed');
    return { release: await releaseResponse.json(), session: await sessionResponse.json() };
  }, timeout);
  if (identity?.release?.service !== 'doctorcre-app' || identity.release.environment !== 'staging' ||
      identity.release.source_commit !== sourcePair.app ||
      identity.session?.actor?.slug !== staging.session.actor_slug ||
      !stagingAuth.session.matches(identity.session)) fail();
  const actualPair = { app: identity.release.source_commit, carr: sourcePair.carr };
  if (!same(actualPair, sourcePair)) fail();
  const actorSlug = identity.session.actor.slug;

  run.check();
  const before = await page.evaluate(async function __tourJourneyReadDetail__({ tourId, timeoutMs }) {
    const response = await fetch(`/api/tours/detail?tour_id=${encodeURIComponent(tourId)}`, {
      credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error('Tour journey detail read failed');
    const payload = await response.json();
    return payload?.data || payload;
  }, { tourId: plan.records.tour.id, timeoutMs: timeout });
  const beforeEvidence = validateDetail(before, { plan, fixtureBinding, actorSlug });

  const requests = [];
  const onRequest = request => { if (request.method() !== 'GET') requests.push(request.method()); };
  page.on('request', onRequest);
  let ui;
  try {
    run.check();
    const libraryButton = `#upcoming-tours [data-tour-id="${plan.records.tour.id}"], #history-tours [data-tour-id="${plan.records.tour.id}"]`;
    const button = page.locator(libraryButton);
    if (await button.count() !== 1) fail();
    await button.click({ timeout });
    await page.locator('#tour-dialog').waitFor({ state: 'visible', timeout });
    const title = (await page.locator('#detail-title').textContent())?.trim();
    const pills = (await page.locator('#detail-content .detail-summary .pill').allTextContents()).map(value => value.trim());
    const shownStops = await page.locator('#detail-content ol.detail-stops > li').count();
    const acceptedDayLinkCount = await page.locator('#detail-content a[href^="/tours/day.html"]').count();
    const externalNavigationCount = await page.locator(
      '#detail-content a[href^="http"], #detail-content a[href^="geo:"], #detail-content a[href^="maps:"], ' +
      '#detail-content a[href^="tel:"], #detail-content a[href*="maps.google"], #detail-content a[href*="apple.com/maps"]',
    ).count();
    run.check();
    ui = { title, pills, shownStops, acceptedDayLinkCount, externalNavigationCount };
  } finally {
    page.off('request', onRequest);
  }
  if (requests.length || ui.title !== plan.names.tour || !same(ui.pills, ['draft', '0 stops']) ||
      ui.shownStops !== 0 || ui.acceptedDayLinkCount !== 0 || ui.externalNavigationCount !== 0) fail();

  run.check();
  const after = await page.evaluate(async function __tourJourneyReadDetail__({ tourId, timeoutMs }) {
    const response = await fetch(`/api/tours/detail?tour_id=${encodeURIComponent(tourId)}`, {
      credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error('Tour journey detail read failed');
    const payload = await response.json();
    return payload?.data || payload;
  }, { tourId: plan.records.tour.id, timeoutMs: timeout });
  const afterEvidence = validateDetail(after, { plan, fixtureBinding, actorSlug });
  if (beforeEvidence.route_version_id !== afterEvidence.route_version_id ||
      beforeEvidence.excluded_stop_id !== afterEvidence.excluded_stop_id ||
      beforeEvidence.property_id !== afterEvidence.property_id || beforeEvidence.accepted !== afterEvidence.accepted) fail();

  const boundPlan = {
    source_pair: sourcePair,
    run: plan.run,
    tour: { id: plan.records.tour.id, name: plan.names.tour },
    client: { id: plan.records.client.id, subject_type: 'client' },
    tour_creation_key: plan.keys.tour,
    tour_creation_key_source: 'plan_reference_only',
  };
  const uiEvidence = { title: ui.title, pills: ui.pills, shown_stops: ui.shownStops,
    accepted_day_link_count: ui.acceptedDayLinkCount, external_navigation_count: ui.externalNavigationCount,
    route: '/tours', detail_reader: '/api/tours/detail' };
  return {
    schema: journeyContract.output.schema,
    source_pair: sourcePair,
    run: plan.run,
    plan_binding: boundPlan,
    fixture_binding: { schema: fixtureBinding.schema, provenance: fixtureBinding.provenance,
      route_version_id: fixtureBinding.route_version_id, excluded_stop_id: fixtureBinding.excluded_stop_id,
      synthetic_property_id: fixtureBinding.synthetic_property_id, authority_claims: false },
    backend_readback: { ...afterEvidence, sha256: hash(after) },
    ui: { ...uiEvidence, sha256: hash(uiEvidence) },
    full_v1_qualified: journeyContract.output.full_v1_qualified,
    unqualified_write_journeys: [...journeyContract.output.unqualified_write_journeys],
  };
}
