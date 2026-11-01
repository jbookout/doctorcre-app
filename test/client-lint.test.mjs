import test from 'node:test';
import { ESLint } from 'eslint';
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
    assert.ok(JSON.parse(result.stdout)[0].messages.some(m => ['no-restricted-syntax', 'client/no-scheduler-alias'].includes(m.ruleId)));
  });
}

for (const path of ['src/ui/new-client.tsx', 'reports/new-client.html', 'tours/new-client.js', 'public-shell/new-client.mjs', 'new-client.html']) {
  test(`client lint covers ${path}`, () => {
    const source = path.endsWith('.html') ? '<script>setTimeout(() => {}, 1);</script>'
      : 'const delay: number = 1; setTimeout(() => {}, delay);';
    const result = lint(path.endsWith('.js') || path.endsWith('.mjs') ? 'setTimeout(() => {}, 1);' : source, path);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(JSON.parse(result.stdout)[0].messages.some(m => ['no-restricted-syntax', 'client/no-scheduler-alias'].includes(m.ruleId)));
  });
}

test('an inline reason allows one audited callback and does not allow the next', () => {
  const source = '// eslint-disable-next-line no-restricted-syntax -- 1 callback after explicit input.\nsetTimeout(() => {}, 1);';
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

for (const source of [
  '// eslint-disable-next-line no-restricted-syntax -- 1 audited origin\nconst later = setTimeout;\nfunction repeat() { later(repeat, 1000); }',
  'const { setTimeout: later } = window;',
  'const later = window.setTimeout;',
  'later = self.queueMicrotask;',
  'function schedule(setTimeout) { const later = setTimeout; }',
  "export { setTimeout as later } from './scheduler.js';",
  'consume(globalThis.requestIdleCallback);',
]) {
  test(`scheduler aliases cannot use a call-site exemption: ${source}`, () => {
    const result = lint(source);
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout)[0].messages.some(m => m.ruleId === 'client/no-scheduler-alias'));
  });
}

test('exemptions require four words naming a bound or owner', () => {
  assert.equal(lint('// eslint-disable-next-line no-restricted-syntax -- A callback.\nsetTimeout(work, 1);').status, 1);
  for (const reason of ['single callback after explicit input', 'cleared on panel disposal', 'cancel when the panel closes']) {
    assert.equal(lint(`// eslint-disable-next-line no-restricted-syntax -- ${reason}\nsetTimeout(work, 1);`).status, 0);
  }
});

test('all scheduler names reject value transfers through bare and global forms', async () => {
  const eslint = new ESLint();
  for (const scheduler of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask']) {
    for (const value of [scheduler, `window.${scheduler}`, `globalThis['${scheduler}']`, `self.${scheduler}`]) {
      for (const source of [`const later = ${value};`, `later = ${value};`, `consume(${value});`, `export default ${value};`]) {
        const [report] = await eslint.lintText(source, { filePath: 'js/new-client.js' });
        assert.ok(report.messages.some(m => m.ruleId === 'client/no-scheduler-alias'), source);
      }
    }
    for (const source of [`const { ${scheduler}: later } = window;`, `({ ${scheduler}: later } = self);`, `const { window: { ${scheduler}: later } } = globalThis;`, `function consume({ ${scheduler}: later }) {}`]) {
      const [report] = await eslint.lintText(source, { filePath: 'js/new-client.js' });
      assert.ok(report.messages.some(m => m.ruleId === 'client/no-scheduler-alias'), source);
    }
  }
});

test('global-object aliases reject scheduler extraction and destructuring', async () => {
  const eslint = new ESLint();
  for (const global of ['window', 'globalThis', 'self']) {
    for (const scheduler of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask']) {
      for (const source of [
        `const w = ${global}; const later = w.${scheduler};`,
        `const { window: w } = ${global}; const later = w.${scheduler};`,
        `let g; g = ${global}; const later = g.${scheduler};`,
        `const w = ${global}; const { ${scheduler}: t } = w;`,
        `const w = ${global}; const { [\`${scheduler}\`]: t } = w;`,
      ]) {
        const [report] = await eslint.lintText(source, { filePath: 'js/new-client.js' });
        assert.ok(report.messages.some(m => m.ruleId === 'client/no-scheduler-alias'), source);
      }
    }
  }
});

test('static computed keys reject all five schedulers on globals and aliases', async () => {
  const eslint = new ESLint();
  for (const global of ['window', 'globalThis', 'self']) {
    for (const scheduler of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask']) {
      for (const object of [global, 'w', 'g']) {
        for (const key of [`'${scheduler}'`, `\`${scheduler}\``]) {
          const source = `const w = ${global}; let g; g = ${global}; ${object}[${key}](work, 1);`;
          const [report] = await eslint.lintText(source, { filePath: 'js/new-client.js' });
          assert.ok(report.messages.some(m => m.ruleId === 'no-restricted-syntax'), source);
        }
      }
    }
  }
});

test('exemption reasons identify a specific bound or owner', () => {
  for (const reason of ['TODO 1', 'cancel', 'ok', 'n/a', 'TODO FIXME XXX cancel 123!', 'see above same cancel', 'one vague unrelated phrase']) {
    assert.equal(lint(`// eslint-disable-next-line no-restricted-syntax -- ${reason}\nsetTimeout(work, 1);`).status, 1, reason);
  }
  assert.equal(lint('// eslint-disable-next-line no-restricted-syntax -- cleared on dispose; one pending timer per panel\nsetTimeout(work, 1);').status, 0);
});

test('reviewer probes fail lint', () => {
  for (const source of ['const w = window; const later = w.setTimeout; function repeat() { later(repeat, 1); }', 'window[`setTimeout`](() => {}, 1);']) assert.equal(lint(source).status, 1, source);
});

test('audited global scheduler calls retain call-site exemptions', () => {
  for (const callee of ['window.setTimeout', 'globalThis["setTimeout"]', 'self[`setTimeout`]', 'w[`setTimeout`]']) {
    assert.equal(lint(`const w = window;\n// eslint-disable-next-line no-restricted-syntax -- cleared on dispose; one pending timer per panel\n${callee}(work, 1);`).status, 0, callee);
  }
});
