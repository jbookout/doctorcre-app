import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {handleDoctorcreRequest} from '../src/worker.js';
import {routeContract} from '../js/routes.js';
test('upload_contract_is_pinned_to_P6_producer',async()=>{
 const pin=JSON.parse(await readFile('contracts/carr-interface.v1/deal_document_upload.json','utf8'));
 assert.equal(pin.schema_version,'deal-document-upload.v1');assert.equal(pin.producer_revision,'7d3d1407678fef98eab3fe8ac7ea513f3d5b9779');
 assert.deepEqual(pin.reservation.required,['idempotency_key','action_id','deal_id','filename','declared_mime','bytes','sha256']);
 assert.deepEqual(Object.keys(pin.filing.input),['upload_id','idempotency_key']);
});
test('missing_controller_receiver_never_reads_multipart', async () => {
 const request=new Request('https://app.example/share-to-deal',{method:'POST',body:'synthetic multipart'});
 request.formData=()=>{throw Error('must never parse');};
 const response=await handleDoctorcreRequest(request,{});
 assert.equal(response.status,409);assert.match(await response.text(),/Files were not received/);
});
test('share_route_keeps_auth_return_to_with_opaque_draft',async()=>{
 const response=await handleDoctorcreRequest(new Request('https://app.example/share-to-deal?draft=opaque'),{CARR:{fetch:async()=>Response.redirect('https://app.example/auth/login',302)}});
 assert.equal(new URL(response.headers.get('location')).searchParams.get('return_to'),'/share-to-deal?draft=opaque');
 assert.equal(routeContract.routes['/share-to-deal'],'share-to-deal.html');
});
test('both_manifests_admit_only_pdf_photos_on_distinct_POST_target',async()=>{
 for(const name of ['manifest.webmanifest','public-shell/manifest.webmanifest']) {
  const value=JSON.parse(await readFile(name,'utf8'));assert.equal(value.share_target.action,'/share-to-deal');assert.equal(value.share_target.method,'POST');assert.equal(value.share_target.enctype,'multipart/form-data');
  assert.ok(!value.share_target.params.files[0].accept.includes('.docx'));
  for(const ext of ['.pdf','.jpg','.heic'])assert.ok(value.share_target.params.files[0].accept.includes(ext));
 }
});
