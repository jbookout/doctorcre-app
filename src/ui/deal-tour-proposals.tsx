import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createTourProposalClient, proposalCode, type Proposal, type ProposalClient, type Resolution } from './tour-proposal-client';
export { createTourProposalClient } from './tour-proposal-client';

type Choice = { mode: 'use_theirs' | 'keep_mine' | 'per_property'; properties: Record<string,boolean> };
type Receipt = {state:string;selection_version_id:string|null};
type View = {kind:'none' | 'loading' | 'unavailable' | 'pending' | 'comparing'} |
  {kind:'choosing'; choice:Choice} | {kind:'accepting'; request:Resolution} |
  {kind:'stale'; choice:Choice} | {kind:'refused'; choice:Choice; request:Resolution; receipt:Receipt|null} |
  {kind:'accepted'; ids:string[]; dismissed:boolean};
export function mountDealTourProposals(element: Element, {dealId,client,onPending = () => {}}: {
  dealId:string; client:ProposalClient; onPending?(count:number):void;
}) {
  const root = createRoot(element);
  let view:View = {kind:'loading'}, current:Proposal | null = null, labels:Record<string,string> = {};
  let disposed = false, generation = 0, busy = false;
  const win = element.ownerDocument.defaultView;
  const pending = (p:Proposal) => p.state === 'pending' || p.state === 'partially_accepted';
  const members = () => current ? [...new Set([...current.items.map(i=>i.carr_property_id),...current.difference.remove])] : [];
  const mine = (id:string) => !!current && !current.difference.add.includes(id);
  function choice(mode:Choice['mode']):Choice {
    return {mode,properties:Object.fromEntries(members().map(id=>[id,mode === 'keep_mine' ? mine(id) : !!current?.items.some(i=>i.carr_property_id===id)]))};
  }
  function render() {
    if (disposed) return;
    const p = current;
    const editable = view.kind === 'choosing' || view.kind === 'stale' || view.kind === 'refused' ? view.choice : null;
    const changed = editable ? Object.entries(editable.properties).filter(([id,value])=>value!==mine(id)).length : 0;
    const invalidChoices = editable?.mode === 'per_property' && (changed===0 || changed>100);
    flushSync(()=>root.render(<section className="deal-tour-proposals" aria-label="Client tour proposal" aria-live="polite">
      {view.kind === 'loading' && <p>Checking client tour proposals…</p>}
      {view.kind === 'unavailable' && <p>Client proposals unavailable. <button className="btn" onClick={()=>void refresh()}>Refresh proposals</button></p>}
      {view.kind === 'accepted' && <><h3>{view.dismissed ? 'Your shortlist kept' : 'Shortlist confirmed'}</h3><p>{view.dismissed ? 'Client proposal dismissed.' : 'Your choices are saved. Review the route separately; appointments have not changed.'}</p><ul>{view.ids.map(id=><li key={id}>{labels[id] || 'Property label unavailable'} <code>{id}</code></li>)}</ul><button className="btn" onClick={()=>void refresh()}>Check proposals</button></>}
      {p && !['none','loading','unavailable','accepted'].includes(view.kind) && <>
        <h3>Client saved a tour list <span className="badge">Proposal</span></h3>
        <p>Compare this client list with your shortlist. Nothing changes until you accept.</p>
        <p>Saved list revision {p.portal_revision}. Route and appointments stay as they are.</p>
        {view.kind === 'pending' ? <button className="btn" data-compare onClick={()=>{view={kind:'comparing'};render();}}>Compare shortlist</button> : null}
          <ul className="proposal-properties">{members().map(id=>{
            const difference = p.difference.add.includes(id) ? 'Added' : p.difference.remove.includes(id) ? 'Removed' : 'Unchanged';
            return <li key={id}><strong>{labels[id] || 'Property label unavailable'}</strong><span>{difference}</span><code>{id}</code>
              <label><input type="checkbox" aria-label={`Include ${labels[id] || id}`} checked={editable ? !!editable.properties[id] : mine(id)} disabled={view.kind === 'pending' || view.kind === 'accepting' || view.kind === 'refused' || view.kind === 'stale'} onChange={event=>{
                const next = editable || choice('keep_mine');
                view={kind:'choosing',choice:{mode:'per_property',properties:{...next.properties,[id]:event.target.checked}}};render();
              }}/> Include in shortlist</label></li>;
          })}</ul>
          {(view.kind === 'comparing' || view.kind === 'choosing') && <div className="proposal-actions">
            <button className="btn" data-use-theirs onClick={()=>{view={kind:'choosing',choice:choice('use_theirs')};render();}}>Use theirs</button>
            <button className="btn btn-quiet" data-keep-mine onClick={()=>{view={kind:'choosing',choice:choice('keep_mine')};render();}}>Keep mine</button>
            {view.kind === 'choosing' && <button className="btn" data-accept-proposal disabled={invalidChoices} onClick={()=>{if(view.kind === 'choosing') void accept(view.choice);}}>Accept {view.choice.mode === 'keep_mine' ? 'keeping mine' : 'choices'}</button>}
          </div>}
          {invalidChoices && <p>Choose between 1 and 100 property changes, or choose Keep mine.</p>}
          {view.kind === 'accepting' && <p>Confirming your choice…</p>}
          {view.kind === 'stale' && <p role="alert">Your shortlist changed. Your choices are kept. <button className="btn" onClick={()=>{if(view.kind === 'stale') void refresh(view.choice);}}>Refresh comparison</button></p>}
          {view.kind === 'refused' && <p role="alert">{view.receipt ? 'The decision was received, but shortlist readback is unavailable.' : 'The decision was not confirmed. Your choices are kept.'} <button className="btn" onClick={()=>{if(view.kind === 'refused') void send(view.request,view.choice,view.receipt);}}>{view.receipt ? 'Check shortlist' : 'Retry same decision'}</button></p>}
      </>}
    </section>));
  }
  async function refresh(keep?:Choice) {
    if (busy || disposed) return;
    const ticket = ++generation; busy=true; view={kind:'loading'};render();
    try {
      const data = await client.list(dealId);
      if(disposed || ticket !== generation) return;
      const rows = data.proposals.filter(p=>p.deal_id === dealId && pending(p));
      const old = current; current=rows[0] || null;
      onPending(rows.length ? data.pending_count : 0);
      labels = current ? await client.labels(current.tour_id,dealId).catch(()=>({})) : {};
      if(disposed || ticket !== generation) return;
      view=current ? keep && old?.id === current.id ? {kind:'choosing',choice:keep} : {kind:'pending'} : {kind:'none'};
    } catch(error) { if(disposed || ticket !== generation) return; current=null; view={kind:proposalCode(error)==='unknown_tool' ? 'none' : 'unavailable'}; }
    finally { if(ticket === generation) {busy=false;render();} }
  }
  async function accept(selected:Choice) {
    if (!current || busy) return;
    const base = {deal_id:dealId,proposal_id:current.id,idempotency_key:crypto.randomUUID()};
    const decisions=Object.fromEntries(Object.entries(selected.properties).filter(([id,value])=>value!==mine(id)));
    if(selected.mode === 'per_property' && !Object.keys(decisions).length) return;
    const version={expected_selection_version_id:current.expected_selection_version_id};
    const request:Resolution = selected.mode === 'keep_mine' ? {...base,mode:'keep_mine'} : selected.mode === 'use_theirs' ? {...base,...version,mode:'use_theirs'} : {...base,...version,mode:'per_property',choices:decisions};
    await send(request,selected,null);
  }
  async function send(request:Resolution,selected:Choice,prior:Receipt|null) {
    if(busy || !current || disposed) return;
    const p=current, ticket=++generation;busy=true;view={kind:'accepting',request};render();
    let receipt=prior;
    try {
      receipt ||= await client.resolve(request);
      if(disposed || ticket!==generation) return;
      const cart=await client.shortlist(p.tour_id);
      if(disposed || ticket!==generation) return;
      if(cart.selection_version_id !== receipt.selection_version_id) throw Error('proposal_readback_unconfirmed');
      view={kind:'accepted',ids:cart.property_ids,dismissed:receipt.state === 'dismissed'};
      const data=await client.list(dealId);
      if(disposed || ticket!==generation) return;
      onPending(data.pending_count);
    } catch(error) {
      if(disposed || ticket!==generation) return;
      view=proposalCode(error)==='proposal_shortlist_conflict' ? {kind:'stale',choice:selected} : {kind:'refused',choice:selected,request,receipt};
    } finally {if(ticket===generation) {busy=false;render();}}
  }
  function invalidate() {++generation;busy=false;current=null;labels={};view={kind:'none'};onPending(0);render();}
  win?.addEventListener('doctorcre-session-invalidated',invalidate);
  void refresh();
  return {refresh,dispose(){disposed=true;++generation;win?.removeEventListener('doctorcre-session-invalidated',invalidate);root.unmount();}};
}

