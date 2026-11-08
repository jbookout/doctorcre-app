import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const doc = await readFile(new URL('../docs/proofs/lease-radar-watches.md', import.meta.url), 'utf8');
const source = doc.match(/const rpc = [\s\S]*?\nasync function observe/)[0].replace(/\nasync function observe$/, '');
const rpc = vm.runInNewContext(`(unavailable) => { ${source}; return rpc; }`)(message => Object.assign(Error(message), {exitCode:78}));

test('registered read failures are insufficient evidence', async () => {
  for (const result of [{kind:'unavailable'}, {kind:'payload',isError:true}, new Error('transport failed')]) {
    const page = {evaluate: async () => { if (result instanceof Error) throw result; return result; }};
    await assert.rejects(rpc(page, 'read', {}), error => error.exitCode === 78);
  }
});

test('registered read returns a successful payload', async () => {
  const payload = {ok:true};
  assert.equal(await rpc({evaluate: async () => ({kind:'payload', payload})}, 'read', {}), payload);
});
