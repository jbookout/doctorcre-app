import { test as base } from '@e2e-dev/web';
import { randomUUID } from 'node:crypto';
import { seedFixture } from '../qa/support.ts';
import { expect } from 'e2e';

export async function openSearch(app, browser) {
  await app.open('/search?q=Demo');
  await expect(browser.locator('#searchResults [data-group]')).toHaveCount(9);
}

export async function refuseReads(browser, status = 503) {
  const reject = route => route.fulfill({ status, json: { ok: false, error: status === 401 ? 'unauthorized' : 'temporarily_unavailable', code: status === 401 ? 'unauthorized' : 'temporarily_unavailable' } });
  await browser.route('**/api/**', reject);
  await browser.route('**/mcp', reject);
}

export async function paintedText(browser, selector) {
  return browser.evaluate(selector => {
    const node = document.querySelector(selector);
    if (!node) return { found: false, full: false };
    const range = document.createRange(); range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
    let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let p = node; p; p = p.parentElement) {
      const s = getComputedStyle(p), b = p.getBoundingClientRect();
      if (s.display === 'none' || s.visibility === 'hidden') return { found: true, full: false };
      if (['hidden', 'clip', 'scroll', 'auto'].includes(s.overflowX)) { clip.left = Math.max(clip.left, b.left); clip.right = Math.min(clip.right, b.right); }
      if (['hidden', 'clip', 'scroll', 'auto'].includes(s.overflowY)) { clip.top = Math.max(clip.top, b.top); clip.bottom = Math.min(clip.bottom, b.bottom); }
    }
    const full = rects.length > 0 && rects.every(r => r.left >= clip.left - 1 && r.top >= clip.top - 1 && r.right <= clip.right + 1 && r.bottom <= clip.bottom + 1);
    return { found: true, full, text: node.innerText, clip, rects: rects.map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height })) };
  }, selector);
}

export async function textContrast(browser, selector) {
  return browser.evaluate(selector => {
    const node = document.querySelector(selector);
    if (!node) return { found: false, ratio: 0 };
    const rgba = value => { const m = value.match(/[\d.]+/g); return m ? [Number(m[0]), Number(m[1]), Number(m[2]), m[3] === undefined ? 1 : Number(m[3])] : [0, 0, 0, 0]; };
    const chain = []; for (let p = node; p; p = p.parentElement) chain.push(p);
    let bg = [255, 255, 255]; const backgrounds = [];
    for (const p of chain.reverse()) { const s = getComputedStyle(p), c = rgba(s.backgroundColor); backgrounds.push({ tag: p.tagName, id: p.id, color: s.backgroundColor, image: s.backgroundImage }); bg = bg.map((v, i) => c[i] * c[3] + v * (1 - c[3])); }
    const s = getComputedStyle(node), fg = rgba(s.color).slice(0, 3);
    const luminance = color => color.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0);
    const l = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
    return { found: true, text: node.innerText, foreground: s.color, background: bg, backgrounds, ratio: (l[0] + .05) / (l[1] + .05) };
  }, selector);
}

export async function proveVisibleFailure(browser, selector) {
  const painted = await paintedText(browser, selector);
  expect(painted.found, 'the failure feedback exists').toBe(true);
  expect(painted.full, JSON.stringify(painted)).toBe(true);
  expect(painted.rects?.some(r => r.width > 80 && r.height > 10), 'failure feedback occupies a readable rendered area').toBe(true);
}

export function reproTest() {
  base.beforeEach(async ({ app, browser }) => {
    const seeded = await seedFixture(app.baseUrl, `round2-repro-${randomUUID()}`, 'joe', 'realistic');
    await browser.setCookies([seeded.cookie]);
  });
  return base;
}
