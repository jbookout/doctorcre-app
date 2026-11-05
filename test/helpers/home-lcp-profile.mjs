import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Profiling runs separately from the fixed comparison samples.
export async function startHomeProfile(context, page, output) {
  await mkdir(output, { recursive: true });
  const session = await context.newCDPSession(page);
  const timeline = [];
  session.on('Tracing.dataCollected', event => timeline.push(...event.value));
  await session.send('Profiler.enable');
  await session.send('Profiler.setSamplingInterval', { interval: 1000 });
  await session.send('Profiler.start');
  await session.send('Tracing.start', { categories: 'devtools.timeline,blink.user_timing,v8,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
  await page.addInitScript(() => {
    window.__homeRowCommits = [];
    window.__homeRowMarks = [];
    const mark = name => {
      window.__homeRowMarks.push({ name, startTime: performance.now() });
      console.timeStamp(name);
    };
    for (const name of ['appendChild', 'insertBefore']) {
      const original = Node.prototype[name];
      Node.prototype[name] = function (node, ...args) {
        const row = this.isConnected && node.nodeType === 1 && (node.matches('[data-inbox-row]') ? node : node.querySelector('[data-inbox-row]'));
        if (!row) return original.call(this, node, ...args);
        const index = window.__homeRowCommits.length;
        const start = performance.now();
        mark(`home-row-commit-${index}-start`);
        const result = original.call(this, node, ...args);
        const end = performance.now();
        mark(`home-row-commit-${index}-end`);
        window.__homeRowCommits.push({ start, end, text: row.querySelector('h3')?.textContent, connected: row.isConnected });
        requestAnimationFrame(() => mark(`home-row-commit-${index}-frame`));
        return result;
      };
    }
  });
  return async () => {
    try {
      const { profile } = await session.send('Profiler.stop');
      const complete = new Promise(resolve => session.once('Tracing.tracingComplete', resolve));
      await session.send('Tracing.end');
      await complete;
      const clock = await session.send('Performance.getMetrics').catch(() => ({ metrics: [] }));
      const marks = await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, now: performance.now(),
        commits: window.__homeRowCommits, marks: window.__homeRowMarks }));
      await writeFile(join(output, 'cpu.cpuprofile'), JSON.stringify(profile));
      await writeFile(join(output, 'timeline.json'), JSON.stringify({ traceEvents: timeline }));
      await writeFile(join(output, 'row-commits.json'), JSON.stringify({ ...marks, clock }, null, 2));
    } finally { await session.detach(); }
  };
}
