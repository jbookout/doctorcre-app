import { JSDOM } from 'jsdom';
import { parse } from '@babel/parser';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const timer = /^(?:setInterval|setTimeout|requestAnimationFrame|requestIdleCallback|EventSource|WebSocket)$/;
const retry = /retry|reconnect|refetchInterval/i;
const lifecycle = new Set(['online', 'focus', 'visibilitychange', 'pageshow']);
export function loopSites(source, path) {
  const file = parse(source, { sourceType: 'unambiguous', plugins: ['typescript', 'jsx'], allowAwaitOutsideFunction: true });
  const sites = [];
  const aliases = new Map();
  function findAliases(node) {
    if (!node || typeof node !== 'object' || !node.type) return;
    if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern') {
      for (const prop of node.id.properties) {
        if (prop.type === 'ObjectProperty' && timer.test(prop.key.name || prop.key.value || '') && prop.value.type === 'Identifier') aliases.set(prop.value.name, prop.key.name || prop.key.value);
      }
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      const match = source.slice(node.init.start, node.init.end).match(/\b(setInterval|setTimeout|requestAnimationFrame|EventSource|WebSocket)\b/);
      if (match) aliases.set(node.id.name, match[1]);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(findAliases);
      else if (value && typeof value === 'object' && value.type) findAliases(value);
    }
  }
  findAliases(file.program);
  function visit(node) {
    if (!node || typeof node !== 'object' || !node.type) return;
    let kind;
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'createPageBudget') kind = 'page-budget';
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'createRequestBudget') kind = 'request-budget';
    if (['WhileStatement', 'DoWhileStatement', 'ForStatement'].includes(node.type)) kind = 'loop';
    if (['ForOfStatement', 'ForInStatement'].includes(node.type) && /\bawait\b/.test(source.slice(node.body.start, node.body.end))) kind = 'read-loop';
    if (['CallExpression', 'OptionalCallExpression', 'NewExpression'].includes(node.type)) {
      const name = node.callee.property?.name || node.callee.property?.value || node.callee.name || '';
      if (name === 'addEventListener' && (node.arguments[0]?.type !== 'StringLiteral' || lifecycle.has(node.arguments[0].value))) kind = 'event-refresh';
      else if (timer.test(name)) kind = name;
      else if (aliases.has(name)) kind = aliases.get(name);
      else if (retry.test(name)) kind = 'retry';
    }
    if (node.type === 'ObjectProperty' && retry.test(node.key.name || node.key.value || '')) kind = 'retry-option';
    if (kind) {
      const text = source.slice(node.start, node.end);
      const hash = createHash('sha256').update(source).update(text).digest('hex');
      sites.push({ id: `${path}:${kind}:${hash}`, path, kind, line: node.loc.start.line, source: text });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object' && value.type) visit(value);
    }
  }
  visit(file.program);
  return sites;
}
export async function scanLoops(root) {
  const result = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'vendor' || entry.name.endsWith('.generated.js') || /\.d\.[cm]?ts$/.test(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:[cm]?[jt]s|[jt]sx|html)$/.test(entry.name)) {
        const source = await readFile(path, 'utf8');
        const name = relative(root, path);
        if (entry.name.endsWith('.html')) {
          for (const script of JSDOM.fragment(source).querySelectorAll('script')) result.push(...loopSites(script.textContent, name));
        } else result.push(...loopSites(source, name));
      }
    }
  }
  for (const dir of ['js', 'src', 'reports', 'tours', 'public-shell']) await walk(join(root, dir));
  for (const entry of await readdir(root)) if (entry.endsWith('.html')) {
    const source = await readFile(join(root, entry), 'utf8');
    for (const script of JSDOM.fragment(source).querySelectorAll('script')) result.push(...loopSites(script.textContent, entry));
  }
  return result;
}
export function auditLoops(sites, inventory) {
  const errors = [];
  const ids = new Set(sites.map(site => site.id));
  for (const site of sites) {
    const entry = inventory[site.id];
    if (!entry) { errors.push(`${site.path}:${site.line} ${site.kind} is unaudited`); continue; }
    if (!Number.isFinite(entry.cap) || entry.cap < 0) errors.push(`${site.id} requires a finite cap number`);
    for (const field of ['backoff', 'idleStop']) if (typeof entry[field] !== 'string' || !entry[field].trim()) errors.push(`${site.id} lacks ${field}`);
  }
  for (const id of Object.keys(inventory)) if (!ids.has(id)) errors.push(`${id} is stale; review the changed source`);
  return errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sites = await scanLoops(process.cwd());
  const inventory = JSON.parse(await readFile('test/loop-inventory.json', 'utf8'));
  const errors = auditLoops(sites, inventory);
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log(`Loop guard passed: ${sites.length} audited sites.`);
}
