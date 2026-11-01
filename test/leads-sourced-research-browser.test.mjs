import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from './browser-harness.mjs';
import { routeLeads } from './leads-browser-fixture.mjs';
import { detail, id } from './leads-workspace-fixture.mjs';

const evidenceDir = new URL('../.github/pr-evidence/WR647.S1.J9/', import.meta.url);
const source = 'https://example.test/registry/1';
const expiredSource = 'https://example.test/filings/none';
const research = {
  state: 'verified',
  coverage: 'recorded_findings_only',
  external_search_performed: false,
  next_step: 'Read the cited sources and confirm the practice decision before drafting outreach.',
  evidence: [
    { flag_id: id(700), kind: 'verified', found: true, expired: false, proposes_correction: false, source, observed_at: '2026-10-01T15:00:00Z', expires_on: '2099-01-01', value: { checked: ['identity', 'practice'] } },
    { flag_id: id(702), kind: 'discrepancy', found: true, expired: false, proposes_correction: true, source: 'Synthetic registry, entry 12', observed_at: '2026-10-01T15:00:00Z', value: { prior: 'Example old practice', proposed: 'Example new practice', valid: false, registry_id: 'EXAMPLE-42', nested: { count: 0, missing: null }, options: [] } },
    { flag_id: id(701), kind: 'verified', found: false, expired: true, proposes_correction: false, source: expiredSource, observed_at: '2026-09-01T15:00:00Z', expires_on: '2000-01-01', value: { note: 'Synthetic filing checked' } },
  ],
};
const leadProposal = { subject_type: 'lead', subject_id: id(1), party_id: id(101), ref: 'L-1', name: 'Dr. Example 1', owner: 'example-partner', anchor_on: '2026-08-17', basis: 'last_contact', next_action_date: null, client_id: null, interval_days: 45, due_on: '2026-10-01', days_overdue: 15 };
const otherProposals = [
  { subject_type: 'vendor', subject_id: id(50), party_id: id(150), ref: 'V-50', name: 'Synthetic broker', basis: 'last_contact', anchor_on: '2026-07-01', due_on: '2026-09-29', days_overdue: 10, interval_days: 90 },
  { subject_type: 'contact', subject_id: id(77), ref: 'P-77', name: 'Synthetic site owner', basis: 'created_at', anchor_on: '2026-08-01', due_on: '2026-09-15', days_overdue: 16, interval_days: 45 },
];
const quiet = proposals => ({ schema_version: 'quiet-follow-ups.v1', cadence: { lead_days: 45, vendor_days: 90 }, proposals, sent: false, tasks_created: false });

async function open(t, { width = 1440, height = 900, theme = 'light', proposals = [leadProposal, ...otherProposals], refuse = false, hold = null, researchValue = research, refuseDetail = false } = {}) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce', timezoneId: 'America/Chicago' });
  await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme })), theme);
  const calls = [];
  await routeLeads(page, { getDetail: row => ({ ...detail(row), research: researchValue }) });
  await page.route('**/mcp', async route => {
    const params = route.request().postDataJSON()?.params;
    if (refuseDetail && params?.name === 'lead-board' && params.arguments.lead_id) return route.fulfill({ json: { result: { isError: true, content: [{ type: 'text', text: '{"error":"research_evidence_limit_exceeded"}' }] } } });
    if (params?.name !== 'quiet-follow-ups') return route.fallback();
    calls.push(params.arguments);
    if (hold) await hold.promise;
    const body = refuse
      ? { result: { isError: true, content: [{ type: 'text', text: '{"error":"forbidden"}' }] } }
      : { result: { content: [{ type: 'text', text: JSON.stringify(quiet(proposals)) }] } };
    return route.fulfill({ json: body });
  });
  await page.goto('http://localhost/leads');
  return { page, calls };
}

