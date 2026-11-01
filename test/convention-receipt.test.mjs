import test from 'node:test';
import assert from 'node:assert/strict';
import { validConventionAdoptionReceipt } from '../js/operations-model.js';
import { retirementReceipt, replacementReceipt, sectionId, retiredRuleId } from './fixtures/convention-receipts.mjs';

const cardReceipt = () => ({ ...replacementReceipt(), card_id: 'K01', load_layer: 'control', packs: [] });
const variants = { retirement: retirementReceipt, pack: replacementReceipt, card: cardReceipt };

for (const [variant, example] of Object.entries(variants)) {
  test(`${variant} receipts and envelope replays match the pinned server shape`, () => {
    assert.equal(validConventionAdoptionReceipt(example(), sectionId), true);
    assert.equal(validConventionAdoptionReceipt({ ...example(), replayed: true }, sectionId), true);
    if (variant !== 'retirement')
      assert.equal(validConventionAdoptionReceipt({ ...example(), retired_rule_ids: [retiredRuleId] }, sectionId), true);
  });
  for (const field of Object.keys(example())) {
    test(`${variant} requires the emitted ${field} field`, () => {
      const receipt = example();
      delete receipt[field];
      assert.equal(validConventionAdoptionReceipt(receipt, sectionId), false);
    });
  }
}

const badUuids = ['', 'not-a-uuid', retiredRuleId.slice(0, -1), `${retiredRuleId}0`,
  retiredRuleId.replaceAll('-', ''), retiredRuleId.replace('d', 'z'), `${retiredRuleId}\n`, 'a'.repeat(64)];
for (const [position, change] of [
  ['retirement target', (receipt, id) => { receipt.retired_rule_ids = [id]; }],
  ['replacement rule', (receipt, id) => { receipt.rule_id = id; receipt.approval.rule_id = id; }],
  ['attach', (receipt, id) => { receipt.attach_id = id; }],
  ['approval receipt', (receipt, id) => { receipt.approval.approval_receipt_id = id; }],
]) test(`${position} accepts only full 36-character UUIDs`, () => {
  for (const id of badUuids) {
    const receipt = replacementReceipt();
    change(receipt, id);
    assert.equal(validConventionAdoptionReceipt(receipt, sectionId), false, JSON.stringify(id));
  }
});
test('the consumed proposal and requested proposal must both be full matching UUIDs', () => {
  for (const id of badUuids)
    assert.equal(validConventionAdoptionReceipt(retirementReceipt(id), id), false, JSON.stringify(id));
  assert.equal(validConventionAdoptionReceipt(retirementReceipt(), retiredRuleId), false);
});

for (const field of Object.keys(replacementReceipt().approval)) {
  test(`replacement approval requires ${field}`, () => {
    const receipt = replacementReceipt();
    delete receipt.approval[field];
    assert.equal(validConventionAdoptionReceipt(receipt, sectionId), false);
  });
}

const invalidFields = {
  ok: [false, null, 1, 'true'], rule_id: [false, {}, 7, ''], card_id: [false, {}, 7, ''],
  load_layer: [false, {}, null, 'layer0', 'control'], packs: [null, {}, 'engineering-git', [], [''], [null],
    ['engineering-git', 'engineering-git'], ['joe-comms', 'engineering-git'], Array(1)],
  approval: [null, false, [], {}],
  retired_rule_ids: [null, 'bad', [null], [''], [retiredRuleId, retiredRuleId], [retiredRuleId, sectionId], Array(1)],
  retired_section_id: [null, {}, 7, retiredRuleId], attach_id: [null, {}, 7],
  generation: [null, true, '2', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity],
};
for (const [field, values] of Object.entries(invalidFields)) {
  test(`replacement ${field} rejects wrong types and inconsistent values`, () => {
    for (const value of values)
      assert.equal(validConventionAdoptionReceipt({ ...replacementReceipt(), [field]: value }, sectionId), false, JSON.stringify(value));
  });
}
const invalidApprovalFields = {
  ok: [false, null, 1], replayed: [true, null, 'false'], rule_id: [null, retiredRuleId],
  policy_status: [null, false, 'proposed'], enforcement_status: [null, false, 'hard_enforced'],
  installed_controls: [null, 'human_authority_runtime', [], ['other'], ['human_authority_runtime', 'other']],
  pending_controls: [null, 'none', ['human_authority_runtime']], approval_receipt_id: [null, false, 'short'],
};
for (const [field, values] of Object.entries(invalidApprovalFields)) {
  test(`approval ${field} rejects wrong types and inconsistent values`, () => {
    for (const value of values) {
      const receipt = replacementReceipt();
      receipt.approval[field] = value;
      assert.equal(validConventionAdoptionReceipt(receipt, sectionId), false, JSON.stringify(value));
    }
  });
}

test('retirement-only metadata stays null with empty packs and nonempty targets', () => {
  for (const patch of [
    { card_id: 'K01' }, { load_layer: 'pack' }, { packs: ['engineering-git'] },
    { approval: replacementReceipt().approval }, { retired_rule_ids: [] },
  ]) assert.equal(validConventionAdoptionReceipt({ ...retirementReceipt(), ...patch }, sectionId), false);
});
test('card delivery has no packs and replacement cannot retire itself', () => {
  assert.equal(validConventionAdoptionReceipt({ ...cardReceipt(), packs: ['engineering-git'] }, sectionId), false);
  const receipt = replacementReceipt();
  receipt.retired_rule_ids = [receipt.rule_id];
  assert.equal(validConventionAdoptionReceipt(receipt, sectionId), false);
});
test('unrecognized fields and malformed optional replay metadata remain unknown', () => {
  for (const value of [false, null, 1, 'true'])
    assert.equal(validConventionAdoptionReceipt({ ...retirementReceipt(), replayed: value }, sectionId), false);
  assert.equal(validConventionAdoptionReceipt({ ...retirementReceipt(), digest: 'a'.repeat(64) }, sectionId), false);
  const receipt = replacementReceipt();
  receipt.approval.contract_hash = 'a'.repeat(64);
  assert.equal(validConventionAdoptionReceipt(receipt, sectionId), false);
  for (const value of [null, [], true, 1, 'receipt'])
    assert.equal(validConventionAdoptionReceipt(value, sectionId), false);
});
