import { PHASE_BY_SLUG } from './client.js';

export function createEmailProposalsFixture({ deals, seedDeals, actor, client, pushEvent }) {
  const digest = async value => `sha256:${[...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const fail = error => { throw Object.assign(Error(error), { payload: { error } }); };
  const phaseDeal = seedDeals.find(deal => deal.phase === 'Research') || seedDeals[1];
  const stepDeal = seedDeals.find(deal => deal.id !== phaseDeal?.id);
  const rows = [stepDeal, phaseDeal].filter(Boolean).map(seed => deals.get(seed.id)).map((deal, index) => ({
    id: `10000000-0000-4000-8000-00000000000${index + 1}`, version: 1, kind: index ? 'phase_move' : 'next_step',
    deal: deal.id, deal_name: deal.name, confidence: 0.9, suspected_instruction: null, status: 'pending',
    source: { activity_id: `30000000-0000-4000-8000-00000000000${index + 1}`, sender: 'demo-correspondent@example.test',
      subject: index ? 'Demo confirmed tour' : 'Demo plan follow-up', occurred_at: '2026-10-26T12:00:00Z',
      evidence_quote: index ? 'The tour is confirmed for November 3.' : 'Please send the revised plan by November 3.' },
    confirm_verb: index ? 'confirm-email-deal-progress' : 'confirm-email-next-step', preview_error: null,
  }));
  const receipts = new Map();
  async function preview(args, kind) {
    const row = rows.find(item => item.deal === args.deal && item.source.activity_id === args.activity_id && item.kind === kind);
    if (!row || row.source.evidence_quote !== args.evidence_quote) fail('email_evidence_not_found');
    const deal = deals.get(row.deal);
    if (kind === 'phase_move' && deal.phase !== 'Research') fail('email_deal_quote_invalid');
    const value = { contract: kind === 'next_step' ? 'email-next-step.v1' : 'email-deal-progress.v1', status: 'proposed',
      deal: row.deal, deal_name: row.deal_name, base_version: deal.version || 1, requires_confirmation: true,
      evidence_quote: args.evidence_quote, source: { activity_id: row.source.activity_id, evidence_ref: `activity:${row.source.activity_id}` },
      ...(kind === 'next_step' ? { text: args.text, next_date: args.next_date, owner: args.owner || 'joe',
        current_next_step: deal.next_step || '', current_next_date: deal.next_date || null,
        ...(args.owner === 'dell' ? { current_owner_actions: [] } : {}) }
        : { from_phase: Object.keys(PHASE_BY_SLUG).find(slug => PHASE_BY_SLUG[slug] === deal.phase), to_phase: 'site_selection' }) };
    return { ...value, proposal_digest: await digest(value) };
  }
  async function confirm(args, kind) {
    if (actor !== 'joe') fail('joe_confirmation_required');
    if (receipts.has(args.idempotency_key)) return structuredClone(receipts.get(args.idempotency_key));
    const shown = await preview(args, kind);
    if (shown.proposal_digest !== args.proposal_digest) fail(kind === 'next_step' ? 'email_next_step_proposal_stale' : 'email_deal_proposal_stale');
    const row = rows.find(item => item.deal === args.deal && item.kind === kind && item.source.activity_id === args.activity_id);
    if (row.status === 'confirmed') fail('email_proposal_not_pending');
    if (row.kind === 'next_step') {
      if (shown.owner === 'joe') await client.setNextStep({ deal: row.deal, text: shown.text, next_date: shown.next_date, base_version: shown.base_version, idempotency_key: args.idempotency_key });
      else {
        const deal = deals.get(row.deal);
        deal.email_actions = [{ id: row.id, description: shown.text, due_on: shown.next_date, owner: 'dell', status: 'open', hold_until: null }];
        deal.next_date = shown.next_date; deal.version++;
        pushEvent({ actor, verb: 'confirm-email-next-step', subject_id: row.deal, field: 'next_date', new_value: shown.next_date });
      }
    } else {
      const deal = deals.get(row.deal);
      const before = deal.phase; deal.phase = PHASE_BY_SLUG[shown.to_phase]; deal.version++;
      pushEvent({ actor, verb: 'confirm-email-deal-progress', subject_id: row.deal, field: 'phase', old_value: before, new_value: deal.phase });
    }
    row.status = 'confirmed'; row.version++;
    const receipt = { ...shown, status: 'confirmed', requires_confirmation: false, email_proposal_id: row.id };
    receipts.set(args.idempotency_key, receipt); return structuredClone(receipt);
  }
  return {
    async listEmailProposals() {
      const proposals = [];
      for (const row of rows.filter(item => item.status === 'pending')) {
        const { status, ...item } = row;
        try { item.preview = await preview({ deal: row.deal, activity_id: row.source.activity_id, evidence_quote: row.source.evidence_quote,
          text: 'Send the revised plan', next_date: '2026-11-03', owner: 'joe' }, row.kind); }
        catch (error) { item.preview = null; item.preview_error = error.payload?.error || 'preview_failed'; }
        proposals.push(structuredClone(item));
      }
      return { schema_version: 'email-proposals.v1', proposals, send: false };
    },
    previewEmailNextStep: args => preview(args, 'next_step'),
    previewEmailDealProgress: args => preview(args, 'phase_move'),
    confirmEmailNextStep: args => confirm(args, 'next_step'),
    confirmEmailDealProgress: args => confirm(args, 'phase_move'),
    async dismissEmailProposal(args) {
      if (!['joe', 'dell'].includes(actor)) fail('partner_dismissal_required');
      if (receipts.has(args.idempotency_key)) return structuredClone(receipts.get(args.idempotency_key));
      const row = rows.find(item => item.id === args.proposal_id);
      if (!row || row.status !== 'pending') fail('email_proposal_not_pending');
      if (row.version !== args.base_version) fail('version_conflict');
      if (!args.reason?.trim()) fail('email_proposal_reason_required');
      row.status = 'dismissed'; row.version++;
      const receipt = { ok: true, proposal_id: row.id, status: 'dismissed', version: row.version };
      receipts.set(args.idempotency_key, receipt); return structuredClone(receipt);
    },
  };
}
