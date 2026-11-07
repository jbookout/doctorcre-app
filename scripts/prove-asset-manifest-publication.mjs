import { proofArgs } from './proof-browser.mjs';
import { isAppRepository } from '../js/repository-identity.mjs';
import { readAppRelease, proofFetch } from './app-release-reader.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function prove({ origin, commit, timeoutMs }) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.ok(!/^0+$/.test(commit), 'a deployed commit is required');
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const expired = () => Object.assign(Error('Proof deadline exceeded'), { exitCode: 78 });
  const remaining = () => {
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0 || controller.signal.aborted) throw expired();
    return ms;
  };
  const timer = setTimeout(() => controller.abort(expired()), timeoutMs);
  let requests = 0, bytes = 0;
  const get = async path => {
    remaining();
    const url = new URL(path, origin);
    assert.equal(url.origin, origin, 'same-origin evidence only');
    assert.ok(++requests <= 4, 'four-request budget');
    const response = await proofFetch(url, { signal: controller.signal, redirect: 'manual', credentials: 'omit' });
    assert.equal(response.status, 200, `HTTP 200 required for ${path}`);
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 1048576) {
        controller.abort();
        throw Error('evidence exceeds 1 MiB');
      }
      chunks.push(chunk);
    }
    return { response, data: Buffer.concat(chunks) };
  };
  try {
    const release = await readAppRelease(origin, async url => { const { response, data } = await get(url.pathname); return { type: response.headers.get('content-type') || '', body: data }; });
    if (release.source_commit !== commit) {
      try {
        await new Promise((resolve, reject) => {
          let failure;
          const child = execFile('git', ['merge-base', '--is-ancestor', commit, release.source_commit], { timeout: Math.min(remaining(), 5000), signal: controller.signal, killSignal: 'SIGKILL' }, error => { failure = error; });
          child.once('close', () => failure ? reject(failure) : resolve());
        });
      } catch (error) {
        remaining();
        if (error.code === 1) throw Error('release commit mismatch');
        throw Object.assign(Error('Release ancestry evidence unavailable'), { exitCode: 78 });
      }
    }
    const { response, data } = await get('/artifact-manifest.json');
    assert.match(response.headers.get('content-type') || '', /^application\/json(?:;|$)/i);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const manifest = JSON.parse(data);
    assert.equal(manifest.schema, 'doctorcre-static-artifact.v1');
    assert.ok(isAppRepository(manifest.repository), 'manifest repository mismatch');
    assert.equal(manifest.source_commit, release.source_commit, 'manifest commit mismatch');
    assert.ok(Array.isArray(manifest.files) && manifest.files.length <= 10000, 'manifest file inventory required');
    const files = new Map();
    for (const row of manifest.files) {
      assert.ok(row && typeof row.path === 'string' && /^[a-zA-Z0-9_./-]+$/.test(row.path) && !row.path.startsWith('/') && !row.path.split('/').some(part => !part || part === '.' || part === '..'), 'safe manifest path required');
      assert.ok(!files.has(row.path), 'duplicate manifest path');
      assert.match(row.sha256 || '', /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(row.bytes) && row.bytes >= 0, 'valid manifest byte length required');
      files.set(row.path, row);
    }
    const paths = [...files.keys()].filter(path => /^js\/.*\.js$/.test(path)).sort().slice(0, 2);
    assert.equal(paths.length, 2, 'two manifest JavaScript assets required');
    const assets = [];
    for (const path of paths) {
      const { data: payload } = await get('/' + path);
      const row = files.get(path);
      assert.equal(payload.length, row.bytes, `asset length mismatch for ${path}`);
      assert.equal(hash(payload), row.sha256, `asset digest mismatch for ${path}`);
      assets.push({ path, bytes: payload.length, sha256: hash(payload) });
    }
    return { status: 'passed', release, manifest_sha256: hash(data), assets, requests, bytes };
  } finally { clearTimeout(timer); }
}

async function main() {
  try {
    const args = proofArgs(), url = new URL(args[1]), timeoutMs = Number(args[5]);
    assert.ok(args.length === 6 && args[0] === '--origin' && args[2] === '--commit' && args[4] === '--timeout-ms' && url.href === `${url.origin}/` && !url.username && !url.password && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'Use --origin HTTPS_OR_LOOPBACK_ORIGIN --commit DEPLOYED_COMMIT --timeout-ms 1..30000');
    console.log(JSON.stringify(await prove({ origin: url.origin, commit: args[3], timeoutMs })));
  } catch (error) {
    console.log(JSON.stringify({ status: 'failed', error: error.message }));
    process.exitCode = error.exitCode || 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
