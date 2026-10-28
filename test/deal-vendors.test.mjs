import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDealVendors } from '../js/deal-vendors.js';

const vendor = contact => ({ role: 'lender', company: { name: 'Demo Firm' }, contact: { name: 'Demo Person', ...contact } });

test('duplicate contacts retain channels regardless of order', () => {
  const rows = [vendor({}), vendor({ email: 'person@example.test', phone: '555-010-1234' })];
  for (const order of [rows, [...rows].reverse()]) {
    const html = renderDealVendors(order);
    assert.equal((html.match(/Demo Person/g) || []).length >= 1, true);
    assert.match(html, /person@example\.test/);
    assert.match(html, /555-010-1234/);
    assert.equal((html.match(/deal-vendor-company/g) || []).length, 1);
  }
});

test('different identifiers distinguish otherwise identical assignments', () => {
  for (const pair of [
    [{ party_id: 'a' }, { party_id: 'b' }],
    [{ company: { id: 'a', name: 'Demo Firm' } }, { company: { id: 'b', name: 'Demo Firm' } }],
    [{ contact: { id: 'a', name: 'Demo Person' } }, { contact: { id: 'b', name: 'Demo Person' } }],
  ]) {
    const html = renderDealVendors(pair.map(fields => ({ ...vendor({}), ...fields })));
    assert.equal((html.match(/deal-vendor-company/g) || []).length, 2);
  }
});

test('telephone links preserve extensions separately from the number', () => {
  for (const phone of ['555-010-1234 ext. 12', '555-010-1234 x12']) {
    assert.match(renderDealVendors([vendor({ phone })]), /href="tel:5550101234;ext=12"/);
  }
});

test('phone text without digits stays visible without a telephone link', () => {
  const html = renderDealVendors([vendor({ phone: 'TBD' })]);
  assert.match(html, /Contact details/);
  assert.match(html, /TBD/);
  assert.doesNotMatch(html, /href="tel:/);
});
