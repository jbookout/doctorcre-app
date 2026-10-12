import test from 'node:test';
import assert from 'node:assert/strict';
import { relationshipValid, validListPayload, validRecordPayload, parseViewState, viewHref } from '../js/workspace-business-model.js';
import { directoryFixture } from './fixtures/vendor-directory.synthetic.mjs';

test('W5 validates the complete partnership payload and rejects malformed evidence before rendering', () => {
  const list=directoryFixture('http://demo.example/api/v1/business/vendors');
  assert.equal(validListPayload(list,'vendors'),true);
  const record=directoryFixture(`http://demo.example/api/v1/business/vendors/${list.rows[0].id}`);
  assert.equal(validRecordPayload(record,'vendors'),true);
  const stats=list.rows[0].relationship;
  for(const patch of [{win_rate:2},{deals_worked:-1},{computed_tier:'Trusted'},{coverage_verified_at:null},{recent_entries:{}},{introductions:[{}]},{override:{tier:'Trial',reason:'',recorded_by:'joe',recorded_at:'2026-10-01'}}]) assert.equal(relationshipValid({...stats,...patch}),false,JSON.stringify(patch));
  assert.equal(relationshipValid({...stats,coverage_verified_at:null,deals_worked:null,deals_referred:null,win_rate:null,computed_tier:'Unrated'}),true);
  assert.equal(validRecordPayload({...record,record:{...record.record,loan_programs:42}},'vendors'),false);
});

test('W5 owner and territory survive canonical navigation; client territory is dropped', () => {
  const vendor=parseViewState('/vendors','?owner=dell&territory=Demo%20North&sort=last_deal_asc').query;
  assert.equal(vendor.owner,'dell');assert.equal(vendor.territory,'Demo North');assert.equal(vendor.sort,'last_deal_asc');
  assert.equal(new URL(viewHref(vendor),'http://demo.example').searchParams.get('territory'),'Demo North');
  assert.equal(parseViewState('/clients','?territory=Demo&owner=other').query.territory,'');
  assert.equal(parseViewState('/clients','?owner=other').query.owner,'all');
});

import { readFileSync } from 'node:fs';
import { openDom } from './jsdom-harness.mjs';
import * as model from '../js/workspace-business-model.js';
import { activityCopy } from '../js/record-activity-model.js';
import { updatedLabel } from '../js/auto-refresh.mjs';
import { renderEvidence } from '../js/correspondence.js';

const source = readFileSync(new URL('../js/workspace-business.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../business.html', import.meta.url), 'utf8');

function setup(dataset, locale = 'en-US') {
  const dom = openDom(page, { url: `https://example.test/${dataset}`, runScripts: 'outside-only' });
  const { window } = dom;
  Object.assign(window, model, { activityCopy, updatedLabel, renderEvidence, resolveDealroomBoot: () => ({ mode: 'fixture' }) });
  window.matchMedia = () => ({ matches: false });
  // Emulate a browser whose default clock is 24-hour without changing the
  // renderer. Explicit locales and clock options still reach native Intl.
  const nativeLocaleString = window.Date.prototype.toLocaleString;
  window.Date.prototype.toLocaleString = function(locales, options) {
    return nativeLocaleString.call(this, !locales || locales.length === 0 ? locale : locales, options);
  };
  // Execute the page's real renderers, leaving boot/transport reads unstarted.
  window.eval(source.slice(source.indexOf('const EXPIRY_TICK_MS')).replace(/\nstart\(\);\s*$/, '')
    + '\n globalThis.renderers = { view, rowHtml, renderRecordPanel, formatMoment };');
  const app = window.renderers;
  app.view.dataset = dataset;
  app.view.query = model.defaultQuery(dataset);
  const list = directoryFixture(`https://example.test/api/v1/business/${dataset}`);
  const payload = directoryFixture(`https://example.test/api/v1/business/${dataset}/${list.rows[0].id}`);
  return { document: window.document, app, row: list.rows[0], payload };
}

