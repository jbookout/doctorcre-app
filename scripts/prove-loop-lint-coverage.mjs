import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import { JSDOM } from 'jsdom';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

const baseline = git('rev-parse', process.argv[2] || '6d4304d50eac728695074febf513235e2b84eeb6').trim();

test('standard lint covers every site inventoried on main before migration', async () => {
  const scanner = git('show', `${baseline}:scripts/client-loop-guard.mjs`)
    .replace('const aliases = new Map();', 'const aliases = new Map(); const aliasOrigins = new Map();')
    .replace('if (match) aliases.set(node.id.name, match[1]);', 'if (match) { aliases.set(node.id.name, match[1]); aliasOrigins.set(node.id.name, node.init.loc); }')
    .replace('if (kind) {', 'if (kind) { const aliasOrigin = aliasOrigins.get(node.callee?.property?.name || node.callee?.name);')
    .replace('path, kind, line:', 'path, kind, aliasOrigin, line:')
    .replace('line: node.loc.start.line', 'line: node.loc.start.line, column: node.loc.start.column + 1')
    .replace("from 'jsdom'", `from '${import.meta.resolve('jsdom')}'`)
    .replace("from '@babel/parser'", `from '${pathToFileURL(createRequire(import.meta.resolve('@babel/core')).resolve('@babel/parser')).href}'`);
  const { loopSites } = await import(`data:text/javascript;base64,${Buffer.from(scanner).toString('base64')}`);
  const eslint = new ESLint({ allowInlineConfig: false });
  const paths = git('ls-tree', '-r', '--name-only', baseline).trim().split('\n').filter(path =>
    /^(js|src|reports|tours|public-shell)\/|^[^/]+\.html$/.test(path)
    && /\.(?:[cm]?[jt]s|[jt]sx|html)$/.test(path)
    && !/(^|\/)vendor\/|\.generated\.js$|\.d\.[cm]?ts$/.test(path));
  const oldSet = new Set(), newSet = new Set(), aliases = [];
  let aliasCount = 0;
  for (const path of paths) {
    const file = git('show', `${baseline}:${path}`);
    const sources = path.endsWith('.html')
      ? [...JSDOM.fragment(file).querySelectorAll('script')].map(script => script.textContent) : [file];
    for (const [index, source] of sources.entries()) {
      const sites = loopSites(source, path);
      if (!sites.length) continue;
      const [report] = await eslint.lintText(source, { filePath: path.endsWith('.html') ? 'js/inline-script.js' : path });
      assert.equal(report.fatalErrorCount, 0, path);
      const messages = report.messages.filter(message => message.ruleId === 'no-restricted-syntax');
      const location = (line, column) => `${path}#${index}:${line}:${column}`;
      for (const message of messages) newSet.add(location(message.line, message.column));
      for (const site of sites) {
        const id = location(site.line, site.column);
        oldSet.add(id);
        const direct = messages.some(message => message.line === site.line && message.column === site.column);
        const origin = site.aliasOrigin;
        const auditedOrigin = origin && messages.some(message =>
          (message.line > origin.start.line || message.line === origin.start.line && message.column > origin.start.column)
          && (message.line < origin.end.line || message.line === origin.end.line && message.column <= origin.end.column));
        if (!direct && auditedOrigin) {
          aliasCount++;
          newSet.add(id);
          aliases.push(`${id} ${site.kind} via raw scheduler in ${location(origin.start.line, origin.start.column + 1)}`);
        }
      }
    }
  }
  console.log(`Old set (${oldSet.size}):\n${[...oldSet].sort().join('\n')}`);
  console.log(`New set (${newSet.size}):\n${[...newSet].sort().join('\n')}`);
  console.log(`Scheduler aliases/wrappers covered at their raw scheduler origin (${aliasCount}):\n${aliases.join('\n')}`);
  const missing = [...oldSet].filter(id => !newSet.has(id));
  assert.deepEqual(missing, [], 'Every old site must be linted directly or at its raw scheduler origin; inline exceptions are disabled');
});
