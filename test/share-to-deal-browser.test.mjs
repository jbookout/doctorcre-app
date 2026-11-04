import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const load = async () => {
  const result = await build({entryPoints:['src/ui/share-draft-store.ts'],bundle:true,write:false,format:'esm',platform:'node'});
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
};
for (const [name,content,mime] of [['photo.jpg',new Uint8Array([255,216,255,0]),'image/jpeg'],['photo.heic','0000ftypheic0000','image/heic'],['LOI.docx','PK\x03\x04synthetic','application/vnd.openxmlformats-officedocument.wordprocessingml.document']]) test(`admit_${name}`,async()=>{
 const {stageFiles}=await load();const draft=await stageFiles([new File([content],name,{type:mime})]);assert.equal(draft.files[0].name,name);assert.equal(draft.files[0].sha256.length,64);
});
test('spoofed_oversize_and_four_files_are_refused',async()=>{
 const {stageFiles:stage}=await load();await assert.rejects(stage([new File(['%PDF-synthetic'],'spoof.pdf',{type:'image/jpeg'})]));
 const {stageFiles}=await load();await assert.rejects(stageFiles([new File(['bad'],'bad.pdf')]));await assert.rejects(stageFiles([new File([new Uint8Array(25*1024*1024+1)],'large.pdf')]));await assert.rejects(stageFiles(Array.from({length:4},()=>new File(['%PDF-synthetic'],'a.pdf'))));
});
test('account_switch_and_wrong_deal_reservation_are_refused',async()=>{
 const {stageFiles,bindActor,selectDeal,parseReceipt}=await load();const draft=bindActor(await stageFiles([new File(['%PDF-synthetic'],'a.pdf')]),'joe');assert.throws(()=>bindActor(draft,'dell'));selectDeal(draft,'one');draft.files[0].attempted=true;assert.throws(()=>selectDeal(draft,'two'));assert.throws(()=>parseReceipt({upload_id:'upload',deal_id:'two',sha256:draft.files[0].sha256,state:'reserved'},draft.files[0],'one'));
});
test('installed_share_post_preserves_pdf_until_selected_deal_receipt_is_confirmed', async () => {
  const { stageFiles, selectDeal, bindActor, fileBatch } = await load();
  const draft = bindActor(await stageFiles([new File(['%PDF-1.7 synthetic'],'LOI.pdf',{type:'application/pdf'})]),'joe');
  selectDeal(draft,'demo-deal');
  const original = draft.files[0].blob;
  let writes = 0;
  const client = {
    async beginDealDocumentUpload(args) { writes++; return {upload_id:args.idempotency_key,deal_id:args.deal_id,sha256:args.sha256,state:'reserved'}; },
    async readDealDocumentUpload() { throw Error('unused'); },
    async uploadDealDocumentBytes() {},
    async commitDealDocumentUpload(args) { return {attachment_id:'attachment',upload_id:args.upload_id,deal_id:args.deal_id,sha256:draft.files[0].sha256,state:'committed'}; },
    async listDealDocuments() { return {documents:[]}; },
  };
  await fileBatch(draft,client,async () => {},new AbortController().signal);
  assert.equal(draft.state,'unknown_outcome');
  assert.equal(draft.files[0].blob,original);
  client.readDealDocumentUpload = async () => ({...draft.files[0].receipt,state:'committed'});
  client.listDealDocuments = async () => ({documents:[{...draft.files[0].receipt,id:'attachment'}]});
  await fileBatch(draft,client,async () => {},new AbortController().signal);
  assert.equal(draft.state,'filed');
  assert.equal(writes,1);
});

