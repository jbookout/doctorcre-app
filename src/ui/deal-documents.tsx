import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { documentRows, FILE_ACCEPT, draftStore, stageFiles } from './share-draft-store';
import type { UploadClient } from './share-draft-store';
export function mountDealDocuments(element: Element, {dealId, client}: {dealId: string; client: Pick<UploadClient,'listDealDocuments'>}) {
  const root=createRoot(element), controller=new AbortController();
  let disposed=false, busy=false, rows: Record<string,unknown>[]=[], message='Loading documents…', cursor: string | null=null;
  function render() {
    if (disposed) return;
    flushSync(() => root.render(<section className="deal-documents" aria-label="Deal documents"><h2>Documents</h2>
      <p>On iPhone and Safari, use Upload documents to open Files or Photos. Receiving files from the system share sheet is unsupported.</p>
      <label className="btn">Upload documents<input aria-label="Upload documents" type="file" multiple accept={FILE_ACCEPT} disabled={busy} onChange={event => {const files=Array.from(event.currentTarget.files || []);event.currentTarget.value='';if(files.length) void stage(files);}} /></label>
      <p role="status">{message}</p><ul>{rows.map((row,index) => <li key={String(row.id || index)}>{String(row.display_name || row.name || 'Document')}</li>)}</ul>
      <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>Refresh documents</button>
      {cursor && <button type="button" className="btn" disabled={busy} onClick={() => void refresh(cursor || undefined)}>More documents</button>}
      <a href="/share-to-deal">Open pending files</a>
    </section>));
  }
  async function stage(files: File[]) {
    busy=true;render();
    try {const draft=await stageFiles(files);draft.selected_deal_id=dealId;await draftStore().save(draft,true);if (!disposed) location.assign(`/share-to-deal?draft=${draft.draft_id}`);}
    catch {if (!disposed) message='Files were not staged. Local storage may be full or a pending draft already exists. Open pending files or reselect.';}
    finally {busy=false;render();}
  }
  async function refresh(next?: string) {
    if (busy || disposed) return;busy=true;render();
    try {const value=await client.listDealDocuments({deal_id:dealId,limit:25,...(next ? {cursor:next} : {})},{signal:controller.signal});if(disposed)return;
      const documents=documentRows(value);rows=next ? [...rows,...documents] : documents;
      cursor=value && typeof value==='object' && 'next_cursor' in value && typeof value.next_cursor==='string' ? value.next_cursor : null;
      message=rows.length ? '' : 'No documents filed for this deal.';
    } catch {if(!disposed) message='Documents unavailable. Refresh to try again.';}
    finally {busy=false;render();}
  }
  const revoke=() => {controller.abort();rows=[];message='Session ended.';void draftStore().clear();render();};
  element.ownerDocument.defaultView?.addEventListener('doctorcre-session-invalidated',revoke);
  void refresh();
  return {refresh,dispose(){disposed=true;controller.abort();element.ownerDocument.defaultView?.removeEventListener('doctorcre-session-invalidated',revoke);root.unmount();}};
}
