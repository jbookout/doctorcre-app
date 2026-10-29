import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

process.env.E2E_TELEMETRY_DISABLED = '1';

export default {
  tests: ['tests/regressions/**/*.e2e.ts'],
  workers: 1,
  retries: 0,
  assertionTimeout: 5_000,
  trace: 'on',
  video: 'on',
  output: process.env.QA_OUTPUT ?? '.e2e/regressions',
  targets: [1440, 390].flatMap(width => (['dark', 'light'] as const).map(theme => ({
    name: `app-${width === 390 ? 'phone' : 'desktop'}-${theme}`,
    engine: web({
      viewport: { width, height: width === 390 ? 844 : 960 },
      colorScheme: theme,
      initScripts: [() => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({
        theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      }))],
    }),
    app: {
      url: 'http://127.0.0.1:0',
      command: { executable: 'node', args: ['scripts/qa-fixture-server.mjs'], env: { PORT: '{port}' }, log: `.e2e/logs/regression-fixtures-${width}-${theme}.log` },
    },
  }))),
} satisfies E2EConfig;
