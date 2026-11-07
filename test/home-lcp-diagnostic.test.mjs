import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { CHROMIUM_SAFETY_ARGS } from '../scripts/chromium-safety-args.mjs';
import { collectHomeSample, validateSample, batchOrder } from './helpers/home-lcp-diagnostic.mjs';

test('comparison alternates five-sample batches with ten cold samples per side', () => {
  assert.deepEqual(batchOrder, ['head', 'main', 'head', 'main']);
});
test('absent LCP cannot pass', () => {
  assert.throws(() => validateSample({ lcp: [], failures: [] }), /missing LCP/);
});
test('failed requests cannot pass with a valid paint', () => {
  assert.throws(() => validateSample({ lcp: [{ startTime: 1, size: 10, element: { tag: 'H1' } }], failures: ['HTTP 503'] }), /HTTP 503/);
});
test('browser retains element, geometry, shell, font, paint and long-task evidence', async () => {
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    const sample = await collectHomeSample({ browser, url: 'http://127.0.0.1:12345/', setup: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><body><main><h1>Welcome home.</h1><div data-inbox-row>Task</div></main><script>
        setTimeout(() => { const slot = document.createElement('div'); slot.id = 'appMainSlot'; document.body.append(slot); slot.append(document.querySelector('main')); document.body.classList.add('has-app-layout'); const end = performance.now() + 70; while (performance.now() < end) {} }, 50);
      </script>` }));
    } });
    assert.equal(sample.lcp.at(-1).element.tag, 'H1');
    assert.equal(sample.lcp.at(-1).element.text, 'Welcome home.');
    assert.ok(sample.lcp.at(-1).size > 0);
    assert.ok(sample.geometry.some(entry => entry.parent === 'appMainSlot'));
    assert.ok(sample.shellAttachedMs > 0);
    assert.ok(sample.fontsReadyMs > 0);
    assert.ok(sample.paints.some(entry => entry.name === 'first-contentful-paint'));
    assert.ok(sample.longTasks.some(entry => entry.duration >= 50));
    assert.equal(sample.failures.length, 0);
  } finally { await browser.close(); }
});
test('browser abort and HTTP failure refuse a diagnostic sample', async () => {
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    for (const failure of ['abort', 'http']) {
      await assert.rejects(collectHomeSample({ browser, url: 'http://127.0.0.1:12345/', setup: async page => {
        await page.route('**/*', route => route.request().url().endsWith('/broken.js')
          ? failure === 'abort' ? route.abort('failed') : route.fulfill({ status: 503, body: '' })
          : route.fulfill({ contentType: 'text/html', body: '<h1>Welcome home.</h1><div data-inbox-row>Task</div><script src="/broken.js"></script>' }));
      } }), /request failed|HTTP 503/);
    }
  } finally { await browser.close(); }
});
test('browser without LCP refuses and closes its context', async () => {
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    await assert.rejects(collectHomeSample({ browser, url: 'http://127.0.0.1:12345/', timeoutMs: 500,
      setup: page => page.route('**/*', route => route.fulfill({ contentType: 'text/html',
        body: '<div data-inbox-row style="width:100px;height:20px;background:red"></div>' })) }), /Timeout/);
    assert.equal(browser.contexts().length, 0);
  } finally { await browser.close(); }
});
test('trace write failure refuses and still closes the sample context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'home-lcp-trace-'));
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    for (const script of ['', '<script>throw Error("page failure")</script>']) {
    await assert.rejects(collectHomeSample({ browser, trace: directory, url: 'http://127.0.0.1:12345/',
      setup: page => page.route('**/*', route => route.fulfill({ contentType: 'text/html',
        body: '<h1>Welcome home.</h1><div data-inbox-row>Task</div>' + script })) }), /EISDIR|directory|illegal operation/i);
    assert.equal(browser.contexts().length, 0);
    }
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('separate profiling capture retains CPU, timeline and connected row commit marks', async () => {
  const { readFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'home-lcp-profile-'));
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    const sample = await collectHomeSample({ browser, profileOutput: directory, url: 'http://127.0.0.1:12345/',
      setup: page => page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><body><script>
        const row = document.createElement('article'); row.setAttribute('data-inbox-row', 'task');
        row.innerHTML = '<h3>Review the practice tour follow-up</h3>'; document.body.appendChild(row);
      </script>` })) });
    assert.equal(sample.lcp.at(-1).element.tag, 'H3');
    const cpu = JSON.parse(await readFile(join(directory, 'cpu.cpuprofile')));
    const timeline = JSON.parse(await readFile(join(directory, 'timeline.json')));
    const rows = JSON.parse(await readFile(join(directory, 'row-commits.json')));
    assert.ok(cpu.samples.length > 0);
    assert.ok(timeline.traceEvents.some(event => event.name === 'TimeStamp' && event.args?.data?.message === 'home-row-commit-0-end'));
    assert.equal(rows.commits[0].text, 'Review the practice tour follow-up');
    assert.equal(rows.commits[0].connected, true);
    assert.ok(rows.commits[0].end >= rows.commits[0].start);
    assert.ok(rows.marks.some(mark => mark.name === 'home-row-commit-0-frame'));
    assert.equal(browser.contexts().length, 0);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});
test('a row committed after network idle contributes its painted LCP candidate', async () => {
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  try {
    const sample = await collectHomeSample({ browser, url: 'http://127.0.0.1:12345/', setup: async page => {
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<h1>Welcome</h1>' }));
      page.once('load', async () => {
        await page.waitForLoadState('networkidle');
        await page.evaluate(() => {
          const row = document.createElement('article');
          row.setAttribute('data-inbox-row', 'task');
          row.innerHTML = '<h3 style="font-size:40px">Review the practice tour follow-up</h3>';
          document.body.appendChild(row);
        });
      });
    } });
    assert.equal(sample.lcp.at(-1).element.tag, 'H3');
    assert.equal(browser.contexts().length, 0);
  } finally { await browser.close(); }
});
