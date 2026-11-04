import { createTourProposalClient, type Proposal, record } from './tour-proposal-client';
export function createTourProposalFixture(dealId:string) {
  const added='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', removed='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', unchanged='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const theirs=[added,unchanged];
  let shortlist=[removed,unchanged], version='dddddddd-dddd-4ddd-8ddd-dddddddddddd', state='pending';
  const writes: unknown[]=[];
  const proposal:Proposal={id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',tour_id:'ffffffff-ffff-4fff-8fff-ffffffffffff',deal_id:dealId,
    portal_revision:2,state,items:theirs.map(carr_property_id=>({carr_property_id})),choices:{},expected_selection_version_id:version,difference:{add:[added],remove:[removed]}};
  const receipts=new Map<string,unknown>();
  const rpc=async (name:string,args:unknown):Promise<unknown>=>{
    if(name==='list-deal-tour-proposals') return {ok:true,schema_version:'client-tour-proposals.v1',pending_count:state==='pending'?1:0,proposals:[{...proposal,state,expected_selection_version_id:version}]};
    if(name==='read-tour-selection-cart') return {ok:true,cart:{selection_version_id:version,tour_id:proposal.tour_id,property_ids:shortlist}};
    if(name==='accept-client-tour-proposal' || name==='dismiss-client-tour-proposal') {
      if(!record(args) || typeof args.idempotency_key !== 'string') throw Error('Invalid fixture resolution');
      const request=args, key=args.idempotency_key;
      writes.push(structuredClone(args));
      if(receipts.has(key)) return receipts.get(key);
      if(name==='dismiss-client-tour-proposal') state='dismissed';
      else {
        if(request.mode==='keep_mine' || request.expected_selection_version_id!==version) return {ok:false,error:'proposal_shortlist_conflict'};
        shortlist=request.mode==='use_theirs'?[...theirs]:[...new Set([...shortlist,...theirs])].filter(id=>(record(request.choices) && typeof request.choices[id] === 'boolean' ? request.choices[id] : undefined) ?? shortlist.includes(id));
        version='99999999-9999-4999-8999-999999999999';state='accepted';
      }
      const result={ok:true,schema_version:'client-tour-proposals.v1',receipt:{proposal_id:proposal.id,state,selection_version_id:version}};
      receipts.set(key,result);return result;
    }
    return {ok:false,error:'unknown_tool'};
  };
  const tour=async()=>({id:proposal.tour_id,deal_id:dealId,stops:[{property_id:added,property_name:'Demo addition'},{property_id:removed,property_name:'Demo removal'},{property_id:unchanged,property_name:'Demo unchanged',appointment_start:'2030-01-01T10:00:00Z'}]});
  return {client:createTourProposalClient({rpc,tour}),rpc,proposal,writes,theirs,shortlist:()=>[...shortlist]};
}