for (const dataset of ['clients', 'vendors']) {
  test(`${dataset}: primary row names the record without an internal reference`, () => {
    const { document, app, row } = setup(dataset);
    document.querySelector('#recordList').innerHTML = app.rowHtml(dataset, row, row.id);
    const link = document.querySelector('.record-row');
    assert.equal(link.querySelector('.row-name').textContent, row.name);
    assert.doesNotMatch(link.textContent, new RegExp(row.ref));
    assert.equal(link.querySelector('.row-ref'), null);
    assert.equal(link.dataset.recordId, row.id, 'exact record identity still drives opening');
    assert.equal(new URL(link.href).searchParams.get('record'), row.id);
    assert.equal(link.getAttribute('aria-current'), 'true');
    assert.match(link.textContent, /Owner: Joe/);
  });

  test(`${dataset}: the internal reference is available only inside collapsed Details`, () => {
    const { document, app, payload } = setup(dataset);
    app.view.recordId = payload.record.id;
    app.view.record = { status: 'ready', payload };
    app.renderRecordPanel();
    assert.equal(document.querySelector('#recordTitle').textContent, payload.record.name);
    const body = document.querySelector('#recordBody');
    const reference = [...body.querySelectorAll('details')].find(el => el.textContent.includes(payload.record.ref));
    assert.ok(reference, 'the existing read reference remains accessible in Details');
    assert.equal(reference.querySelector('summary').textContent, 'Details');
    assert.equal(reference.open, false);
    reference.open = true;
    app.renderRecordPanel();
    assert.equal([...body.querySelectorAll('details')].find(el => el.textContent.includes(payload.record.ref)).open, true,
      'refresh preserves the disclosure state');
    for (const details of body.querySelectorAll('details')) details.remove();
    assert.doesNotMatch(body.textContent, new RegExp(payload.record.ref));
  });

  for (const locale of ['en-GB', 'de-DE']) {
    test(`${dataset}: ${locale} defaults cannot put broker timestamps on a 24-hour clock`, () => {
      const { document, app, row, payload } = setup(dataset, locale);
      for (const hour of [0, 9, 12, 17, 23]) {
        const value = new Date(2026, 9, 1, hour, 7).toISOString();
        const expected = `${hour % 12 || 12}:07 ${hour < 12 ? 'AM' : 'PM'}`;
        assert.ok(app.formatMoment(value).includes(expected), app.formatMoment(value));
      }
      document.querySelector('#recordList').innerHTML = app.rowHtml(dataset, row, null);
      assert.match(document.querySelector('.row-updated').textContent, /\b(?:AM|PM)\b/);
      if (dataset === 'vendors') {
        assert.match([...document.querySelectorAll('.row-fact')].find(el => el.textContent.includes('Last contacted')).textContent, /\b(?:AM|PM)\b/);
        payload.record.relationship.override = { tier: 'Trial', reason: 'Synthetic review', recorded_by: 'Joe', recorded_at: row.updated_at };
      }
      app.view.recordId = payload.record.id;
      app.view.record = { status: 'ready', payload };
      app.view.activity = { id: payload.record.id, result: { state: 'ready', rows: [{ what: 'Synthetic conversation', when: row.updated_at, kind: 'activity' }] } };
      app.renderRecordPanel();
      assert.match(document.querySelector('.activity-when').textContent, /\b(?:AM|PM)\b/);
      if (dataset === 'vendors') {
        assert.match([...document.querySelectorAll('.relationship-metric strong')].at(-1).textContent, /\b(?:AM|PM)\b/);
        assert.match(document.querySelector('.relationship-section > .note-summary').textContent, /\b(?:AM|PM)\b/);
        assert.match([...document.querySelectorAll('.network-list time')].at(-1).textContent, /\b(?:AM|PM)\b/);
      }
      assert.equal(app.formatMoment('invalid'), 'an unknown time');
    });
  }
}
