// Synthetic examples of server 1557e82's ops.adopt_rule and approval return values.
export const sectionId = 'd0000000-0000-4000-8000-00000000c151';
export const retiredRuleId = 'd0000000-0000-4000-8000-00000000c161';
export const replacementRuleId = 'd0000000-0000-4000-8000-00000000c162';

export function retirementReceipt(retired_section_id = sectionId) {
  return {
    ok: true, rule_id: null, card_id: null, load_layer: null, packs: [], approval: null,
    retired_rule_ids: [retiredRuleId], retired_section_id,
    attach_id: 'd0000000-0000-4000-8000-00000000c163', generation: 2,
  };
}

export function replacementReceipt(retired_section_id = sectionId) {
  return {
    ...retirementReceipt(retired_section_id), rule_id: replacementRuleId, load_layer: 'pack',
    packs: ['engineering-git'], retired_rule_ids: [],
    approval: {
      ok: true, replayed: false, rule_id: replacementRuleId, policy_status: 'active',
      enforcement_status: 'authority_enforced', installed_controls: ['human_authority_runtime'],
      pending_controls: [], approval_receipt_id: 'd0000000-0000-4000-8000-00000000c164',
    },
  };
}