test('sourced research shows each fact source and only server-classified leads are linked', async t => {
  const { page, calls } = await open(t);
  const list = page.locator('#quietFollowUps');
  await list.getByRole('link', { name: /^Dr\. Example 1/ }).waitFor();
  assert.deepEqual(calls, [{}], 'the follow-up read uses the server cadence');
  assert.equal(await list.getByRole('link', { name: /^Dr\. Example 1/ }).getAttribute('href'), '/leads?lead=L-1');
  assert.match(await list.innerText(), /Last contact/);
  assert.match(await list.innerText(), /Last contact Aug 17\. Follow-up due Oct 1 · 15 days overdue/);
  assert.equal(await list.getByText('Synthetic broker').count(), 0);
  assert.equal(await list.getByText('Synthetic site owner').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await list.getByRole('link', { name: /^Dr\. Example 1/ }).click();
  const detailBody = page.locator('#detailBody');
  await detailBody.getByRole('heading', { name: 'Sourced research', exact: true }).waitFor();
  const text = await detailBody.innerText();
  assert.match(text, /Verified/);
  assert.ok(text.includes(source), "source locator is preserved verbatim");
  assert.match(text, /identity/);
  assert.match(text, /practice/);
  assert.ok(text.includes(expiredSource), "expired source locator is preserved verbatim");
  assert.match(text, /Expired/);
  assert.match(text, /Nothing found/);
  assert.match(text, /Discrepancy · Proposed correction/);
  assert.match(text, /prior: Example old practice/);
  assert.match(text, /proposed: Example new practice/);
  assert.match(text, /valid: false/);
  assert.match(text, /registry_id: EXAMPLE-42/);
  assert.match(text, /nested: \{count: 0; missing: null\}/);
  assert.match(text, /options: \[\]/);
  assert.match(text, /Source: Synthetic registry, entry 12/);
  assert.doesNotMatch(text, /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
});

test('quiet leads explain an empty server list without calling it a refusal', async t => {
  let release;
  const hold = { promise: new Promise(resolve => { release = resolve; }) };
  const { page } = await open(t, { proposals: [], hold });
  await page.getByRole('status').filter({ hasText: 'Loading follow-ups…' }).waitFor();
  release();
  const list = page.locator('#quietFollowUps');
  await list.getByText('No quiet leads.', { exact: true }).waitFor();
  assert.doesNotMatch(await list.innerText(), /refused/i);
});

test('a refused follow-up read stays a refusal', async t => {
  const { page } = await open(t, { refuse: true });
  const list = page.locator('#quietFollowUps');
  await list.getByRole('alert').waitFor();
  assert.match(await list.innerText(), /The follow-up list was refused/);
  assert.doesNotMatch(await list.innerText(), /No quiet leads/);
});

for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
  test(`sourced research and quiet leads fit ${width}px ${theme}`, async t => {
    const { page } = await open(t, { width, height: width === 390 ? 844 : 960, theme });
    const list = page.locator('#quietFollowUps');
    await list.getByRole('link', { name: /^Dr\. Example 1/ }).waitFor();
    await list.scrollIntoViewIfNeeded();
    const link = list.getByRole('link', { name: /^Dr\. Example 1/ });
    const name = await link.locator('span').boundingBox();
    const reason = await link.locator('p').boundingBox();
    assert.ok((await link.boundingBox()).height >= 44, 'whole row is a touch target');
    assert.ok(reason.y - name.y - name.height <= 4, 'name and reason stay grouped');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'quiet list fits');
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({ path: new URL(`quiet-leads-${width}-${theme}.png`, evidenceDir).pathname, animations: 'disabled' });
    await list.getByRole('link', { name: /^Dr\. Example 1/ }).click();
    const researchPanel = page.locator('#sourcedResearch');
    await researchPanel.waitFor();
    await researchPanel.scrollIntoViewIfNeeded();
    const fact = researchPanel.locator('li').last();
    const sentence = await fact.locator('.research-finding').boundingBox();
    const metadata = await fact.locator('.research-source').boundingBox();
    assert.ok(metadata.y >= sentence.y + sentence.height, 'source has its own line');
    assert.equal(await fact.locator('.research-source a').getAttribute('href'), expiredSource);
    assert.equal(await fact.locator('.research-expiry').innerText(), 'Expired');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'research fits');
    await page.screenshot({ path: new URL(`sourced-research-${width}-${theme}.png`, evidenceDir).pathname, animations: 'disabled' });
  });
}

 test('research with no recorded findings says so plainly', async t => {
  const { page } = await open(t, { researchValue: { ...research, state: 'needs_research', evidence: [] } });
  await page.locator('#quietFollowUps').getByRole('link', { name: /^Dr\. Example 1/ }).click();
  await page.locator('#sourcedResearch').waitFor();
  assert.match(await page.locator('#sourcedResearch').innerText(), /No sourced findings/);
 });
 test('refused research details do not claim a connection failure or empty findings', async t => {
  const { page } = await open(t, { refuseDetail: true });
  await page.locator('#quietFollowUps').getByRole('link', { name: /^Dr\. Example 1/ }).click();
  await page.locator('#detailBody [role="alert"]').waitFor({ timeout: 3000 });
  assert.match(await page.locator('#detailBody').innerText(), /Lead details were refused/);
 });
