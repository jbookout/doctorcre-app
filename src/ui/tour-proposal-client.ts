export type Proposal = {
  id: string; deal_id: string; tour_id: string; portal_revision: number;
  state: string; items: { carr_property_id: string }[]; choices: Record<string, boolean>;
  expected_selection_version_id: string | null; difference: { add: string[]; remove: string[] };
};
export type Resolution = { deal_id: string; proposal_id: string; idempotency_key: string } &
  ({ mode: 'keep_mine' } | { mode: 'use_theirs'; expected_selection_version_id: string | null } | { mode: 'per_property'; expected_selection_version_id: string | null; choices: Record<string, boolean> });
export type ProposalClient = {
  list(dealId: string): Promise<{ proposals: Proposal[]; pending_count: number }>;
  labels(tourId: string, dealId: string): Promise<Record<string, string>>;
  resolve(request: Resolution): Promise<{ state: string; selection_version_id: string | null }>;
  shortlist(tourId: string): Promise<{ property_ids: string[]; selection_version_id: string | null }>;
};
export const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 100 && v.every(uuid) && new Set(v).size === v.length;
function proposal(v: unknown): Proposal {
  if (!record(v) || !uuid(v.id) || !uuid(v.deal_id) || !uuid(v.tour_id) || !Number.isSafeInteger(v.portal_revision) || typeof v.portal_revision !== 'number' || v.portal_revision < 1 ||
    typeof v.state !== 'string' || !['pending','partially_accepted','accepted','dismissed','superseded'].includes(v.state) ||
    !(v.expected_selection_version_id === null || uuid(v.expected_selection_version_id)) || !Array.isArray(v.items) || v.items.length > 100 ||
    !record(v.difference) || !ids(v.difference.add) || !ids(v.difference.remove) || !record(v.choices)) throw Error('proposal_invalid');
  const items = v.items.map(item => { if (!record(item) || !uuid(item.carr_property_id)) throw Error('proposal_invalid'); return {carr_property_id:item.carr_property_id}; });
  if (new Set(items.map(item => item.carr_property_id)).size !== items.length) throw Error('proposal_invalid');
  const choices: Record<string,boolean> = {};
  Object.entries(v.choices).forEach(([key,value]) => { if (!uuid(key) || typeof value !== 'boolean') throw Error('proposal_invalid'); choices[key] = value; });
  return {id:v.id,deal_id:v.deal_id,tour_id:v.tour_id,portal_revision:v.portal_revision,state:v.state,items,choices,
    expected_selection_version_id:v.expected_selection_version_id,difference:{add:v.difference.add,remove:v.difference.remove}};
}
export function proposalCode(error: unknown): string {
  return record(error) && typeof error.code === 'string' ? error.code : error instanceof Error ? error.message : 'unavailable';
}
type Rpc = (name: string, args: unknown) => Promise<unknown>;
export function createTourProposalClient({ rpc, tour, now = Date.now }: {rpc: Rpc; tour(id: string): Promise<unknown>; now?: () => number}): ProposalClient {
  let failures = 0, until = 0;
  async function external(operation: () => Promise<unknown>) {
    if (now() < until) throw Error('proposal_circuit_open');
    try {
      const value = await operation();
      failures = 0; return value;
    } catch (error) { if (++failures >= 2) until = now()+60000; throw error; }
  }
  async function call(name:string,args:unknown) {
    const value=await external(()=>rpc(name,args));
    if(!record(value) || value.ok !== true || value.schema_version !== 'client-tour-proposals.v1')
      throw Object.assign(Error('proposal_unavailable'),{code:record(value) && typeof value.error === 'string' ? value.error : 'proposal_unavailable'});
    return value;
  }
  return {
    async list(dealId) {
      const value = await call('list-deal-tour-proposals',{deal_id:dealId});
      if (!Array.isArray(value.proposals) || value.proposals.length > 50 || !Number.isSafeInteger(value.pending_count) || typeof value.pending_count !== 'number' || value.pending_count < 0) throw Error('proposal_invalid');
      return {proposals:value.proposals.map(proposal).filter(p => p.deal_id === dealId),pending_count:value.pending_count};
    },
    async labels(tourId,dealId) {
      const value = await external(()=>tour(tourId)), labels: Record<string,string> = {};
      if (!record(value) || value.id !== tourId || value.deal_id !== dealId || !Array.isArray(value.stops)) return labels;
      value.stops.slice(0,100).forEach(stop => { if (record(stop) && uuid(stop.property_id)) {
        const label = stop.property_name || stop.name;
        if (typeof label === 'string' && label) labels[stop.property_id] = label;
      } });
      return labels;
    },
    async resolve(request) {
      const {mode,...base} = request;
      const value = await call(mode === 'keep_mine' ? 'dismiss-client-tour-proposal' : 'accept-client-tour-proposal',mode === 'keep_mine' ? base : request);
      const r = value.receipt;
      if (!record(r) || r.proposal_id !== request.proposal_id || !['accepted','partially_accepted','dismissed'].includes(String(r.state)) || typeof r.state !== 'string' ||
        !(r.selection_version_id === null || uuid(r.selection_version_id))) throw Error('proposal_receipt_unconfirmed');
      return {state:r.state,selection_version_id:r.selection_version_id};
    },
    async shortlist(tourId) {
      const value = await external(()=>rpc('read-tour-selection-cart',{tour_id:tourId}));
      const cart = record(value) ? value.cart : null;
      if (!record(cart) || cart.tour_id !== tourId || !ids(cart.property_ids) || !(cart.selection_version_id == null || uuid(cart.selection_version_id))) throw Error('proposal_readback_unconfirmed');
      return {property_ids:cart.property_ids,selection_version_id:cart.selection_version_id ?? null};
    },
  };
}
