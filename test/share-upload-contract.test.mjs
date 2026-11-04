import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createLiveClient} from '../js/live-client.js';
const load=async()=>{const r=await build({entryPoints:['src/ui/share-draft-store.ts'],bundle:true,write:false,format:'esm',platform:'node'});return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].contents).toString('base64')}`);};
async function setup(){
 const model=await load(), draft=model.bindActor(await model.stageFiles([new File(['%PDF-synthetic\n%%EOF'],'a.pdf',{type:'application/pdf'})]),'joe');model.selectDeal(draft,'deal');
 let receipt;const calls=[];
 const client={
 async beginDealDocumentUpload(args){calls.push(['begin',args]);return receipt={upload_id:'upload',deal_id:args.deal_id,sha256:args.sha256,state:'reserved'};},
 async readDealDocumentUpload(args){calls.push(['read',args]);return receipt;},
 async uploadDealDocumentBytes(){return receipt={...receipt,state:'staged'};},
 async commitDealDocumentUpload(args){calls.push(['commit',args]);return receipt={...receipt,state:'filed',attachment_id:'attachment'};},
 async listDealDocuments(){return {documents:[{id:'attachment',content_hash:draft.files[0].sha256}]};}
 };return {...model,draft,client,calls,run:()=>model.fileBatch(draft,client,async()=>{},new AbortController().signal)};
}
test('commit_sends_only_upload_id_and_key_and_never_deal_id',async()=>{const s=await setup();await s.run();assert.deepEqual(s.calls.find(([op])=>op==='commit')?.[1],{upload_id:'upload',idempotency_key:s.draft.files[0].commit_key});});
test('begin_uses_filename_declared_mime_and_stable_action_id',async()=>{const s=await setup();await s.run();assert.deepEqual(s.calls[0][1],{idempotency_key:s.draft.files[0].reserve_key,action_id:s.draft.draft_id,deal_id:'deal',filename:'a.pdf',declared_mime:'application/pdf',bytes:s.draft.files[0].bytes,sha256:s.draft.files[0].sha256});});
test('read_uses_upload_id_only_and_canonical_rows_confirm_filed_receipt',async()=>{const s=await setup();await s.run();await s.run();assert.equal(s.draft.state,'filed');s.draft.state='unknown_outcome';s.draft.files[0].confirmed=false;await s.run();assert.deepEqual(s.calls.find(([op])=>op==='read')?.[1],{upload_id:'upload'});assert.equal(s.draft.state,'filed');});
test('lost_begin_response_replays_begin_with_original_key_instead_of_nullable_read',async()=>{const s=await setup();const begin=s.client.beginDealDocumentUpload;let lost=true;s.client.beginDealDocumentUpload=async args=>{const r=await begin(args);if(lost){lost=false;throw Error('lost');}return r;};await s.run();await s.run();assert.equal(s.calls.filter(([op])=>op==='read').length,0);assert.deepEqual(s.calls[0],s.calls[1]);assert.equal(s.draft.state,'filed');});
test('office_is_refused_and_picker_admits_only_producer_formats',async()=>{const {stageFiles,FILE_ACCEPT}=await load();await assert.rejects(stageFiles([new File(['PK\x03\x04synthetic'],'a.docx')]));assert.doesNotMatch(FILE_ACCEPT,/doc|xls|ppt|msword/);});
for(const state of ['receiving','retryable_unknown','rejected','cancelled','expired'])test(`producer_${state}_has_specific_message_and_never_commits`,async()=>{const s=await setup();s.client.beginDealDocumentUpload=async args=>({upload_id:'upload',deal_id:args.deal_id,sha256:args.sha256,state});await s.run();assert.match(s.draft.files[0].error,/receiv|uncertain|reject|cancel|expir/i);assert.equal(s.calls.filter(([op])=>op==='commit').length,0);});
for(const [method,args,path,verb] of [['uploadDealDocumentBytes',{upload_id:'upload'},'/api/v1/deal-documents/uploads/upload/bytes','POST'],['cancelDealDocumentUpload',{upload_id:'upload',idempotency_key:'key'},'/api/v1/deal-documents/uploads/upload/cancel','POST'],['readDealDocumentUpload',{upload_id:'upload'},'/api/v1/deal-documents/uploads/upload','GET']])test(`${method}_uses_authenticated_P6_http_route`,async()=>{
 const calls=[];const client=createLiveClient({selfActor:'joe',fetchImpl:async(path,init)=>{calls.push([path,init]);return Response.json(path==='/auth/session'?{actor:{slug:'joe'},csrf_token:'synthetic-csrf'}:{ok:true,state:'staged'});}});
 await client[method](args,...(method==='uploadDealDocumentBytes'?[new Blob(['bytes'])]:[]));const call=calls.find(([p])=>p===path);assert.ok(call,JSON.stringify(calls));assert.equal(call[1].method,verb);if(verb==='POST')assert.equal(new Headers(call[1].headers).get('x-carr-csrf'),'synthetic-csrf');if(method==='cancelDealDocumentUpload')assert.equal(new Headers(call[1].headers).get('idempotency-key'),'key');
});

for(const code of ['upload_denied','upload_conflict','upload_expired','upload_size_refused','upload_format_refused','upload_hash_mismatch','upload_rate_limited','upload_storage_full','upload_storage_unavailable'])test(`${code}_renders_specific_partner_copy`,async()=>{const s=await setup();s.client.beginDealDocumentUpload=async()=>{throw Object.assign(Error(code),{payload:{error:code}});};await s.run();assert.ok(s.draft.files[0].error);assert.doesNotMatch(s.draft.files[0].error,/unconfirmed|attempts stopped/);});
test('staged_receipt_resumes_without_resending_bytes',async()=>{const s=await setup();const f=s.draft.files[0];f.receipt={upload_id:'upload',deal_id:'deal',sha256:f.sha256,state:'staged'};s.client.readDealDocumentUpload=async()=>f.receipt;s.client.uploadDealDocumentBytes=async()=>assert.fail('staged bytes must not resend');s.client.commitDealDocumentUpload=async args=>({...f.receipt,state:'filed',attachment_id:'attachment'});await s.run();assert.equal(s.draft.state,'filed');});
test('wrong_hash_in_selected_deal_list_never_confirms',async()=>{const s=await setup();s.client.listDealDocuments=async()=>({documents:[{id:'attachment',content_hash:'wrong'}]});await s.run();assert.equal(s.draft.files[0].confirmed,false);assert.equal(s.draft.state,'unknown_outcome');});
test('live_begin_uses_exact_http_body_and_commit_uses_csrf_mcp',async()=>{
 const calls=[];const client=createLiveClient({selfActor:'joe',fetchImpl:async(path,init)=>{
 calls.push([path,init]);if(path==='/auth/session')return Response.json({actor:{slug:'joe'},csrf_token:'synthetic-csrf'});
 return Response.json(path==='/mcp'?{result:{content:[{type:'text',text:JSON.stringify({ok:true,state:'filed',attachment_id:'a'})}]}}:{ok:true,state:'reserved'});
 }});
 const begin={idempotency_key:'reserve',action_id:'action',deal_id:'deal',filename:'a.pdf',declared_mime:'application/pdf',bytes:5,sha256:'hash'};
 await client.beginDealDocumentUpload(begin);await client.commitDealDocumentUpload({upload_id:'upload',idempotency_key:'commit'});
 assert.deepEqual(JSON.parse(calls.find(([p])=>p==='/api/v1/deal-documents/uploads')[1].body),begin);
 const commit=calls.find(([p])=>p==='/mcp');assert.equal(new Headers(commit[1].headers).get('x-carr-csrf'),'synthetic-csrf');assert.deepEqual(JSON.parse(commit[1].body).params,{name:'commit-deal-document-upload',arguments:{upload_id:'upload',idempotency_key:'commit'}});
});
