import { startHomeProfile } from './home-lcp-profile.mjs';
import { profile, applyPhoneProfile } from '../../scripts/performance-scenarios.mjs';

export const batchOrder = Object.freeze(['head', 'main', 'head', 'main']);

export function validateSample(sample) {
  if (sample.failures.length) throw Error(sample.failures.join('; '));
  const last = sample.lcp.at(-1);
  if (!last || !Number.isFinite(last.startTime) || last.startTime <= 0 || !(last.size > 0) || !last.element) throw Error('missing LCP evidence');
  return sample;
}

function observeHome() {
  const evidence = window.__homeLcpDiagnostic = { lcp: [], paints: [], longTasks: [], geometry: [], shellAttachedMs: null, fontsReadyMs: null };
  const element = node => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { tag: node.tagName, id: node.id, className: node.className, text: node.textContent.slice(0, 120),
      x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) evidence.lcp.push({ startTime: entry.startTime, renderTime: entry.renderTime,
      loadTime: entry.loadTime, size: entry.size, url: entry.url, element: element(entry.element) });
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  for (const [type, key] of [['paint', 'paints'], ['longtask', 'longTasks']]) {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) evidence[key].push(entry.toJSON());
    }).observe({ type, buffered: true });
  }
  let previous;
  const geometry = () => {
    const main = document.querySelector('main');
    const heading = main?.querySelector('h1');
    const attached = document.body?.classList.contains('has-app-layout');
    if (attached && evidence.shellAttachedMs === null) evidence.shellAttachedMs = performance.now();
    const snapshot = { heading: element(heading), parent: main?.parentElement?.id ?? null, attached };
    const key = JSON.stringify(snapshot);
    if (key !== previous) {
      evidence.geometry.push({ at: performance.now(), ...snapshot });
      previous = key;
    }
  };
  new MutationObserver(geometry).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  document.addEventListener('DOMContentLoaded', () => {
    geometry();
    document.fonts.ready.then(() => {
      evidence.fontsReadyMs = performance.now();
      evidence.fonts = [...document.fonts].map(font => ({ family: font.family, status: font.status, weight: font.weight }));
      geometry();
    });
  }, { once: true });
}

export async function collectHomeSample({ browser, url, setup = async () => {}, trace, profileOutput, timeoutMs = 30000 }) {
  const context = await browser.newContext({ viewport: profile.viewport, deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  let stopProfile;
  try {
    if (trace) await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    const failures = [];
    page.on('requestfailed', request => failures.push(`request failed: ${request.url()} ${request.failure()?.errorText}`));
    page.on('response', response => { if (response.status() >= 400) failures.push(`HTTP ${response.status()}: ${response.url()}`); });
    page.on('pageerror', error => failures.push(error.message));
    await applyPhoneProfile(context, page);
    await page.addInitScript(observeHome);
    if (profileOutput) stopProfile = await startHomeProfile(context, page, profileOutput);
    await setup(page);
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.locator('[data-inbox-row]').first().waitFor({ state: 'visible' });
    await page.waitForFunction(() => window.__homeLcpDiagnostic.lcp.length > 0);
    const sample = await page.evaluate(() => ({ ...window.__homeLcpDiagnostic,
      resources: performance.getEntriesByType('resource').map(entry => entry.toJSON()),
      navigation: performance.getEntriesByType('navigation').map(entry => entry.toJSON()), usefulReadyMs: performance.now() }));
    return validateSample({ ...sample, failures });
  } finally {
    try {
      try { if (stopProfile) await stopProfile(); }
      finally { if (trace) await context.tracing.stop({ path: trace }); }
    } finally { await context.close(); }
  }
}
