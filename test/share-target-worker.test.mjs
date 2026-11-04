import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {handleDoctorcreRequest} from '../src/worker.js';
import {routeContract} from '../js/routes.js';
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
test('both_manifests_admit_pdf_office_photos_on_distinct_POST_target',async()=>{
 for(const name of ['manifest.webmanifest','public-shell/manifest.webmanifest']) {
  const value=JSON.parse(await readFile(name,'utf8'));assert.equal(value.share_target.action,'/share-to-deal');assert.equal(value.share_target.method,'POST');assert.equal(value.share_target.enctype,'multipart/form-data');
  for(const ext of ['.pdf','.docx','.jpg','.heic'])assert.ok(value.share_target.params.files[0].accept.includes(ext));
 }
});
