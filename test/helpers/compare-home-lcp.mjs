import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { cpus, loadavg } from 'node:os';
import { CHROMIUM_SAFETY_ARGS } from '../../scripts/chromium-safety-args.mjs';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { profile } from '../../scripts/performance-scenarios.mjs';
import { batchOrder, collectHomeSample } from './home-lcp-diagnostic.mjs';

const [headRoot, mainRoot, outputPath] = process.argv.slice(2);
if (!headRoot || !mainRoot || !outputPath) throw Error('usage: compare-home-lcp.mjs HEAD_CHECKOUT MAIN_CHECKOUT OUTPUT');
const output = resolve(outputPath);
await mkdir(output, { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sides = {};
const report = { schema: 'doctorcre-home-lcp-diagnostic.v1', measuredAt: new Date().toISOString(),
  platform: process.platform, nodeVersion: process.version, cpu: cpus()[0]?.model, cores: cpus().length,
  loadBefore: loadavg(), profile: { ...profile, samples: 5 }, batchOrder, sides, failures: [] };
let browser;
try {
  for (const [label, directory] of Object.entries({ head: headRoot, main: mainRoot })) {
    const root = resolve(directory);
    const manifest = JSON.parse(await readFile(join(root, 'dist/doctorcre-app.manifest.json')));
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    if (manifest.source_commit !== sourceCommit) throw Error(`${label} source mismatch`);
    const buildDigest = sha256(await readFile(join(root, 'dist/doctorcre-app.tar')));
    if ((await readFile(join(root, 'dist/doctorcre-app.tar.sha256'), 'utf8')).trim() !== `${buildDigest}  doctorcre-app.tar`) throw Error(`${label} archive mismatch`);
    for (const file of manifest.files) {
      if (sha256(await readFile(join(root, 'dist/site', file.path))) !== file.sha256) throw Error(`${label} file mismatch: ${file.path}`);
    }
    sides[label] = { sourceCommit, buildDigest, samples: [] };
  }
  browser = await chromium.launch({ args: CHROMIUM_SAFETY_ARGS });
  report.browserVersion = browser.version();
  for (const [batch, label] of batchOrder.entries()) {
    const directory = resolve(label === 'head' ? headRoot : mainRoot);
    const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: join(directory, 'dist/site') } });
    try {
      for (let index = 0; index < 5; index++) {
        const trace = `${label}-${batch + 1}-${index + 1}.zip`;
        const sample = await collectHomeSample({ browser, url: server.url, trace: join(output, trace) });
        sides[label].samples.push({ batch: batch + 1, trace, ...sample });
        console.log(`${label} sample ${sides[label].samples.length}: ${sample.lcp.at(-1).startTime}ms`);
      }
    } finally { await server.stop(); }
  }
  for (const side of Object.values(sides)) {
    const values = side.samples.map(sample => sample.lcp.at(-1).startTime).sort((a, b) => a - b);
    side.distribution = { count: values.length, medianMs: (values[4] + values[5]) / 2, minMs: values[0], maxMs: values.at(-1), valuesMs: values };
  }
} catch (error) {
  report.failures.push(error.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  report.loadAfter = loadavg();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
if (report.failures.length) throw Error(report.failures.join('; '));
