import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { mountFactReview } from '../js/fact-review.js';
const plan = JSON.parse(await readFile(new URL('./fixtures/terms-comparison/prepare.json', import.meta.url)));
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
const rent = { entity_ref: 'd14', fact_key: 'base_rent_per_sf', canonical_version: 3, pending: false,
  observations: [], review_history: [], reasons: [], canonical_fact: null,
  canonical_history: [{ version: 1 }, { version: 3, promoted_at: '2026-10-30T12:00:00Z' }, { version: 2, promoted_at: '2026-10-29T12:00:00Z' }] };
async function mount(prepare, items = [rent]) {
  const dom = new JSDOM('<div id="terms"></div>', { url: 'http://localhost' });
  const root = dom.window.document.querySelector('#terms');
  const client = { listFactReview: async () => ({ ok: true, schema_version: 'fact-review.v1', items, has_more: false }), prepareTermsComparison: prepare };
  const panel = mountFactReview(root, { client, entityRef: 'd14', attachments: [] });
  await tick();
  root.querySelector('[data-prepare-comparison]').click();
  await tick();
  return { root, dom, panel };
}
test('partner reads a grouped draft with permitted sources and automatically selected versions', async () => {
  let request;
  const { root, panel } = await mount(async args => { request = args; return plan; }, [rent,
    { ...rent, fact_key: 'term_months', canonical_version: 1, canonical_history: [{ version: 1 }], pending: true }]);
  const card = root.querySelector('[data-comparison-draft]');
  assert.match(card.textContent, /Draft/);
  assert.match(card.textContent, /Base rent \(USD\/SF\/year\)/);
  assert.match(card.textContent, /24 \(nnn\)/);
  assert.match(card.textContent, /27.5 \(nnn\)/);
  assert.match(card.textContent, /Confirmed deal fact/);
  assert.match(card.textContent, /Prior: v2/);
  assert.match(card.textContent, /Current: v3/);
  assert.match(card.textContent, /Rent schedule/);
  assert.doesNotMatch(card.textContent, /00000000|Templates\/|canonical_id|observation_ids/);
  assert.deepEqual(request.fields, [{ fact_key: 'base_rent_per_sf', prior_version: 2, current_version: 3 }]);
  assert.equal(request.deal_id, 'd14');
  panel.dispose();
});

for (const reason of ['missing', 'unresolved', 'missing_version', 'source_not_permitted', 'invalid_value']) test(`named ${reason} refusal links to its Terms field`, async () => {
  const { root, panel } = await mount(async () => { throw Object.assign(new Error('refused'), {
    payload: { error: 'comparison_fact_blocked', field: 'term_months', reason },
  }); });
  const link = root.querySelector('[data-comparison-result] a');
  assert.equal(link.textContent, 'Lease term');
  assert.equal(link.getAttribute('href'), '#term-term_months');
  assert.ok(root.querySelector(link.getAttribute('href')));
  assert.equal(root.querySelector('[data-comparison-draft]'), null);
  panel.dispose();
});

test('a stale HTTP snapshot offers Prepare again and reads current versions again', async () => {
  let calls = 0;
  const requests = [];
  const changed = structuredClone(rent);
  const { root, panel } = await mount(async args => {
    requests.push(args);
    if (++calls === 1) {
      changed.canonical_version = 4;
      changed.canonical_history.push({ version: 4 });
      throw Object.assign(new Error('stale'), { payload: { error: 'comparison_fact_blocked', field: 'base_rent_per_sf', reason: 'stale_snapshot' } });
    }
    return plan;
  }, [changed]);
  assert.match(root.textContent, /A fact changed since/);
  assert.equal(root.querySelector('[data-prepare-comparison]').textContent, 'Prepare again');
  root.querySelector('[data-prepare-comparison]').click(); await tick();
  assert.ok(root.querySelector('[data-comparison-draft]'));
  assert.notEqual(requests[0].idempotency_key, requests[1].idempotency_key);
  assert.deepEqual(requests[1].fields, [{ fact_key: 'base_rent_per_sf', prior_version: 3, current_version: 4 }]);
  panel.dispose();
});

test('unavailable server and loading are explicit', async () => {
  let reject;
  const { root, panel } = await mount(() => new Promise((_, no) => { reject = no; }));
  assert.match(root.textContent, /Preparing terms comparison/);
  assert.ok(root.querySelector('[data-prepare-comparison]').disabled);
  reject(Object.assign(new Error('unavailable'), { status: 404 })); await tick();
  assert.match(root.textContent, /Terms comparison unavailable/);
  assert.ok(!root.querySelector('[data-prepare-comparison]').disabled);
  panel.dispose();
});

test('missing prior versions are named without creating a comparison', async () => {
  let called = false;
  const { root, panel } = await mount(async () => { called = true; return plan; }, [{ ...rent, canonical_version: 1, canonical_history: [{ version: 1 }] }]);
  assert.match(root.textContent, /Missing confirmed prior or current version/);
  assert.equal(root.querySelector('[data-comparison-result] a').textContent, 'Base rent');
  assert.equal(called, false);
  panel.dispose();
});