export async function bootDealTourProposals(element:Element, options:{dealId:string;mode:string;client?:ProposalClient}) {
  const sibling=(path:string)=>import(new URL(path,import.meta.url).href);
  const [{createMcpRequests},{createPlannerClient}]=await Promise.all([sibling('./mcp-requests.mjs'),sibling('../tours/planner-client.js')]);
  const request=createMcpRequests(), planner=createPlannerClient();
  const rpc=async(name:string,args:unknown):Promise<unknown>=>{
    if(options.mode !== 'live') return {ok:false,error:'unknown_tool'};
    const outcome=await request(name,args,{timeoutMs:10000});
    if(outcome.kind !== 'payload') throw Error('proposal_unavailable');
    return outcome.payload;
  };
  return mountDealTourProposals(element,{...options,client:options.client ?? createTourProposalClient({rpc,tour:(id)=>planner.tour(id)}),onPending(count) {
    if (!element.isConnected) return;
    const doc=element.ownerDocument;
    doc.querySelectorAll(`[data-tour-proposal-badge="${options.dealId}"]`).forEach(node=>node.remove());
    if (!count) return;
    const targets=[doc.getElementById('tab-tours'),...doc.querySelectorAll(`[data-open="${options.dealId}"]`)];
    targets.forEach(target=>{
      if(!target) return;
      const badge=doc.createElement('span');badge.className='badge';badge.dataset.tourProposalBadge=options.dealId;
      badge.textContent=` ${count} client proposal${count===1?'':'s'}`;target.append(badge);
    });
  }});
}
