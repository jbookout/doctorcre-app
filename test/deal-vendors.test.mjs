import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDealVendors } from '../js/deal-vendors.js';

const vendor = contact => ({ role: 'lender', company: { name: 'Demo Firm' }, contact: { name: 'Demo Person', ...contact } });

test('duplicate contacts retain channels regardless of order', () => {
  const rows = [{ ...vendor({}), party_id: 'party-1' }, { ...vendor({ email: 'person@example.test', phone: '555-010-1234' }), party_id: 'party-2' }];
  for (const order of [rows, [...rows].reverse()]) {
    const html = renderDealVendors(order);
    assert.equal((html.match(/Demo Person/g) || []).length >= 1, true);
    assert.match(html, /person@example\.test/);
    assert.match(html, /555-010-1234/);
    assert.equal((html.match(/deal-vendor-company/g) || []).length, 1);
  }
});

test('phone formatting is ignored while extensions remain significant', () => {
  for (const [phones, count] of [
    [['(555) 010-1234', '555-010-1234'], 1],
    [['(555) 010-1234 ext. 12', '555-010-1234 #12'], 1],
    [['555-010-1234 x12', '555-010-1234 x13'], 2],
    [['555-010-1234', '555-010-1234 x12'], 2],
  ]) {
    assert.equal((renderDealVendors(phones.map(phone => vendor({ phone }))).match(/deal-vendor-company/g) || []).length, count);
  }
});

test('conflicting channels keep matching names separate', () => {
  for (const field of ['email', 'phone']) {
    const values = field === 'email' ? ['one@example.test', 'two@example.test'] : ['555-010-0101', '555-010-0102'];
    const rows = values.map((value, i) => ({ ...vendor({ [field]: value }), party_id: `party-${i}` }));
    assert.equal((renderDealVendors(rows).match(/deal-vendor-company/g) || []).length, 2);
  }
});

test('telephone links preserve extensions separately from the number', () => {
  for (const phone of ['555-010-1234 ext. 12', '555-010-1234 x12', '555-010-1234 extension 12', '555-010-1234 #12']) {
    assert.match(renderDealVendors([vendor({ phone })]), /href="tel:5550101234;ext=12"/);
  }
});

test('phone text without digits stays visible without a telephone link', () => {
  const html = renderDealVendors([vendor({ phone: 'TBD' })]);
  assert.match(html, /Contact details/);
  assert.match(html, /TBD/);
  assert.doesNotMatch(html, /href="tel:/);
});
