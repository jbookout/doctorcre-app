import { draftStore, stageFiles, MAX_BYTES } from './share-draft-store';
declare const self: {location: Location; addEventListener(type: string, listener: (event: {request: Request; respondWith(response: Promise<Response>): void; data?: {type?: string; preserveUnboundShare?: boolean}; waitUntil(promise: Promise<unknown>): void}) => void): void};
self.addEventListener('message', event => {if (event.data?.type === 'doctorcre-session-revoked') event.waitUntil((async () => {const store=draftStore();const draft=await store.read();if(!event.data?.preserveUnboundShare || draft?.actor_binding)await store.clear();})());});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname !== '/share-to-deal' || event.request.method !== 'POST') return;
  event.respondWith((async () => {
    try {
      if (Number(event.request.headers.get('content-length')) > MAX_BYTES + 65536) throw Error('Too large');
      const reader = event.request.body?.getReader();
      if (!reader) throw Error('No files received');
      const chunks: Uint8Array<ArrayBuffer>[] = []; let total=0;
      // eslint-disable-next-line no-restricted-syntax -- The body reader cancels as soon as the multipart byte cap is reached.
      for (;;) { const chunk=await reader.read(); if (chunk.done) break; total+=chunk.value.byteLength; if (total > MAX_BYTES+65536) {await reader.cancel();throw Error('Too large');} chunks.push(new Uint8Array(chunk.value)); }
      const form = await new Response(new Blob(chunks),{headers:{'content-type':event.request.headers.get('content-type') || ''}}).formData();
      const files = form.getAll('files').filter((file): file is File => file instanceof File);
      const draft = await stageFiles(files);
      await draftStore().save(draft,true);
      return new Response(null,{status:303,headers:{location:`/share-to-deal?draft=${draft.draft_id}`,'cache-control':'no-store'}});
    } catch {
      return new Response('<!doctype html><title>Files need attention</title><h1>Files were not staged</h1><p>Choose up to three PDF, Office or photo files, up to 25 MiB. Local storage may be full, or a pending draft needs attention. The source files remain in the sending app.</p><a href="/share-to-deal">Open pending draft or reselect files</a>',{status:422,headers:{'content-type':'text/html','cache-control':'no-store'}});
    }
  })());
});
