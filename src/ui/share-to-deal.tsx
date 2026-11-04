import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { bindActor, changeDeal, draftStore, fileBatch, stageFiles, FILE_ACCEPT, EXPIRY, parseReceipt } from './share-draft-store';
import type { IncomingDealShare, UploadClient } from './share-draft-store';
type Deal = {id:string;name:string};
type Client = UploadClient & {getBoard(options?: {signal:AbortSignal}):Promise<{actor:string;deals:Deal[]}>};
export async function mountShareToDeal(element: Element, client: Client) {
  const root=createRoot(element), store=draftStore(), controller=new AbortController();
  let draft: IncomingDealShare | null=null, actor='', deals: Deal[]=[], message='Opening pending files…', busy=true, disposed=false, page=0;
  const save=async () => {if(controller.signal.aborted || disposed || !draft) return;if(draft.state==='filed') await store.clear();else await store.save(draft);render();};
  function render() {
    if(disposed)return;
    flushSync(() => root.render(<section aria-label="Share to deal"><h1>Share to deal</h1>
      <p>Choose up to three PDF, Office or photo files, up to 25 MiB total. Files stay on this device until you choose a deal and press File documents.</p>
      <p>On iPhone and Safari, use the file picker. Receiving files from the system share sheet is unsupported.</p>
      <p>Cancel removes pending local files. Documents already filed remain in their deals.</p>
      <p role="status">{navigator.onLine===false ? 'Offline. Pending files remain on this device. Reconnect to continue.' : message}</p>
      {!draft && <label className="btn">Choose files<input type="file" aria-label="Choose files" accept={FILE_ACCEPT} multiple disabled={busy || !actor} onChange={event=>{const files=Array.from(event.currentTarget.files || []);event.currentTarget.value='';if(files.length)void stage(files);}} /></label>}
      {draft && <><ul>{draft.files.map(file=><li key={file.local_id}>{file.name} <span>{file.confirmed ? 'Filed and confirmed' : file.error || 'Pending on this device'}</span></li>)}</ul>
      <label>Deal<select aria-label="Deal" value={draft.selected_deal_id || ''} disabled={busy || draft.state==='filed'} onChange={event=>void choose(event.currentTarget.value)}><option value="">Choose a deal</option>{deals.slice(page*25,page*25+25).map(deal=><option key={deal.id} value={deal.id}>{deal.name}</option>)}</select></label>
      <button type="button" disabled={busy || page===0} onClick={()=>{page--;render();}}>Previous deals</button><button type="button" disabled={busy || (page+1)*25>=deals.length} onClick={()=>{page++;render();}}>More deals</button>
      <p>{draft.state.replaceAll('_',' ')}</p>
      {draft.state!=='filed' && <><button type="button" className="btn" disabled={busy || !draft.selected_deal_id || !actor || navigator.onLine===false || draft.state==='expired' || draft.files.every(file=>file.confirmed || file.retries>=3)} onClick={()=>void submit()}>{draft.state==='unknown_outcome' ? 'Check unresolved files' : 'File documents'}</button><button type="button" className="btn" disabled={busy} onClick={()=>void cancel()}>Cancel pending files</button></>}
      {draft.state==='filed' && <a href={`/deals?deal=${encodeURIComponent(draft.selected_deal_id || '')}&tab=documents`}>Open deal documents</a>}
      </>}
      <a href="/share-to-deal">Open pending draft or reselect</a>
    </section>));
  }
  async function stage(files: File[]) {busy=true;render();try {const next=await stageFiles(files);bindActor(next,actor);await store.save(next,true);draft=next;message='Choose the deal for these files.';}catch {message='Files were not staged. Reselect files or cancel the existing draft. Local storage may be full.';}finally{busy=false;render();}}
  async function choose(deal:string) {if(!draft || !deal || busy)return;busy=true;render();try {await changeDeal(draft,deal,client,save,controller.signal);message='Ready to file into the selected deal.';}catch{message='Could not change deal. Existing reservations must be reconciled first.';}finally{busy=false;render();}}
  async function submit() {
    if(!draft || busy || document.visibilityState==='hidden')return;
    if(draft.state==='unknown_outcome' && Date.now()-draft.last_reconcile<60_000){message='Wait one minute before checking the same receipt again.';render();return;}
    busy=true;draft.last_reconcile=Date.now();message='Checking selected deal and file receipts…';render();
    try {await fileBatch(draft,client,save,controller.signal);message=draft.state==='filed' ? 'Documents filed and confirmed by the deal document list.' : 'Some files remain unconfirmed. Bytes are retained. Check unresolved files after reconnecting.';}catch{message='Local storage unavailable. Keep this page open to retry, or reselect the original files.';if(draft)draft.state='quota_refused';}finally{busy=false;render();}
  }
  // eslint-disable-next-line no-restricted-syntax -- Cancellation visits at most three persisted reservations once per user action.
  async function cancel() {if(!draft)return;busy=true;render();try {for(const file of draft.files) if(file.attempted && !file.confirmed) {const receipt=parseReceipt(await client.readDealDocumentUpload({idempotency_key:file.reserve_key,upload_id:file.receipt?.upload_id || null},{signal:controller.signal}),file,draft.selected_deal_id || '');if(receipt.state!=='committed' && receipt.state!=='cancelled'){const cancelled=parseReceipt(await client.cancelDealDocumentUpload({upload_id:receipt.upload_id,idempotency_key:file.cancel_key},{signal:controller.signal}),file,draft.selected_deal_id || '');if(cancelled.state!=='cancelled')throw Error('Cancellation unconfirmed');}}draft.state='cancelled';await store.clear();draft=null;message='Pending files cancelled.';}catch{message='Cancellation unconfirmed. Files remain on this device.';}finally{busy=false;render();}}
  const revoke=()=>{controller.abort();draft=null;actor='';deals=[];message='Session ended. Pending files removed.';void store.clear();render();};
  const offline=()=>{message=navigator.onLine===false ? 'Offline. Pending files remain on this device. Reconnect to continue.' : 'Reconnected. Press File documents or Check unresolved files to continue.';render();};
  // eslint-disable-next-line no-restricted-syntax -- Reconnect events only update local copy and never issue network requests.
  window.addEventListener('doctorcre-session-invalidated',revoke);window.addEventListener('offline',offline);window.addEventListener('online',offline);
  // eslint-disable-next-line no-restricted-syntax -- A minute clock only expires local bytes and never fetches or retries.
  const expire=setInterval(()=>{if(draft && Date.now()-draft.created_at>=EXPIRY){controller.abort();draft.state='expired';void store.clear();message='Pending files expired. Reselect the original files.';render();}},60_000);
  render();
  try {draft=await store.read();if(draft)draft.state='authenticating';const board=await client.getBoard({signal:controller.signal});if(controller.signal.aborted)return;actor=board.actor;deals=board.deals;
    if(draft){try{bindActor(draft,actor);}catch{await store.clear();draft=null;throw Error('Account changed');}if(draft.selected_deal_id && !deals.some(deal=>deal.id===draft?.selected_deal_id))draft.selected_deal_id=null;await save();}
    message=draft ? 'Choose the deal and review the files before filing.' : 'Choose files to get started.';
  }catch{message='Sign in again or refresh to continue. No files were sent.';}finally{busy=false;render();}
  return {dispose(){disposed=true;controller.abort();clearInterval(expire);window.removeEventListener('doctorcre-session-invalidated',revoke);window.removeEventListener('offline',offline);window.removeEventListener('online',offline);root.unmount();}};
}
const host=typeof document==='undefined' ? null : document.querySelector('[data-share-to-deal]');
if(host)void (async()=>{const sibling=(path:string)=>import(new URL(path,import.meta.url).href);try{const {resolveDealroomBoot}=await sibling('./boot-mode.js');const {createClient}=await sibling('./client.js');const boot=resolveDealroomBoot(location);const view=await mountShareToDeal(host,await createClient(boot.mode,boot.options));window.addEventListener('pagehide',()=>view?.dispose(),{once:true});}catch{host.textContent='Share to deal unavailable. Refresh to try again.';}})();
