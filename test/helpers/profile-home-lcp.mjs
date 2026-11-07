import { transform } from 'esbuild';
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { CHROMIUM_SAFETY_ARGS } from '../../scripts/chromium-safety-args.mjs';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { collectHomeSample } from './home-lcp-diagnostic.mjs';

const [directory, outputPath] = process.argv.slice(2);
if (!directory || !outputPath) throw Error('usage: profile-home-lcp.mjs CHECKOUT OUTPUT');
const root = resolve(directory), output = resolve(outputPath);
await mkdir(join(output, 'maps'), { recursive: true });
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const manifest = JSON.parse(await readFile(join(root, 'dist/doctorcre-app.manifest.json')));
if (manifest.source_commit !== sourceCommit) throw Error('profile source mismatch');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const buildDigest = sha256(await readFile(join(root, 'dist/doctorcre-app.tar')));
// Rebuild only sidecar maps. Refuse unless every emitted JS byte matches the immutable artifact.
const builder = (await readFile(join(root, 'scripts/ui-bundle.mjs'), 'utf8'))
  .replace('from "esbuild"', `from ${JSON.stringify(import.meta.resolve('esbuild'))}`)
  .replace('const INSTALL = fileURLToPath(new URL("../", import.meta.url));', `const INSTALL = ${JSON.stringify(root + '/')};`)
  .replace('write: false,', 'write: false, sourcemap: "external",');
const loadBuilder = source => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const { uiAssets } = await loadBuilder(builder);
const assets = await uiAssets(path => readFile(join(root, path)));
const plain = await (await loadBuilder(builder.replace('sourcemap: "external",', ''))).uiAssets(path => readFile(join(root, path)));
const normalize = bytes => bytes.toString().replace(/ui-shared-[A-Z0-9]+\.generated/g, 'ui-shared-XXXXXXXX.generated');
const names = new Map();
for (const [path, bytes] of assets) {
  if (path.endsWith('.map')) continue;
  const matches = [...plain].filter(([, value]) => normalize(value) === normalize(bytes));
  if (matches.length !== 1) throw Error(`map rebuild has no unique byte-equivalent asset: ${path}`);
  names.set(path, matches[0][0]);
}
const maps = [];
for (const [path, bytes] of assets) {
  if (path.endsWith('.map')) continue;
  let code = bytes.toString();
  for (const [mapped, original] of names) code = code.replaceAll(mapped.split('/').at(-1), original.split('/').at(-1));
  const map = assets.get(path + '.map');
  const result = await transform(code + '\n//# sourceMappingURL=data:application/json;base64,' + map.toString('base64'), {
    target: 'es2022', legalComments: 'none', minify: true, charset: 'utf8', sourcemap: 'external',
  });
  const original = names.get(path);
  if (result.code !== (await readFile(join(root, 'dist/site', original), 'utf8'))) throw Error(`source map rebuild differs: ${original}`);
  const filename = original.split('/').at(-1) + '.map';
  await writeFile(join(output, 'maps', filename), result.map);
  maps.push({ path: original, sha256: sha256(result.map), emittedSha256: sha256(result.code) });
}
let browser, server;
try {
  browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: join(root, 'dist/site') } });
  const sample = await collectHomeSample({ browser, url: server.url, trace: join(output, 'profile.zip'), profileOutput: output });
  await writeFile(join(output, 'report.json'), JSON.stringify({ diagnosticOnly: true, sourceCommit, buildDigest,
    browserVersion: browser.version(), maps, sample }, null, 2));
} finally {
  try { await browser?.close(); } finally { await server?.stop(); }
}
