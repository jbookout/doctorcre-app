import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultQuery, listRequestUrl, recordRequestUrl, validRecordPayload } from '../js/workspace-business-model.js';
import { directoryFixture } from './fixtures/vendor-directory.synthetic.mjs';

const id = '00000000-0000-4000-8000-000000000001';
const person = {
  company: { id, name: 'Demo Partner Company' },
  contact: { id: '00000000-0000-4000-8000-000000000101', name: 'Demo Contact Alpha', email: null, phone: null, cell: null },
  office: null,
  research: { status: 'not_researched', finding_id: null, observed_at: null, expires_on: null },
};
const detail = () => {
  const payload = directoryFixture(`https://example.test/api/v1/business/vendors/${id}`);
  payload.record.people = [structuredClone(person)];
  return payload;
};

test('People reads explicitly negotiate v2 while callers without people retain v1', () => {
  assert.equal(new URL(recordRequestUrl('vendors', id, { people: true }), 'https://example.test').searchParams.get('contract'), 'vendor-directory.v2');
  assert.equal(new URL(recordRequestUrl('vendors', id), 'https://example.test').searchParams.get('contract'), 'vendor-directory.v1');
  assert.equal(new URL(recordRequestUrl('clients', id, { people: true }), 'https://example.test').searchParams.get('contract'), 'vendor-directory.v1');
  assert.equal(new URL(listRequestUrl(defaultQuery('vendors')), 'https://example.test').searchParams.get('contract'), 'vendor-directory.v1');
});

test('Negotiated people retain named contacts with unknown channels and office without changing v1 validation', () => {
  const payload = detail();
  assert.equal(validRecordPayload(payload, 'vendors', id, { people: true }), true);
  assert.equal(validRecordPayload(payload, 'vendors', id), false);
  assert.equal(validRecordPayload({ ...payload, record: { ...payload.record, people: [] } }, 'vendors', id, { people: true }), true);
  delete payload.record.people;
  assert.equal(validRecordPayload(payload, 'vendors', id, { people: true }), false);
  assert.equal(validRecordPayload(payload, 'vendors', id), true);
});

test('Malformed identities, office evidence and research never reach the contact view', () => {
  const office = { street_address: '1 Demo Plaza', city: 'Demo City', state: 'FL', finding_id: id, source: 'Synthetic source', observed_at: '2026-10-01T12:00:00Z', expires_on: null };
  const payload = detail();
  payload.record.people[0].office = office;
  payload.record.people[0].research = { status: 'office_verified', finding_id: id, observed_at: office.observed_at, expires_on: null };
  assert.equal(validRecordPayload(payload, 'vendors', id, { people: true }), true);
  for (const patch of [
    { contact: { ...person.contact, id: 'not-an-id' } },
    { contact: { ...person.contact, name: '' } },
    { company: { id, name: 12 } },
    { office: { ...office, source: '' } },
    { office: { ...office, street_address: null } },
    { office: { ...office, extra: true } },
    { research: { ...person.research, status: 'enriching' } },
    { research: person.research },
    { office: null },
  ]) {
    const candidate = structuredClone(payload);
    Object.assign(candidate.record.people[0], patch);
    assert.equal(validRecordPayload(candidate, 'vendors', id, { people: true }), false, JSON.stringify(patch));
  }
});

test('A recorded company with a blank name does not hide its named contact', () => {
  const payload = detail();
  payload.record.people[0].company.name = '';
  assert.equal(validRecordPayload(payload, 'vendors', id, { people: true }), true);
});
