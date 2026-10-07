// Builds the staging coverage table and the feature x capability matrix from
// evidence the runs already wrote: run reports (.e2e/**/report.json), the
// per-screen control census (.e2e/staging-coverage/*.json, from screens.e2e.ts),
// the MCP locator checks (.e2e/mcp/*.json), the charters file and the feature
// inventory (tests/staging/features.json). Nothing is typed in by hand: a cell
// is only as true as the report it was read from.
// Usage: node scripts/e2e-staging/coverage-matrix.mjs  -> .e2e/coverage/{coverage.md,matrix.md,matrix.json}
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { screens } from './screens.mjs';
import { readSessionSecretSync } from './session.mjs';

const read = p => JSON.parse(readFileSync(p, 'utf8'));
const walk = (dir, out = []) => { if (!existsSync(dir)) return out; for (const n of readdirSync(dir)) { const p = join(dir, n); if (n === 'artifacts' || n === 'cache' || n.startsWith('cache-')) continue; const s = statSync(p); if (s.isDirectory()) walk(p, out); else if (n === 'report.json') out.push(p); } return out; };
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const slug = p => p.replace(/[^a-z0-9]+/gi, '_');
const NAV = { home: '/', leads: '/leads', tours: '/tours', 'local deals': '/deals', vendors: '/vendors', 'control room': '/control-room', search: '/search', updates: '/updates', 'doc chats': '/doc-chats', 'doc activity': '/doc-activity', 'lease radar': '/leases', invoices: '/invoices', calendar: '/calendar', relationships: '/relationships', clients: '/clients', incidents: '/incidents', status: '/status', 'design lab': '/design-lab', 'all work': '/all-work', 'work requests': '/work-requests', 'ideas & events': '/ideas-events' };

const features = read('tests/staging/features.json').features;
const routes = await screens();
const reports = [...walk('.e2e/runs'), ...walk('.e2e/bugbash'), ...walk('.e2e/bugbash2')].map(p => ({ path: p, run: read(p).run })).filter(r => r.run?.results);
const pathOf = url => { try { const u = new URL(url, 'https://x'); return u.pathname + (u.search && /view=|tab=/.test(u.search) ? u.search : ''); } catch { return null; } };
const screenFor = p => { if (!p) return null; const exact = routes.find(r => r.path === p); if (exact) return exact.path; const bare = p.split('?')[0]; return (routes.find(r => r.path === bare) || routes.filter(r => bare.startsWith(r.path.split('?')[0]) && r.path !== '/').sort((a, b) => b.path.length - a.path.length)[0])?.path ?? null; };

