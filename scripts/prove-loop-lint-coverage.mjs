import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import { JSDOM } from 'jsdom';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

const baseline = git('rev-parse', process.argv[2] || '6d4304d50eac728695074febf513235e2b84eeb6').trim();

test('direct sites are linted; historical indirect sites receive no origin credit', async () => {
  const scanner = git('show', `${baseline}:scripts/client-loop-guard.mjs`)
    .replace('line: node.loc.start.line', 'line: node.loc.start.line, column: node.loc.start.column + 1')
    .replace("from 'jsdom'", `from '${import.meta.resolve('jsdom')}'`)
    .replace("from '@babel/parser'", `from '${pathToFileURL(createRequire(import.meta.resolve('@babel/core')).resolve('@babel/parser')).href}'`);
  const { loopSites } = await import(`data:text/javascript;base64,${Buffer.from(scanner).toString('base64')}`);
  const eslint = new ESLint({ allowInlineConfig: false });
  const paths = git('ls-tree', '-r', '--name-only', baseline).trim().split('\n').filter(path =>
    /^(js|src|reports|tours|public-shell)\/|^[^/]+\.html$/.test(path)
    && /\.(?:[cm]?[jt]s|[jt]sx|html)$/.test(path)
    && !/(^|\/)vendor\/|\.generated\.js$|\.d\.[cm]?ts$/.test(path));
  const oldSet = new Set(), newSet = new Set();
  const wrapperCalls = [];
  const directScanner = scanner.replace("else if (aliases.has(name)) kind = aliases.get(name);", '');
  const { loopSites: directSites } = await import(`data:text/javascript;base64,${Buffer.from(directScanner).toString('base64')}`);
  for (const path of paths) {
    const file = git('show', `${baseline}:${path}`);
    const sources = path.endsWith('.html')
      ? [...JSDOM.fragment(file).querySelectorAll('script')].map(script => script.textContent) : [file];
    const current = readFileSync(path, 'utf8');
    const currentSources = path.endsWith('.html')
      ? [...JSDOM.fragment(current).querySelectorAll('script')].map(script => script.textContent) : [current];
    for (const [index, source] of sources.entries()) {
      const sites = loopSites(source, path);
      if (!sites.length) continue;
      const migrated = directSites(currentSources[index], path);
      const [report] = await eslint.lintText(currentSources[index], { filePath: path.endsWith('.html') ? 'js/inline-script.js' : path });
      assert.equal(report.fatalErrorCount, 0, path);
      const messages = report.messages.filter(message => message.ruleId === 'no-restricted-syntax');
      const location = (line, column) => `${path}#${index}:${line}:${column}`;
      for (const site of migrated) {
        assert.ok(messages.some(message => message.line === site.line && message.column === site.column), `${location(site.line, site.column)}: direct diagnostic required`);
      }
      const [historicalReport] = await eslint.lintText(source, { filePath: path.endsWith('.html') ? 'js/inline-script.js' : path });
      for (const site of sites) {
        const id = location(site.line, site.column);
        oldSet.add(id);
        const direct = directSites(source, path).some(candidate => candidate.line === site.line && candidate.column === site.column);
        if (direct) {
          assert.ok(historicalReport.messages.some(message => message.ruleId === 'no-restricted-syntax' && message.line === site.line && message.column === site.column), `${id}: historical direct diagnostic required`);
          newSet.add(id);
        }
        else wrapperCalls.push(`${id} ${site.source.split('\n')[0]}`);
      }
    }
  }
  console.log(`Old set (${oldSet.size}):\n${[...oldSet].sort().join('\n')}`);
  console.log(`New set (${newSet.size}):\n${[...newSet].sort().join('\n')}`);
  console.log(`Direct call-site coverage: ${newSet.size}/${oldSet.size}; no scheduler-origin credit`);
  assert.equal(oldSet.size, 224);
  assert.equal(newSet.size, 214);
  assert.equal(wrapperCalls.length, 10);
  console.log(`Historical indirect calls (no coverage credit):\n${wrapperCalls.join('\n')}`);
});
