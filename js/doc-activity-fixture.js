// Synthetic, in-memory events only. No outward effect and no durable storage.
export function createDocActivityFixture(clock = () => new Date()) {
  const at = new Date(clock()).valueOf();
  const entries = [
    ['Phase changed', 'Demo Harbor Dental', 'deal', 'joe', 'Representation agreement recorded.', 'Research', 'Site selection', 'available'],
    ['Draft staged', 'Demo Bay lease update', 'document', 'dell', 'The tour feedback is ready for a client update.', null, null, 'unavailable'],
    ['Lead created', 'Demo Coastal Optometry', 'lead', 'joe', 'A new practice opportunity matched the saved territory.', null, null, 'unavailable'],
    ['Stage changed', 'Demo Northside Therapy', 'deal', 'dell', 'The accepted proposal is ready for legal review.', 'Negotiation', 'Legal', 'available'],
    ['Records merged', 'Demo Duplicate Practice', 'client', 'joe', 'Two demo entries described the same practice.', null, null, 'irreversible'],
  ].map(([what,name,type,partner,why,before,after,state], i) => {
    const id = `a1000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
    const date = new Date(at - i * 3_600_000).toISOString();
    return { id, at: date, actor: i === 2 ? 'Automation' : 'Doc', partner,
      record: { id: `b1000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`, type, name }, what, why, before, after,
      undo: { state, ...(state === 'available' ? { verb: 'revert-deal-field', event_id: id } : {}) },
      evidence: { kind: 'entry', at: date, summary: why, reason: why, before, after, quote: null } };
  });
  const receipts = new Map();
  return {
    async read(args = {}) {
      const rows = entries.filter(row => (!args.partner || args.partner === row.partner)
        && (!args.record_type || args.record_type === row.record.type)
        && (!args.since || Date.parse(row.at) >= Date.parse(args.since))
        && (!args.until || Date.parse(row.at) < Date.parse(args.until))
        && (!args.cursor || Date.parse(row.at) < Date.parse(args.cursor.at)
          || (row.at === args.cursor.at && row.id < args.cursor.id)));
      const page = rows.slice(0,args.limit || 50), last = page.at(-1);
      return structuredClone({ ok: true, schema_version: 'doc-activity.v1', as_of: new Date(clock()).toISOString(), entries: page,
        record_types: [...new Set(entries.map(row => row.record.type))].sort(),
        next_cursor: rows.length > page.length ? { at: last.at, id: last.id } : null });
    },
    owns: id => entries.some(row => row.id === id),
    async undo(args) {
      if (receipts.has(args.idempotency_key)) return receipts.get(args.idempotency_key);
      const row = entries.find(row => row.id === args.event_id);
      if (row?.undo.state !== 'available') { const error = new Error('newer_change_exists'); error.payload = { error: 'newer_change_exists' }; throw error; }
      row.undo = { state: 'undone' };
      const receipt = { ok: true, reverted_event_id: row.id };
      receipts.set(args.idempotency_key, receipt); return receipt;
    },
  };
}