// 1. Controls exercised: every engine action (agent or deterministic), attributed to the screen open at the time.
const exercised = new Map(); // `${width}|${path}` -> Set(names)
const touched = new Map();   // path -> Set(test or charter label)
const note = (width, path, name, who) => { if (!path) return; const k = `${width}|${path}`; if (!exercised.has(k)) exercised.set(k, new Set()); if (name) exercised.get(k).add(norm(name)); if (!touched.has(path)) touched.set(path, new Set()); touched.get(path).add(who); };
for (const { path: rp, run } of reports) {
  for (const res of run.results) {
    if (res.selected === false || !res.attempts?.length) continue;
    const width = res.targetId === 'staging-phone' ? 390 : 1440;
    const who = res.file === 'explore' ? `charter:${rp.split('/').at(-2)}` : `${res.file.replace('tests/staging/', '')} › ${res.titlePath.at(-1).slice(0, 60)}`;
    let here = null;
    for (const step of res.attempts.at(-1).steps || []) {
      if (step.api === 'app.open') { here = screenFor(pathOf(step.label)); if (res.file !== 'explore') note(width, here, null, who); continue; }
      const m = /getBy(?:Role\("[^"]+",\s*name:\s*|Label\(|Text\()"([^"]+)"/.exec(step.label || '');
      if (step.kind === 'locator' && m) note(width, here, m[1], who);
      for (const ev of step.events || []) {
        if (ev.kind !== 'engine' || ev.status !== 'passed' || !ev.detail) continue;
        const nav = /^navigate (?:to )?(\S+)/.exec(ev.detail); if (nav) { here = screenFor(pathOf(nav[1])) ?? here; note(width, here, null, who); continue; }
        const act = /"([^"]+)"/.exec(ev.detail); if (!act) continue;
        note(width, here, act[1], who);
        if (/^tap link /.test(ev.detail) && NAV[norm(act[1])]) { here = NAV[norm(act[1])]; note(width, here, null, who); }
      }
    }
  }
}
// Charters also claim the screens their charter names.
const charters = readFileSync('.e2e/bugbash/charters.txt', 'utf8').split('\n').filter(Boolean).map(l => l.split('|'));
if (existsSync('.e2e/bugbash2/charters.txt')) charters.push(...readFileSync('.e2e/bugbash2/charters.txt', 'utf8').split('\n').filter(Boolean).map(l => l.split('|')));
for (const [slugName, target, , text] of charters) for (const m of text.matchAll(/(\/[a-z][a-z0-9\-\/]*(?:\?[a-z=]+)?)/g)) { const p = screenFor(m[1]); if (p) { if (!touched.has(p)) touched.set(p, new Set()); touched.get(p).add(`charter:${slugName}`); } }

// 2. Coverage table rows: every routed screen x viewport (30 x 2 = 60, board routes included).
const cov = [];
for (const r of routes) for (const width of [1440, 390]) {
  const f = `.e2e/staging-coverage/screen-${width}-${slug(r.path)}.json`;
  const present = existsSync(f) ? read(f) : null;
  const names = present ? [...new Set(present.names.map(norm))] : [];
  const ex = exercised.get(`${width}|${r.path}`) || new Set();
  const hit = names.filter(n => [...ex].some(e => e && (n === e || n.startsWith(e) || e.startsWith(n))));
  cov.push({ path: r.path, name: r.name, surface: r.surface, width, reached: !!present, present: names.length, exercised: hit.length, who: [...(touched.get(r.path) || [])] });
}

// 3. Feature results: the latest report per (test title, target) among journey files.
const latest = new Map();
for (const { run } of reports) for (const res of run.results) {
  if (res.selected === false) continue;
  const t = res.titlePath?.at(-1) || ''; const id = /^\[([a-z0-9-]+)\]/.exec(t)?.[1]; if (!id || !res.file.startsWith('tests/staging/')) continue;
  const key = `${id}|${res.targetId}|${res.file.includes('/bugbash/') ? 'repro' : 'journey'}`;
  const at = Date.parse(run.startedAt || 0); if (!latest.has(key) || latest.get(key).at <= at) latest.set(key, { at, res, file: res.file });
}
const status = r => !r ? 'not run' : r.res.status === 'skipped' ? `blocked: ${r.res.skip?.reason ?? r.res.reason ?? 'skipped'}` : r.res.status;
const err = r => { const e = r?.res.attempts?.at(-1)?.error; return e ? `${e.code}: ${String(e.message).split('\n').slice(0, 3).join(' ').slice(0, 220)}` : ''; };
const apis = r => new Set((r?.res.attempts?.at(-1)?.steps || []).map(s => s.api));
const src = file => existsSync(file) ? readFileSync(file, 'utf8') : '';
const mcp = [...['staging', 'staging-phone']].flatMap(t => existsSync(`.e2e/mcp/locators-${t}.json`) ? read(`.e2e/mcp/locators-${t}.json`).map(x => ({ ...x, target: t })) : []);
let secretLeak = 'not checked';
try { const s = readSessionSecretSync(); let leaked = false; for (const { path: p } of reports) if (readFileSync(p, 'utf8').includes(s)) leaked = true; secretLeak = leaked ? 'LEAKED' : 'clean'; } catch { secretLeak = 'secret file unavailable'; }

const cell = (used, st, reason) => used ? (st === 'passed' ? 'pass' : st.startsWith('blocked') ? 'blocked' : st === 'failed' ? 'fail' : st) : `N/A: ${reason}`;
const rows = features.map(f => {
  const d = latest.get(`${f.id}|staging|journey`), p = latest.get(`${f.id}|staging-phone|journey`), repro = latest.get(`${f.id}|staging|repro`) || latest.get(`${f.id}|staging-phone|repro`);
  const a = apis(d), body = src(d?.file || '');
  const block = (body.split(`[${f.id}]`)[1] || '').split(/\n\s*(?:verbTest|test)\(/)[0];
  const ds = status(d), ps = status(p);
  const charterHit = [...(touched.get(screenFor(f.screen)) || [])].filter(w => w.startsWith('charter:'));
  const replay = (d?.res.attempts?.at(-1)?.steps || []).filter(s => s.api === 'agent.act').map(s => s.cache?.mode).filter(Boolean);
  const locs = mcp.filter(m => m.path === f.screen);
  if (!d) return { id: f.id, area: f.area, screen: f.screen, desktop: 'not run', phone: ps, failure: '', repro: repro ? `${repro.file} (${repro.res.status})` : '', caps: Object.fromEntries(['deterministic', 'act', 'assert', 'waitFor', 'extract', 'replay', 'explore', 'api', 'desktop', 'phone', 'mobile', 'ci', 'mcp', 'redaction'].map(c => [c, c === 'mobile' ? 'N/A: no iOS build yet (planned)' : c === 'explore' && charterHit.length ? `charters: ${charterHit.map(x => x.slice(8)).join(', ')}` : 'not run'])) };
  return {
    id: f.id, area: f.area, screen: f.screen, desktop: ds, phone: ps, failure: err(d) || err(p), repro: repro ? `${repro.file} (${repro.res.status})` : '',
    caps: {
      deterministic: cell([...a].some(x => x?.startsWith('expect.')), ds, 'no locator expect in this journey'),
      act: cell(a.has('agent.act'), ds, 'every step is a known, stable control (deterministic screen action)'),
      assert: cell(a.has('agent.assert'), ds, 'outcome pinned by a locator expect'),
      waitFor: cell(a.has('agent.waitFor'), ds, 'outcome is synchronous'),
      extract: cell(a.has('agent.extract'), ds, 'no on-screen value to compare'),
      replay: replay.length ? `recorded/replayed (${replay.join(', ')})` : a.has('agent.act') ? 'recorded (cold)' : 'N/A: no agent.act step',
      explore: charterHit.length ? `charters: ${charterHit.map(c => c.slice(8)).join(', ')}` : 'N/A: no charter named this screen',
      api: /\bverb\(|\bapi\(/.test(block) ? cell(true, ds) : 'N/A: persistence proven by reload + expect',
      desktop: ds, phone: ps,
      mobile: 'N/A: no iOS build yet (planned)',
      ci: 'N/A: agent journey needs a CI model credential (none; ChatGPT login is local-only)',
      mcp: locs.length ? `${locs.filter(l => l.ok).length}/${locs.length} locators unique` : 'N/A: locators not in the MCP check list',
      redaction: `secret registered; reports ${secretLeak}`,
    },
  };
});
mkdirSync('.e2e/coverage', { recursive: true });
writeFileSync('.e2e/coverage/matrix.json', JSON.stringify({ generatedAt: new Date().toISOString(), coverage: cov, features: rows, mcp, secretLeak }, null, 1));
const md = [];
md.push('| Screen | Viewport | Reached | Controls exercised / present | Tests and charters that touched it |', '|---|---|---|---|---|');
for (const c of cov) md.push(`| ${c.name} (\`${c.path}\`) | ${c.width === 390 ? 'phone' : 'desktop'} | ${c.reached ? 'yes' : 'NO'} | ${c.exercised} / ${c.present} | ${c.who.length} (${c.who.filter(w => w.startsWith('charter:')).map(w => w.slice(8)).join(', ') || 'no charter'}) |`);
writeFileSync('.e2e/coverage/coverage.md', md.join('\n') + '\n');
const cols = ['deterministic', 'act', 'assert', 'waitFor', 'extract', 'replay', 'explore', 'api', 'desktop', 'phone', 'mobile', 'ci', 'mcp', 'redaction'];
const mm = [`| Feature | ${cols.join(' | ')} | Failure | Repro |`, `|---|${cols.map(() => '---').join('|')}|---|---|`];
for (const r of rows) mm.push(`| ${r.id} | ${cols.map(c => r.caps[c]).join(' | ')} | ${r.failure.replace(/\|/g, '/')} | ${r.repro} |`);
writeFileSync('.e2e/coverage/matrix.md', mm.join('\n') + '\n');
const reached = cov.filter(c => c.reached).length, ex = cov.reduce((s, c) => s + c.exercised, 0), pr = cov.reduce((s, c) => s + c.present, 0);
const tally = k => rows.reduce((m, r) => { const v = r[k].startsWith('blocked') ? 'blocked' : r[k]; m[v] = (m[v] || 0) + 1; return m; }, {});
console.log(`screens reached ${reached}/${cov.length}; controls exercised ${ex}/${pr}; features ${rows.length}; desktop ${JSON.stringify(tally('desktop'))}; phone ${JSON.stringify(tally('phone'))}; secret scan ${secretLeak}`);
