import { PHASE_BY_SLUG } from './client.js';

export function createEmailProposalsFixture({ deals, seedDeals, actor, client, pushEvent, replyDrafts = false, filingProposals = false }) {
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
  if (replyDrafts && stepDeal) rows.push({ ...structuredClone(rows[0]), id: '10000000-0000-4000-8000-000000000003', kind: 'reply_draft',
    confirm_verb: 'submit-email-draft', preview: null, reply_draft: { subject: 'Re: Demo floor plan', body: 'Thank you for the plan.', owner: actor, to: ['demo-correspondent@example.test'], cc: [actor === 'joe' ? 'demo-dell@example.test' : 'demo-joe@example.test'] } });
  if (filingProposals && stepDeal) for (const [index, kind] of ['file_to_deal', 'possible_new_deal'].entries()) {
    rows.push({ ...structuredClone(rows[0]), id: `10000000-0000-4000-8000-00000000001${index}`, kind,
      deal: index ? null : stepDeal.id, deal_name: index ? null : stepDeal.name, proposed_matter: index ? 'Possible new demo practice' : null,
      sender_role: 'client', confirm_verb: 'confirm-email-filing' });
  }
  const receipts = new Map();
  async function preview(args, kind) {
    const row = rows.find(item => item.deal === args.deal && item.source.activity_id === args.activity_id && item.kind === kind);
    if (!row || row.source.evidence_quote !== args.evidence_quote) fail('email_evidence_not_found');
    if (['file_to_deal', 'possible_new_deal'].includes(kind)) {
      const value = { contract: 'email-filing.v1', proposal_id: row.id, kind, deal: row.deal, activity_id: row.source.activity_id,
        evidence_quote: row.source.evidence_quote, sender_role: row.sender_role, sender: { name: 'Demo client', party_id: 'demo-contact' },
        new_people: [], text: row.proposed_matter, requires_confirmation: true };
      return { ...value, proposal_digest: await digest(value) };
    }
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
    async getEmailProposalQuality() {
      const kinds = [...(filingProposals ? ['file_to_deal', 'possible_new_deal'] : []), 'phase_move', 'next_step', ...(replyDrafts ? ['reply_draft'] : [])].map(kind => {
        const cohort = rows.filter(row => row.kind === kind);
        const confirmed = cohort.filter(row => row.status === 'confirmed');
        const dismissed = cohort.filter(row => row.status === 'dismissed');
        const resolved = confirmed.length + dismissed.length;
        const average = items => items.length ? items.reduce((sum, row) => sum + row.confidence, 0) / items.length : null;
        const rate = resolved ? dismissed.length / resolved : null;
        return { kind, proposed: cohort.length, pending: cohort.filter(row => row.status === 'pending').length,
          confirmed: confirmed.length, dismissed: dismissed.length, dismiss_rate: rate,
          confirmed_confidence: average(confirmed), dismissed_confidence: average(dismissed),
          over_threshold: resolved >= 10 && rate > 0.05 };
      });
      return { schema_version: 'email-proposal-quality.v1', days: 7, kinds,
        corrections: rows.filter(row => row.status === 'dismissed').sort((a, b) => b.resolved_at.localeCompare(a.resolved_at) || a.id.localeCompare(b.id)).slice(0, 20)
          .map(row => ({ id: row.id, kind: row.kind, deal_name: row.deal_name, reason: row.resolution_reason, resolved_at: row.resolved_at })), send: false };
    },
    async listEmailProposals({ deal, limit, cursor, mode, status } = {}) {
      if (mode === 'recent_outcomes') {
        if (status !== undefined || limit > 50) fail('email_outcomes_arguments_invalid');
        if (cursor) fail('email_proposals_cursor_invalid');
        return { schema_version: 'email-reply-outcomes.v1', proposals: [], send: false, more: false, next_cursor: null };
      }
      const proposals = [];
      const start = cursor ? rows.findIndex(item => item.id === cursor) + 1 : 0;
      if (cursor && (!start || (deal && rows[start - 1].deal !== deal))) fail('email_proposals_cursor_invalid');
      const pending = rows.slice(start).filter(item => item.status === (status || 'pending') && (!deal || item.deal === deal));
      for (const row of pending.slice(0, limit || pending.length)) {
        const { status, ...item } = row;
        if (row.kind === 'reply_draft') { proposals.push(structuredClone({ ...item, status })); continue; }
        try { item.preview = await preview({ deal: row.deal, activity_id: row.source.activity_id, evidence_quote: row.source.evidence_quote,
          text: 'Send the revised plan', next_date: '2026-11-03', owner: 'joe' }, row.kind); }
        catch (error) { item.preview = null; item.preview_error = error.payload?.error || 'preview_failed'; }
        proposals.push(structuredClone(item));
      }
      const more = limit ? pending.length > limit : false;
      return { schema_version: 'email-proposals.v1', proposals, send: false, ...(limit ? { more, next_cursor: more ? proposals.at(-1).id : null } : {}) };
    },
    previewEmailNextStep: args => preview(args, 'next_step'),
    previewEmailDealProgress: args => preview(args, 'phase_move'),
    async confirmEmailFiling(args) {
      if (receipts.has(args.idempotency_key)) return structuredClone(receipts.get(args.idempotency_key));
      const row = rows.find(item => item.id === args.proposal_id && ['file_to_deal', 'possible_new_deal'].includes(item.kind));
      if (!row || row.status !== 'pending') fail('email_proposal_not_pending');
      if (row.version !== args.base_version) fail('version_conflict');
      const shown = await preview({ deal: row.deal, activity_id: row.source.activity_id, evidence_quote: row.source.evidence_quote }, row.kind);
      if (shown.proposal_digest !== args.proposal_digest) fail('email_proposal_stale');
      const deal = row.kind === 'possible_new_deal' ? args.deal : row.deal;
      if (!deals.has(deal)) fail('email_new_deal_not_found');
      row.status = 'confirmed'; row.version++;
      const receipt = { ok: true, status: 'confirmed', deal, activity_id: row.source.activity_id };
      receipts.set(args.idempotency_key, receipt); return structuredClone(receipt);
    },
    confirmEmailNextStep: args => confirm(args, 'next_step'),
    confirmEmailDealProgress: args => confirm(args, 'phase_move'),
    async submitEmailDraft(args) {
      if (receipts.has(args.idempotency_key)) return structuredClone(receipts.get(args.idempotency_key));
      const row = rows.find(item => item.id === args.proposal_id && item.kind === 'reply_draft');
      if (!row) fail('email_draft_not_found');
      if (row.reply_draft.owner !== actor) fail('email_draft_not_owner');
      if (row.status !== 'pending') fail('email_draft_already_submitted');
      if (row.version !== args.base_version) fail('version_conflict');
      if (JSON.stringify(args.to) !== JSON.stringify(row.reply_draft.to) || JSON.stringify(args.cc) !== JSON.stringify(row.reply_draft.cc)) fail('email_draft_recipients_mismatch');
      if (!args.body?.trim() || args.body.length > 20000) fail('email_draft_empty_body');
      if (!args.subject?.trim() || /[\r\n]/.test(args.subject) || args.subject.length > 998) fail('email_draft_subject_invalid');
      row.status = 'approved_to_send'; row.version++;
      const receipt = { ok: true, proposal_id: row.id, status: row.status, version: row.version, subject: args.subject, body: args.body,
        sha256: (await digest({ subject: args.subject, body: args.body })).slice(7), to: [...row.reply_draft.to], cc: [...row.reply_draft.cc] };
      row.submitted_email = structuredClone({ subject: args.subject, body: args.body }); row.send_result = null; row.result_recorded_at = null;
      receipts.set(args.idempotency_key, receipt); return structuredClone(receipt);
    },
    async dismissEmailProposal(args) {
      if (!['joe', 'dell'].includes(actor)) fail('partner_dismissal_required');
      if (receipts.has(args.idempotency_key)) return structuredClone(receipts.get(args.idempotency_key));
      const row = rows.find(item => item.id === args.proposal_id);
      if (!row || row.status !== 'pending') fail('email_proposal_not_pending');
      if (row.version !== args.base_version) fail('version_conflict');
      if (!args.reason?.trim()) fail('email_proposal_reason_required');
      row.status = 'dismissed'; row.version++; row.resolution_reason = args.reason.trim(); row.resolved_at = new Date().toISOString();
      const receipt = { ok: true, proposal_id: row.id, status: 'dismissed', version: row.version };
      receipts.set(args.idempotency_key, receipt); return structuredClone(receipt);
    },
  };
}
