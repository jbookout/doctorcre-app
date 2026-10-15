import { createHash } from 'node:crypto';
import { assertStagingContextCoverage } from './engine.mjs';
import { requireSupervisedRun } from './run-limits.mjs';
import { STAGING_ORIGIN } from './session.mjs';
import { stagingAuth } from './auth-contract.mjs';
import { observedV1Action } from './v1-qualification.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function ownedVendor(plan, release) {
  const vendor = plan?.records?.vendor, party = plan?.records?.vendor_party;
  const entry = plan?.records?.vendor_entry;
  if (plan?.schema !== 'doctorcre-staging-records-plan.v1' || plan.state !== 'complete' || plan.inflight ||
      !uuid(plan.run) || !uuid(vendor?.id) || !uuid(party?.id) || !uuid(entry?.id) || !uuid(entry?.link_id) ||
      !/^V-CPA-\d+$/.test(vendor.ref || '') ||
      plan.receipts?.vendor?.vendor_id !== vendor.id || plan.receipts?.vendor_party?.party_id !== party.id ||
      plan.receipts?.vendor_entry?.activity_id !== entry.id ||
      plan.release?.source_commit !== release.source_commit ||
      plan.release?.carr_source_commit !== release.carr_source_commit)
    throw new Error('Owned W5 vendor fixture and receipts refused');
  return { vendor, party, entry };
}

async function normalRead({ path, timeout }) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store',
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) return null;
  return response.json();
}

function currentSource(payload) {
  const source = payload?.source;
  const observed = Date.parse(source?.observed_at), valid = Date.parse(source?.valid_until);
  const now = Date.now();
  return source?.source === 'vendor' && source.freshness === 'fresh' &&
    Number.isFinite(observed) && Number.isFinite(valid) && observed <= now + 5000 &&
    valid > now && valid > observed && valid - observed <= 61_000;
}

