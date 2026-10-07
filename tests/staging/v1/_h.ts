// Shared helpers for the V1 re-check tests (tests/staging/v1 and tests/staging/bugbash).
// Not a test file: the config glob only selects *.e2e.ts.

/** Minimal MCP stub: answer chosen verbs on POST /mcp, let every other verb through to staging. */
export type VerbStub = { payload: unknown } | { status: number; error?: string } | { abort: true };

export async function stubVerbs(browser: any, stubs: Record<string, VerbStub>) {
  await browser.route('**/mcp', async (route: any) => {
    let name = '';
    let id: unknown = 1;
    try {
      const body = JSON.parse(route.request.postData ?? '{}');
      name = body?.params?.name ?? '';
      id = body?.id ?? 1;
    } catch { /* not JSON-RPC: pass through */ }
    const stub = stubs[name];
    if (!stub) return route.continue();
    if ('abort' in stub) return route.abort();
    if ('status' in stub) return route.fulfill({ status: stub.status, json: { error: stub.error ?? 'carr_unavailable' } });
    return route.fulfill({ status: 200, json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(stub.payload) }] } } as any });
  });
}

/** A `find` answer in the exact-key shape js/search-model.js validates (leads 2, clients 1, vendors 1, orgs 2, deals 2). */
export const searchPayload = () => ({
  parties: [
    { name: 'QA Mock Lead One', city: null, specialty: null, org_name: null, ref: 'L-901', kind: 'lead', merged: false },
    { name: 'QA Mock Lead Two', city: null, specialty: null, org_name: null, ref: 'L-902', kind: 'lead', merged: false },
    { name: 'QA Mock Client', city: null, specialty: null, org_name: null, ref: 'C-901', kind: 'client', merged: false },
    { name: 'QA Mock Vendor', city: null, specialty: null, org_name: null, ref: 'V-901', kind: 'vendor', merged: false },
  ],
  deals: [
    { name: 'QA Mock Deal One', phase: 'pending', owner: 'joe', client_ref: 'C-901' },
    { name: 'QA Mock Deal Two', phase: 'research', owner: 'joe', client_ref: 'C-901' },
  ],
  connections: [],
  organizations: [
    { name: 'QA Mock Org One', live_rows: 1, retired_aliases: 0, live_as_role: 0, refs: ['O-901'], role_refs: [], retired_refs: [], retired_refs_truncated: false, all_retired: false },
    { name: 'QA Mock Org Two', live_rows: 1, retired_aliases: 0, live_as_role: 0, refs: ['O-902'], role_refs: [], retired_refs: [], retired_refs_truncated: false, all_retired: false },
  ],
  lead_client_links: [],
  deals_via_link: [],
  note: 'No retired aliases among these matches — every ref listed is live.',
});

/**
 * In-page WCAG contrast probe. Source string (not a closure) so the transpiler cannot inject helpers.
 * arg: { text: string, exact?: boolean, selector?: string }. For every element that directly owns text matching `text`
 * it returns the WORST contrast ratio between the text colour and every plausible effective background
 * (opaque colours, translucent layers composited, gradient stops each tried).
 */
export const CONTRAST_SRC = `(arg) => {
  const cv = document.createElement('canvas').getContext('2d');
  const parse = (c) => { cv.fillStyle = '#000'; cv.fillStyle = c; const v = cv.fillStyle;
    if (v[0] === '#') { const n = parseInt(v.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; }
    const m = v.match(/[\\d.]+/g).map(Number); return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1]; };
  const blend = (top, base) => { const a = top[3]; return [top[0] * a + base[0] * (1 - a), top[1] * a + base[1] * (1 - a), top[2] * a + base[2] * (1 - a), 1]; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const owners = [...document.querySelectorAll(arg.selector || 'body *')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && (arg.exact === false ? n.textContent.toLowerCase().includes(arg.text.toLowerCase()) : n.textContent.trim() === arg.text)));
  return owners.map((el) => {
    const layers = []; let node = el;
    while (node && node.nodeType === 1) {
      const cs = getComputedStyle(node); const bg = parse(cs.backgroundColor); const img = cs.backgroundImage;
      if (img && img !== 'none') { const stops = (img.match(/rgba?\\([^)]*\\)|#[0-9a-fA-F]{3,8}|hsla?\\([^)]*\\)/g) || []).map(parse); if (stops.length) layers.push({ stops }); }
      if (bg[3] > 0) layers.push({ c: bg });
      if (bg[3] === 1 && !(img && img !== 'none')) break;
      node = node.parentElement;
    }
    let cands = [[255, 255, 255, 1]];
    for (const layer of layers.reverse()) {
      if (layer.c) cands = cands.map((b) => blend(layer.c, b));
      else cands = cands.flatMap((b) => layer.stops.map((s) => blend(s, b))).slice(0, 64);
    }
    const fgRaw = parse(getComputedStyle(el).color);
    const worst = Math.min(...cands.map((b) => ratio(blend(fgRaw, b), b)));
    const r = el.getBoundingClientRect();
    return { text: (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 60), ratio: Math.round(worst * 100) / 100, fg: getComputedStyle(el).color, visible: r.width > 0 && r.height > 0 };
  }).filter((o) => o.visible);
}`;

/** True when some element owning `text` is painted with a real box (not an sr-only 1px/clipped node). */
export const PAINTED_SRC = `(arg) => {
  const owners = [...document.querySelectorAll('body *')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.includes(arg.text)));
  return owners.map((el) => {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    const clipped = (cs.clip && cs.clip !== 'auto' && cs.clip.replace(/\\s/g, '') === 'rect(0px,0px,0px,0px)') || cs.clipPath === 'inset(50%)';
    return { tag: el.tagName, w: Math.round(r.width), h: Math.round(r.height), clipped: !!clipped, painted: r.width >= 20 && r.height >= 8 && !clipped && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0 };
  });
}`;

/**
 * Staging opens the daily "Morning brief · Joe" dialog shortly after every fresh page load; it covers the page and
 * eats pointer events. Dismiss it when it shows up (fresh browser context per test => it always does).
 */
export async function dismissBrief(screen: any) {
  const close = screen.getByRole('button', 'Dismiss morning brief');
  try { await close.waitFor({ state: 'visible', timeout: 8000 }); } catch { return; }
  await close.tap();
  await close.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
}

/** Answer a REST-style GET/POST with fixed JSON (status defaults to 200). */
export async function stubJson(browser: any, pattern: string, json: unknown, status = 200) {
  await browser.route(pattern, (route: any) => route.fulfill({ status, json }));
}
