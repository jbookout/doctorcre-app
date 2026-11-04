export const DRAFT_DB = 'doctorcre-incoming-deal-share-v1';
export const MAX_BYTES = 25 * 1024 * 1024;
export const EXPIRY = 86_400_000;
export const FILE_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.jpg,.jpeg,.png,.heic,.heif,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,image/jpeg,image/png,image/heic,image/heif';
const mimeByExtension: Record<string,string>={pdf:'application/pdf',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',heic:'image/heic',heif:'image/heif'};
export type Phase = 'incoming' | 'locally_staged' | 'authenticating' | 'choosing_deal' | 'ready' | 'reserving' | 'uploading' | 'committing' | 'filed' | 'cancelled' | 'expired' | 'quota_refused' | 'unknown_outcome';
export type Receipt = { upload_id: string; deal_id: string; sha256: string; state: 'reserved' | 'uploaded' | 'committed' | 'cancelled'; attachment_id?: string };
export type SharedFile = { local_id: string; name: string; mime: string; bytes: number; sha256: string; blob: Blob; reserve_key: string; commit_key: string; cancel_key: string; attempted: boolean; receipt: Receipt | null; confirmed: boolean; error: string | null; retries: number };
export type IncomingDealShare = { version: 1; draft_id: string; created_at: number; actor_binding: string | null; files: SharedFile[]; selected_deal_id: string | null; state: Phase; last_reconcile: number };
export type UploadArgs = { idempotency_key: string; deal_id: string; sha256: string; name: string; mime: string; bytes: number };
export type UploadClient = {
  beginDealDocumentUpload(args: UploadArgs, options: {signal: AbortSignal}): Promise<unknown>;
  readDealDocumentUpload(args: {idempotency_key: string; upload_id: string | null}, options: {signal: AbortSignal}): Promise<unknown>;
  cancelDealDocumentUpload(args: {upload_id: string; idempotency_key: string}, options: {signal: AbortSignal}): Promise<unknown>;
  commitDealDocumentUpload(args: {upload_id: string; idempotency_key: string; deal_id: string}, options: {signal: AbortSignal}): Promise<unknown>;
  uploadDealDocumentBytes(receipt: Receipt, blob: Blob, options: {signal: AbortSignal}): Promise<void>;
  listDealDocuments(args: {deal_id: string; limit?: number; cursor?: string}, options: {signal: AbortSignal}): Promise<unknown>;
};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const uuid = (value: unknown): value is string => typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function isSharedFile(value: unknown): value is SharedFile {
  if(!record(value) || !uuid(value.local_id) || !uuid(value.reserve_key) || !uuid(value.commit_key) || !uuid(value.cancel_key) || typeof value.name!=='string' || typeof value.mime!=='string' || typeof value.bytes!=='number' || !(value.blob instanceof Blob) || value.blob.size!==value.bytes || typeof value.sha256!=='string' || !/^[a-f0-9]{64}$/.test(value.sha256) || typeof value.attempted!=='boolean' || typeof value.confirmed!=='boolean' || (value.error!==null && typeof value.error!=='string') || typeof value.retries!=='number' || !Number.isInteger(value.retries) || value.retries<0 || value.retries>3) return false;
  const receipt=value.receipt;
  return receipt===null || record(receipt) && typeof receipt.upload_id==='string' && typeof receipt.deal_id==='string' && receipt.sha256===value.sha256 && ['reserved','uploaded','committed','cancelled'].includes(String(receipt.state)) && (receipt.state!=='committed' || typeof receipt.attachment_id==='string');
}
function isDraft(value: unknown): value is IncomingDealShare {
  return record(value) && value.version===1 && uuid(value.draft_id) && typeof value.created_at==='number' && Number.isFinite(value.created_at) && (value.actor_binding===null || typeof value.actor_binding==='string' && !!value.actor_binding) && (value.selected_deal_id===null || typeof value.selected_deal_id==='string') && typeof value.last_reconcile==='number' && ['incoming','locally_staged','authenticating','choosing_deal','ready','reserving','uploading','committing','filed','cancelled','expired','quota_refused','unknown_outcome'].includes(String(value.state)) && Array.isArray(value.files) && value.files.length>0 && value.files.length<=3 && value.files.every(isSharedFile) && value.files.reduce((sum,file)=>sum+file.bytes,0)<=MAX_BYTES;
}
export function parseReceipt(value: unknown, file: SharedFile, deal: string): Receipt {
  if (!record(value) || typeof value.upload_id !== 'string' || value.deal_id !== deal || value.sha256 !== file.sha256 || !['reserved','uploaded','committed','cancelled'].includes(String(value.state))) throw Error('Receipt does not match selected deal and bytes');
  if (value.state !== 'reserved' && value.state !== 'uploaded' && value.state !== 'committed' && value.state !== 'cancelled') throw Error('Invalid receipt');
  if (value.state === 'committed' && typeof value.attachment_id !== 'string') throw Error('Attachment receipt missing');
  return {upload_id:value.upload_id, deal_id:deal, sha256:file.sha256,state:value.state,...(typeof value.attachment_id === 'string' ? {attachment_id:value.attachment_id} : {})};
}
export function documentRows(value: unknown): Record<string, unknown>[] {
  if (!record(value) || !Array.isArray(value.documents) || !value.documents.every(record)) throw Error('Documents unavailable');
  return value.documents;
}
export async function stageFiles(files: File[]): Promise<IncomingDealShare> {
  if (!files.length || files.length > 3 || files.reduce((n,f) => n+f.size,0) > MAX_BYTES) throw Error('Choose one to three files, up to 25 MiB total.');
  const staged: SharedFile[] = [];
  // eslint-disable-next-line no-restricted-syntax -- The admission cap bounds this scan to three files and 25 MiB.
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const prefix = new TextDecoder('latin1').decode(bytes.slice(0,32));
    const ext = file.name.split('.').pop()?.toLowerCase();
    const mime=ext ? mimeByExtension[ext] : undefined;
    if(!mime || file.type && file.type!==mime && file.type!=='application/octet-stream')throw Error('File type does not match its extension.');
    const admitted = ext === 'pdf' ? prefix.startsWith('%PDF-') : ['jpg','jpeg'].includes(ext || '') ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : ext === 'png' ? bytes.slice(0,8).join(',') === '137,80,78,71,13,10,26,10' : ['heic','heif'].includes(ext || '') ? prefix.slice(4,8) === 'ftyp' && /heic|heix|hevc|hevx|mif1/.test(prefix.slice(8)) : ['docx','xlsx','pptx'].includes(ext || '') ? prefix.startsWith('PK\u0003\u0004') : ['doc','xls','ppt'].includes(ext || '') && bytes.slice(0,8).join(',') === '208,207,17,224,161,177,26,225';
    if (!admitted || !bytes.length) throw Error('Unsupported or mismatched file bytes. Choose PDF, Office or photo files.');
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n => n.toString(16).padStart(2,'0')).join('');
    staged.push({local_id:crypto.randomUUID(),name:file.name,mime,bytes:file.size,sha256,blob:file,reserve_key:crypto.randomUUID(),commit_key:crypto.randomUUID(),cancel_key:crypto.randomUUID(),attempted:false,receipt:null,confirmed:false,error:null,retries:0});
  }
  return {version:1,draft_id:crypto.randomUUID(),created_at:Date.now(),actor_binding:null,files:staged,selected_deal_id:null,state:'locally_staged',last_reconcile:0};
}
export function bindActor(draft: IncomingDealShare, actor: string) {
  if(!actor)throw Error('A verified actor is required.');
  if (draft.actor_binding && draft.actor_binding !== actor) throw Error('Account changed. Pending files must be removed.');
  draft.actor_binding = actor;
  draft.state=draft.files.some(file=>file.attempted && !file.confirmed) ? 'unknown_outcome' : draft.selected_deal_id ? 'ready' : 'choosing_deal';
  return draft;
}
export function selectDeal(draft: IncomingDealShare, deal: string) {
  if (draft.files.some(file => file.attempted) && draft.selected_deal_id !== deal) throw Error('Cancel existing reservations before changing deals.');
  draft.selected_deal_id = deal; draft.state = 'ready';
}
export function draftStore(database: IDBFactory = indexedDB) {
  async function open() {
    return new Promise<IDBDatabase>((resolve,reject) => { const request = database.open(DRAFT_DB,1); request.onupgradeneeded = () => request.result.createObjectStore('draft'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  }
  async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
    const db = await open();
    return new Promise<T>((resolve,reject) => { const tx = db.transaction('draft',mode); const request = operation(tx.objectStore('draft')); tx.oncomplete = () => {db.close(); resolve(request.result);}; tx.onerror = tx.onabort = () => {db.close(); reject(tx.error || Error('Local storage unavailable'));}; });
  }
  return {
    async read(): Promise<IncomingDealShare | null> {
      const value: unknown = await transaction('readonly',store => store.get('pending'));
      if (!record(value)) return null;
      if (value.version !== 1 || typeof value.created_at !== 'number' || Date.now()-value.created_at >= EXPIRY) {await this.clear(); return null;}
      if (!isDraft(value)) {await this.clear(); return null;}
      return value;
    },
    async save(draft: IncomingDealShare, create = false) {
      const db = await open();
      return new Promise<void>((resolve,reject) => {const tx = db.transaction('draft','readwrite'), store = tx.objectStore('draft');
        const read = store.get('pending'); read.onsuccess = () => {const old = read.result; if (create && old && Date.now()-old.created_at < EXPIRY) {tx.abort(); return;} store.put(draft,'pending');};
        tx.oncomplete = () => {db.close();resolve();}; tx.onabort = tx.onerror = () => {db.close();reject(tx.error || Error('One pending draft already exists. Open or cancel it first.'));};});
    },
    async clear() {await transaction('readwrite',store => store.clear());},
  };
}
export async function changeDeal(draft: IncomingDealShare, deal: string, client: UploadClient, save: () => Promise<void>, signal: AbortSignal) {
  if (deal === draft.selected_deal_id) return;
  // eslint-disable-next-line no-restricted-syntax -- The draft cap limits this scan to three persisted files.
  for (const file of draft.files) {
    if (file.attempted) {
      const receipt = parseReceipt(await client.readDealDocumentUpload({idempotency_key:file.reserve_key,upload_id:file.receipt?.upload_id || null},{signal}),file,draft.selected_deal_id || '');
      if (receipt.state === 'committed') throw Error('A file is already committed. Finish checking this deal before changing deals.');
      const cancelled=parseReceipt(await client.cancelDealDocumentUpload({upload_id:receipt.upload_id,idempotency_key:file.cancel_key},{signal}),file,draft.selected_deal_id || '');
      if(cancelled.state!=='cancelled') throw Error('Cancellation unconfirmed');
    }
  }
  if(signal.aborted) return;
  for (const file of draft.files) {
    file.attempted=false; file.receipt=null; file.reserve_key=crypto.randomUUID();file.commit_key=crypto.randomUUID();file.cancel_key=crypto.randomUUID();file.retries=0;
  }
  selectDeal(draft,deal); await save();
}
const activeDrafts = new WeakSet<IncomingDealShare>();
export async function fileBatch(draft: IncomingDealShare, client: UploadClient, save: () => Promise<void>, signal: AbortSignal) {
  if(activeDrafts.has(draft)) return;
  activeDrafts.add(draft);
  try {await runBatch(draft,client,save,signal);}finally{activeDrafts.delete(draft);}
}
async function runBatch(draft: IncomingDealShare, client: UploadClient, save: () => Promise<void>, signal: AbortSignal) {
  const deal = draft.selected_deal_id;
  if (!deal || !draft.actor_binding || signal.aborted || draft.state === 'filed') return;
  if (Date.now()-draft.created_at >= EXPIRY) {draft.state='expired';await save();return;}
  // eslint-disable-next-line no-restricted-syntax -- The draft cap limits this scan to three persisted files.
  for (const file of draft.files) {
    if (signal.aborted) return;
    if (file.confirmed || file.retries >= 3) continue;
    try {
      file.error=null;
      if (file.attempted) {
        file.receipt=parseReceipt(await client.readDealDocumentUpload({idempotency_key:file.reserve_key,upload_id:file.receipt?.upload_id || null},{signal}),file,deal);
      } else {
        file.attempted=true; draft.state='reserving'; await save();
        file.receipt=parseReceipt(await client.beginDealDocumentUpload({idempotency_key:file.reserve_key,deal_id:deal,name:file.name,mime:file.mime,bytes:file.bytes,sha256:file.sha256},{signal}),file,deal);
      }
      if (signal.aborted) return;
      await save();
      if (file.receipt.state === 'cancelled') throw Error('Reservation cancelled. Reselect the file.');
      if (file.receipt.state === 'reserved') {
        draft.state='uploading';await save();
        await client.uploadDealDocumentBytes(file.receipt,file.blob,{signal});
      }
      if (signal.aborted) return;
      if (file.receipt.state !== 'committed') {
        draft.state='committing';await save();
        file.receipt=parseReceipt(await client.commitDealDocumentUpload({upload_id:file.receipt.upload_id,idempotency_key:file.commit_key,deal_id:deal},{signal}),file,deal);
      }
      if (signal.aborted) return;
      await save();
    } catch (error) {
      if (signal.aborted) return;
      const refused=record(error) && record(error.payload) && typeof error.payload.error==='string' && !['offline','temporarily_unavailable','timeout'].includes(error.payload.error);
      file.retries=refused ? 3 : file.retries+1;
      file.error=file.retries>=3 ? 'Upload attempts stopped. Cancel pending files and reselect after the problem is resolved.' : 'Outcome unconfirmed. Reconnect and check this file before retrying.';
      await save();
    }
  }
  if (signal.aborted) return;
  try {
    const rows: Record<string,unknown>[]=[];
    let cursor: string | null=null;
    const seen=new Set<string>();
    // eslint-disable-next-line no-restricted-syntax -- The page cap permits twenty canonical list pages per explicit batch action.
    for(let page=0;page<20;page++) {
      const result=await client.listDealDocuments({deal_id:deal,limit:100,...(cursor ? {cursor} : {})},{signal});
      if(signal.aborted)return;
      rows.push(...documentRows(result));
      if(draft.files.every(file=>file.receipt?.state!=='committed' || rows.some(row=>(row.attachment_id || row.id)===file.receipt?.attachment_id && row.sha256===file.sha256 && row.deal_id===deal)))break;
      const next=record(result) && typeof result.next_cursor==='string' ? result.next_cursor : null;
      if(!next || seen.has(next))break;
      seen.add(next);cursor=next;
    }
    if (signal.aborted) return;
    for (const file of draft.files) if (file.receipt?.state === 'committed') {
      file.confirmed = rows.some(row => (row.attachment_id || row.id) === file.receipt?.attachment_id && row.sha256 === file.sha256 && row.deal_id === deal);
      if (file.confirmed) file.error=null;
    }
  } catch { /* Retain bytes until canonical list readback succeeds. */ }
  draft.state=draft.files.every(file => file.confirmed) ? 'filed' : 'unknown_outcome';await save();
}
