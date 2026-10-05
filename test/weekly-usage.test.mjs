import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { FEATURES } from '../js/usage-contract.v1.js';
import { mountWeeklyUsage } from '../js/weekly-usage.js';

const sha = 'a'.repeat(40), time = '2026-10-05T12:00:00.000Z';
const payload = () => ({ schema: 'doctorcre-usage.v1', release_sha: sha, enabled: true, observed_at: time, week_start: '2026-09-28T12:00:00.000Z', release_started_at: time, coverage: 'since_release', features: FEATURES.map(row => ({ ...row, uses: { joe: row.id === 'home:view' ? 3 : 0, dell: row.id === 'home:view' ? 1 : 0 }, last_used: { joe: row.id === 'home:view' ? time : null, dell: row.id === 'home:view' ? time : null }, never_used: { joe: row.id !== 'home:view', dell: row.id !== 'home:view' } })) });
test('weekly usage draws partner bars, last use and never-used features with an interactive filter', async () => {
  const dom = new JSDOM('<section id="usage"></section>', { url: 'https://app.doctorcre.com/control-room/progress' });
  const fetch = async url => Response.json(url === '/app-release' ? { source_commit: sha, provider_version_created_at: time } : payload());
  const usage = mountWeeklyUsage({ host: dom.window.document.getElementById('usage'), fetch });
  await usage.refresh();
  const host = dom.window.document.getElementById('usage');
  assert.equal(host.querySelector('svg').getAttribute('role'), 'img');
  assert.match(host.textContent, /Home/);
  assert.match(host.textContent, /Joe 3 · Dell 1/);
  assert.match(host.textContent, /Never used/);
  assert.match(host.textContent, /Oct 5/);
  host.querySelector('select').value = 'doc';
  host.querySelector('select').dispatchEvent(new dom.window.Event('change'));
  assert.match(host.textContent, /Dr. CRE/);
  assert.equal(host.querySelectorAll('tbody tr').length, 3);
  usage.dispose(); dom.window.close();
});
test('unavailable and invalid summaries do not present false zero-use evidence', async () => {
  const dom = new JSDOM('<section></section>');
  const usage = mountWeeklyUsage({ host: dom.window.document.querySelector('section'), fetch: async url => Response.json(url === '/app-release' ? { source_commit: sha, provider_version_created_at: time } : { ...payload(), features: [{ label: 'Synthetic Client' }] }) });
  await usage.refresh();
  assert.match(dom.window.document.body.textContent, /Usage unavailable/);
  assert.equal(dom.window.document.body.textContent.includes('Synthetic'), false);
  assert.equal(dom.window.document.querySelector('svg'), null);
  usage.dispose(); dom.window.close();
});
