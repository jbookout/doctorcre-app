import { chromium } from 'playwright';
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { CHROMIUM_SAFETY_ARGS } from '../../scripts/chromium-safety-args.mjs';
import { collectHomeSample } from './home-lcp-diagnostic.mjs';

const [directory, outputPath] = process.argv.slice(2);
const output = resolve(outputPath);
await mkdir(output, { recursive: true });
const server = await startFixtureServer({ env: { DOCTORCRE_FIXTURE_ROOT: join(resolve(directory), 'dist/site') } });
const browser = await chromium.launch({ args: CHROMIUM_SAFETY_ARGS });
const samples = [];
const jsRoot = join(resolve(directory), 'dist/site/js');
const shared = await Promise.all((await readdir(jsRoot)).filter(name => name.startsWith('ui-shared-')).map(async name => ({ name, size: (await stat(join(jsRoot, name))).size })));
const runtime = shared.sort((a, b) => b.size - a.size)[0].name;
try {
  for (const probe of ['control', 'inbox', 'react', 'font']) {
    for (let index = 0; index < 3; index++) {
      let counters;
      const sample = await collectHomeSample({ browser, url: server.url,
        trace: join(output, `${probe}-${index}.zip`),
        setup: async page => {
          await page.addInitScript(() => {
            const calls = window.__formatterCalls = [];
            Intl.DateTimeFormat = new Proxy(Intl.DateTimeFormat, {
              construct(target, args) {
                const start = performance.now();
                const result = Reflect.construct(target, args);
                calls.push({ start, duration: performance.now() - start, options: args[1] });
                return result;
              },
            });
          });
          if (probe !== 'control') await page.route(probe === 'font' ? '**/*.woff2' : probe === 'inbox' ? '**/ui-inbox.js' : `**/${runtime}`, async route => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            await route.continue();
          });
          await page.exposeFunction('__formatters', value => { counters = value; });
          await page.addInitScript(() => {
            new PerformanceObserver(() => window.__formatters(window.__formatterCalls)).observe({ type: 'largest-contentful-paint', buffered: true });
          });
        } });
      samples.push({ probe, index, formatterCalls: counters, ...sample });
      await writeFile(join(output, 'attribution.json'), JSON.stringify(samples, null, 2));
      console.log(`${probe} ${index}: ${sample.lcp.at(-1).startTime}`);
    }
  }
} finally { await browser.close(); await server.stop(); }