async function setup(count=1) {
 const model=await load();const draft=model.bindActor(await model.stageFiles(Array.from({length:count},(_,i)=>new File(['%PDF-synthetic'],`Demo ${i}.pdf`))),'joe');model.selectDeal(draft,'demo');
 const receipts=new Map(), rows=[], calls={begin:0,read:0,upload:0,commit:0,list:0,cancel:0};
 const client={
  async beginDealDocumentUpload(args){calls.begin++;const receipt={upload_id:args.idempotency_key,deal_id:args.deal_id,sha256:args.sha256,state:'reserved'};receipts.set(receipt.upload_id,receipt);return structuredClone(receipt);},
  async readDealDocumentUpload(args){calls.read++;return structuredClone(receipts.get(args.upload_id || args.idempotency_key));},
  async uploadDealDocumentBytes(receipt){calls.upload++;receipts.get(receipt.upload_id).state='uploaded';},
  async commitDealDocumentUpload(args){calls.commit++;const receipt=receipts.get(args.upload_id);receipt.state='committed';receipt.attachment_id=args.upload_id;rows.push({...receipt,id:receipt.attachment_id});return structuredClone(receipt);},
  async cancelDealDocumentUpload(args){calls.cancel++;const receipt=receipts.get(args.upload_id);receipt.state='cancelled';return structuredClone(receipt);},
  async listDealDocuments(){calls.list++;return {documents:rows};},
 };
 return {...model,draft,client,calls,receipts,rows};
}
test('share_to_selected_deal_roundtrip',async()=>{const s=await setup();await s.fileBatch(s.draft,s.client,async()=>{},new AbortController().signal);assert.equal(s.draft.state,'filed');assert.equal(s.rows[0].deal_id,'demo');});
test('at_most_one_active_file_upload',async()=>{const s=await setup(3);let active=0,max=0;const upload=s.client.uploadDealDocumentBytes;s.client.uploadDealDocumentBytes=async(...args)=>{active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,1));await upload(...args);active--;};await s.fileBatch(s.draft,s.client,async()=>{},new AbortController().signal);assert.equal(max,1);assert.equal(s.draft.files.filter(file=>file.confirmed).length,3);});
test('no_per_document_network_reads',async()=>{const s=await setup(3);await s.fileBatch(s.draft,s.client,async()=>{},new AbortController().signal);assert.equal(s.calls.list,1);});
test('changing_deal_invalidates_old_reservation',async()=>{const s=await setup();const file=s.draft.files[0];const key=file.reserve_key;file.attempted=true;file.receipt=await s.client.beginDealDocumentUpload({idempotency_key:key,deal_id:'demo',sha256:file.sha256});await s.changeDeal(s.draft,'other',s.client,async()=>{},new AbortController().signal);assert.equal(s.calls.cancel,1);assert.equal(file.receipt,null);assert.notEqual(file.reserve_key,key);assert.equal(file.blob.size,file.bytes);assert.equal(s.draft.selected_deal_id,'other');});
test('timeout_reuses_same_keys',async()=>{const s=await setup();const commit=s.client.commitDealDocumentUpload;let lost=true;s.client.commitDealDocumentUpload=async(...args)=>{const receipt=await commit(...args);if(lost){lost=false;throw Error('response lost');}return receipt;};const keys=s.draft.files.map(file=>[file.reserve_key,file.commit_key]);await s.fileBatch(s.draft,s.client,async()=>{},new AbortController().signal);await s.fileBatch(s.draft,s.client,async()=>{},new AbortController().signal);assert.equal(s.draft.state,'filed');assert.equal(s.calls.begin,1);assert.equal(s.calls.commit,1);assert.equal(s.calls.read,1);assert.deepEqual(s.draft.files.map(file=>[file.reserve_key,file.commit_key]),keys);});
test('late_upload_callback_cannot_change_new_draft',async()=>{const s=await setup();const controller=new AbortController();s.client.uploadDealDocumentBytes=async()=>{controller.abort();};await s.fileBatch(s.draft,s.client,async()=>{},controller.signal);assert.equal(s.calls.commit,0);assert.equal(s.calls.list,0);assert.equal(s.draft.files[0].confirmed,false);});
test('failure_budget_exhaustion',async()=>{const s=await setup();s.client.beginDealDocumentUpload=async()=>{throw Error('refused');};s.client.readDealDocumentUpload=async()=>{s.calls.read++;throw Error('unavailable');};for(let i=0;i<6;i++)await s.fileBatch(s.draft,s.client,async()=>{},new AbortController().signal);assert.equal(s.draft.files[0].retries,3);assert.equal(s.calls.read,2);assert.equal(s.draft.state,'unknown_outcome');});
test('duplicate_submission_does_not_reserve_twice',async()=>{const s=await setup();await Promise.all([s.fileBatch(s.draft,s.client,async()=>{},new AbortController().signal),s.fileBatch(s.draft,s.client,async()=>{},new AbortController().signal)]);assert.equal(s.calls.begin,1);assert.equal(s.calls.commit,1);});
test('resumed_draft_keeps_unknown_outcome_and_reconciliation_clock',async()=>{const s=await setup();s.draft.files[0].attempted=true;s.draft.last_reconcile=123;s.bindActor(s.draft,'joe');assert.equal(s.draft.state,'unknown_outcome');assert.equal(s.draft.last_reconcile,123);});
test('one_of_three_failure_keeps_only_unresolved_files_retryable',async()=>{const s=await setup(3);const upload=s.client.uploadDealDocumentBytes;let first=true;s.client.uploadDealDocumentBytes=async(receipt,...rest)=>{if(first){first=false;throw Error('interrupted');}await upload(receipt,...rest);};await s.fileBatch(s.draft,s.client,async()=>{},new AbortController().signal);assert.equal(s.draft.files.filter(file=>file.confirmed).length,2);assert.equal(s.draft.state,'unknown_outcome');await s.fileBatch(s.draft,s.client,async()=>{},new AbortController().signal);assert.equal(s.calls.begin,3);assert.equal(s.calls.commit,3);assert.equal(s.draft.state,'filed');});
