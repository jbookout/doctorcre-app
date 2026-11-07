import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpath, readFile, mkdir, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The consumer pins the independently owned CARR package, just as the lockfile
// pins registry packages. Validate the installed package before executing it.
export async function verifyLiveProducer(checkout, moduleUrl, producer) {
  assert.equal(producer.repository, 'DoctorCRE/carr-system');
  assert.match(producer.source_commit, /^[0-9a-f]{40}$/);
  const root = await realpath(checkout);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 10000 }).trim();
  assert.equal(await realpath(git(['rev-parse', '--show-toplevel'])), root, 'producer checkout must be the repository root');
  assert.equal(git(['rev-parse', 'HEAD']), producer.source_commit, 'CARR package must match the consumer producer pin');
  git(['diff', '--exit-code', 'HEAD', '--']);
  const entry = 'mcp-server/test/helpers/local-carr.mjs';
  assert.equal(git(['ls-files', '--error-unmatch', entry]), entry, 'producer entry must belong to the pinned repository');
  assert.equal(await realpath(fileURLToPath(moduleUrl)), await realpath(resolve(root, entry)), 'installed CARR package must resolve to the declared producer checkout');
}


export async function linkLiveProducer({ root, checkout, producer }) {
  const target = resolve(checkout, 'mcp-server');
  const entry = pathToFileURL(resolve(target, 'test/helpers/local-carr.mjs')).href;
  await verifyLiveProducer(checkout, entry, producer);
  await mkdir(resolve(root, 'node_modules'), { recursive: true });
  const link = resolve(root, 'node_modules/mcp-server');
  try { await symlink(target, link, 'dir'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  assert.equal(await realpath(link), await realpath(target), 'existing CARR package must belong to this producer');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const checkout = process.env.CARR_PRODUCER_CHECKOUT;
  assert.ok(checkout, 'CARR_PRODUCER_CHECKOUT must name the pinned producer checkout');
  const producer = JSON.parse(await readFile(resolve(root, 'contracts/carr-interface.v1/producer.json'), 'utf8'));
  await linkLiveProducer({ root, checkout, producer });
  console.log('Pinned CARR test package linked');
}
