import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const lint = (source, path = 'js/new-client.js') => spawnSync(process.execPath,
  ['node_modules/eslint/bin/eslint.js', '--stdin', '--stdin-filename', path, '--format', 'json'],
  { input: source, encoding: 'utf8' });

test('a new raw client timeout fails lint', () => {
  const result = lint('setTimeout(() => {}, 1);');
  assert.equal(result.status, 1);
  const [report] = JSON.parse(result.stdout);
  assert.equal(report.messages[0].ruleId, 'no-restricted-syntax');
  assert.match(report.messages[0].message, /createPageBudget.*createRequestBudget/);
});

for (const source of [
  'setInterval(() => {}, 1);',
  'while (ready) { read(); }',
  'do { read(); } while (ready);',
  'for (let i = 0; i < 10; i++) read();',
  'async function read() { for (const row of rows) await load(row); }',
  'async function read() { for (const key in rows) await load(key); }',
  'async function read() { for await (const row of rows) load(row); }',
  'retryRead();',
  'new RetryClient();',
  'client?.reconnect();',
  'const options = { retry: 3, refetchInterval: 1000 };',
  'requestIdleCallback(() => {});',
  "addEventListener('pageshow', () => {});",
  'addEventListener(eventName, () => {});',
  'const later = setTimeout; later(() => {}, 1);',
  'const { setTimeout: later } = window; later(() => {}, 1);',
  'window.setTimeout(() => {}, 1);',
  "window['requestAnimationFrame'](() => {});",
  'new EventSource("/events");',
  'new window.WebSocket("/socket");',
  "new window['EventSource']('/events');",
  "window.addEventListener('focus', () => {});",
  "addEventListener('online', () => {});",
  "document['addEventListener']('visibilitychange', () => {});",
]) {
  test(`client lint rejects ${source}`, () => {
    const result = lint(source);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout)[0].messages[0].ruleId, 'no-restricted-syntax');
  });
}

for (const path of ['src/ui/new-client.tsx', 'reports/new-client.html', 'tours/new-client.js', 'public-shell/new-client.mjs', 'new-client.html']) {
  test(`client lint covers ${path}`, () => {
    const source = path.endsWith('.html') ? '<script>setTimeout(() => {}, 1);</script>'
      : 'const delay: number = 1; setTimeout(() => {}, delay);';
    const result = lint(path.endsWith('.js') || path.endsWith('.mjs') ? 'setTimeout(() => {}, 1);' : source, path);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout)[0].messages[0].ruleId, 'no-restricted-syntax');
  });
}

test('an inline reason allows one audited callback and does not allow the next', () => {
  const source = '// eslint-disable-next-line no-restricted-syntax -- One callback after explicit input.\nsetTimeout(() => {}, 1);';
  assert.equal(lint(source).status, 0);
  const result = lint(`${source}\nsetTimeout(() => {}, 1);`);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout)[0].messages[0].line, 3);
});

for (const path of ['js/read-budget.mjs', 'js/request-budget.mjs']) {
  test(`unrelated timers remain forbidden in ${path}`, () => {
    assert.equal(lint('setTimeout(() => {}, 1);', path).status, 1);
  });
}
