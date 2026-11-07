import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appAssetSnapshot } from './fixture-app-assets.mjs';
import { createQaDispatcher } from './qa-fixture-dispatch.mjs';
import { startWorkerFixture } from './fixture-http.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));

export async function createQaServer({buildRoot} = {}) {
  const assets = await appAssetSnapshot(buildRoot);
  const seed = JSON.parse(await readFile(resolve(repository,'data/board-seed.json'),'utf8'));
  return {dispatch:createQaDispatcher({seed,assets}),start:({port=0}={}) => startWorkerFixture({assets,qaSeed:seed,port})};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await createQaServer({buildRoot:process.env.QA_BUILD_ROOT || resolve(repository,'dist/site')});
  const server = await fixture.start({port:Number(process.env.PORT || 18997)});
  console.log(`Synthetic DoctorCRE QA server ${server.origin}`);
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => server.close().then(() => process.exit(0)));
}
