import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { appAssetSnapshot } from './fixture-app-assets.mjs';
import { startWorkerFixture } from './fixture-http.mjs';

const repository = await realpath(fileURLToPath(new URL('../',import.meta.url)));
const selected = process.env.DOCTORCRE_FIXTURE_ROOT && await realpath(process.env.DOCTORCRE_FIXTURE_ROOT);
const assets = await appAssetSnapshot(selected && selected !== repository ? selected : undefined);
const server = await startWorkerFixture({routes:assets,demo:true,port:Number(process.env.PORT || 8787),
  env:{APP_ENV:'fixture',GIT_SHA:'0'.repeat(40),CARR:{fetch:async () => new Response(null)}}});
console.log(`DoctorCRE fixture server: ${server.origin}`);
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,() => server.close().then(() => process.exit(0)));