export async function runVendorJourney({ page, plan, release, run } = {}) {
  run = requireSupervisedRun(undefined, run);
  run.check();
  const url = new URL(page?.url?.() || 'about:blank');
  if (url.origin !== STAGING_ORIGIN || url.pathname !== '/vendors' || url.search ||
      release?.service !== 'doctorcre-app' || release.environment !== 'staging' ||
      !/^[0-9a-f]{40}$/.test(release.source_commit || ''))
    throw new Error('W5 guarded vendor route and source refused');
  await assertStagingContextCoverage(page.context());
  const { vendor, entry } = ownedVendor(plan, release);
  const sourcePair = { source_commit: release.source_commit, carr_source_commit: release.carr_source_commit };
  const runId = run.snapshot().id;
  const timeout = Math.max(1, Math.min(run.limits.httpTimeoutMs, run.deadline - Date.now()));
  const read = async path => { run.check(); return page.evaluate(normalRead, { path, timeout }); };
  const [app, session] = await Promise.all([read('/app-release'), read('/auth/session')]);
  const identity = { app, session };
  if (identity?.app?.source_commit !== release.source_commit ||
      identity.app.carr_source_commit !== release.carr_source_commit ||
      !stagingAuth.session.matches(identity.session)) throw new Error('W5 signed-in source pair refused');
  const detailPath = `/api/v1/business/vendors/${vendor.id}?contract=vendor-directory.v1`;
  const before = await read(detailPath);
  const record = before?.record;
  const original = record?.relationship?.recent_entries?.find(row => row.id === entry.id && row.kind === 'note');
  const link = record?.relationship?.introductions?.find(row => row.id === entry.link_id && row.kind === 'can_introduce');
  if (!currentSource(before) || before.viewer !== 'joe' || before.dataset !== 'vendors' ||
      record?.id !== vendor.id || record.name !== vendor.name || record.ref !== vendor.ref ||
      record.owned_by_viewer !== true || !original || !link ||
      !original.summary?.includes('Synthetic staging QA') || !original.detail?.includes('Fictional QA'))
    throw new Error('W5 independent owned vendor and original entry readback refused');
  const query = encodeURIComponent(vendor.name);
  const scopedPath = `/api/v1/business/vendors?q=${query}&contract=vendor-directory.v1`;
  const otherPath = `/api/v1/business/vendors?q=${query}&owner=dell&contract=vendor-directory.v1`;
  const allPath = '/api/v1/business/vendors?contract=vendor-directory.v1';
  const [scoped, other, all] = await Promise.all([read(scopedPath), read(otherPath), read(allPath)]);
  if (![scoped, other, all].every(currentSource) ||
      [scoped, other, all].some(value => value?.viewer !== 'joe' || value.dataset !== 'vendors') ||
      scoped.query?.q !== vendor.name || scoped.query.owner !== 'all' || scoped.query.page !== 1 ||
      other.query?.q !== vendor.name || other.query.owner !== 'dell' || other.query.page !== 1 ||
      all.query?.q !== null || all.query.owner !== 'all' || all.query.page !== 1 ||
      scoped.total !== 1 || scoped.rows?.length !== 1 || scoped.rows[0].id !== vendor.id ||
      scoped.rows[0].owned_by_viewer !== true || other.total !== 0 || other.rows?.length !== 0 ||
      !Number.isSafeInteger(all.total) || all.total < scoped.total ||
      !Number.isSafeInteger(all.query.page_size) || all.query.page_size < 1 ||
      !Array.isArray(all.rows) || all.rows.length > all.query.page_size)
    throw new Error('W5 independent viewer and owner-filter membership refused');
  const action = (name, ui, readback) => observedV1Action({ id: 'W5', case: 'vendors', action: name,
    sourcePair, runId, fixtureRun: plan.run, ui, readback });
  const actions = [];
  await page.goto(`${STAGING_ORIGIN}/vendors?q=${query}`, { waitUntil: 'domcontentloaded', timeout });
  await page.locator(`.record-row[data-record-id="${vendor.id}"]`).waitFor({ state: 'visible', timeout });
  const scopedSummary = await page.locator('#resultSummary').textContent();
  if (!scopedSummary?.startsWith(`${scoped.total} `)) throw new Error('W5 scoped UI total differs from fresh read');
  actions.push(action('owned-vendor', { route: new URL(page.url()).pathname, count: 1, present: true },
    { id: vendor.id, source: before.source, receipt: plan.receipts.vendor.vendor_id }));
  await page.locator('[data-owner="dell"]').click({ timeout });
  await page.waitForURL(value => value.searchParams.get('owner') === 'dell', { timeout });
  await page.waitForFunction(total => document.querySelector('#resultSummary')?.textContent?.startsWith(`${total} `),
    other.total, { timeout });
  const otherSummary = await page.locator('#resultSummary').textContent();
  if (!otherSummary?.startsWith(`${other.total} `) || await page.locator(`.record-row[data-record-id="${vendor.id}"]`).count())
    throw new Error('W5 owner filter did not match fresh authorized read');
  actions.push(action('owner-filter', { owner: 'dell', summary: otherSummary, owned_vendor_absent: true },
    { total: other.total, rows: other.rows, source: other.source }));
  await page.locator('#resetFilters').click({ timeout });
  await page.waitForURL(value => value.pathname === '/vendors' && !value.search, { timeout });
  await page.waitForFunction(total => document.querySelector('#resultSummary')?.textContent?.startsWith(`${total} `),
    all.total, { timeout });
  const resetSummary = await page.locator('#resultSummary').textContent();
  if (!resetSummary?.startsWith(`${all.total} `)) throw new Error('W5 reset did not match fresh team read');
  actions.push(action('owner-reset', { owner: 'all', summary: resetSummary },
    { total: all.total, source: all.source }));
  await page.goto(`${STAGING_ORIGIN}/vendors?q=${query}`, { waitUntil: 'domcontentloaded', timeout });
  await page.locator(`.record-row[data-record-id="${vendor.id}"]`).click({ timeout });
  await page.locator('#recordPanel').waitFor({ state: 'visible', timeout });
  const introSelector = `#recordBody details[data-details-key="intro-${entry.link_id}"]`;
  const entryDetails = page.locator(`#recordBody details[data-details-key="entry-${entry.id}"]`);
  const introDetails = page.locator(introSelector);
  if (await entryDetails.count() !== 1 || await introDetails.count() !== 1)
    throw new Error('W5 original activity or introduction not shown in vendor detail');
  await entryDetails.locator('summary').click({ timeout });
  await introDetails.locator('summary').click({ timeout });
  const panel = await page.locator('#recordBody').textContent();
  if (!panel?.includes(original.detail) || !panel.includes(link.note))
    throw new Error('W5 original source text absent from expanded UI');
  actions.push(action('original-entry', { record: vendor.id, entry: entry.id, link: entry.link_id,
    detail_digest: digest(original.detail), intro_digest: digest(link.note) },
  { record: record.id, activity: original.id, link: link.id, source: before.source }));
  const after = await read(detailPath);
  if (!currentSource(after) || after?.record?.id !== record.id ||
      !after.record.relationship?.recent_entries?.some(row => row.id === entry.id) ||
      !after.record.relationship?.introductions?.some(row => row.id === entry.link_id))
    throw new Error('W5 post-interaction independent record readback refused');
  actions.push(action('vendor-readback', { panel_open: await page.locator('#recordPanel').isVisible(), id: record.id },
    { record: after.record.id, source: after.source, entry: entry.id, link: entry.link_id }));
  run.check();
  await assertStagingContextCoverage(page.context());
  return { schema: 'staging-vendor-journey-result.v1', source_pair: sourcePair, run_id: runId,
    fixture_run: plan.run, actions, vendor_record_digest: digest([vendor.id, entry.id, entry.link_id]) };
}
