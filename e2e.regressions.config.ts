import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { chatgpt } from 'e2e/oauth/chatgpt';

process.env.E2E_TELEMETRY_DISABLED = '1';
process.env.DO_NOT_TRACK = '1';

export default {
  tests: ['tests/regressions/**/*.e2e.ts'],
  workers: 1,
  retries: 0,
  assertionTimeout: 5_000,
  trace: 'on',
  video: 'on',
  output: process.env.QA_OUTPUT ?? '.e2e/regressions',
  targets: [{
    name: 'app-desktop',
    engine: web({ viewport: { width: 1440, height: 960 } }),
    app: {
      url: 'http://127.0.0.1:0',
      command: { executable: 'node', args: ['scripts/qa-fixture-server.mjs'], env: { PORT: '{port}' }, log: '.e2e/logs/regression-fixtures.log' },
    },
  }],
  ...(process.env.CI ? {} : { agents: { default: { model: chatgpt('gpt-6.1-sol'), providerOptions: { openai: { reasoningEffort: 'high' } }, context: 'Synthetic local DoctorCRE fixtures only. Never start a login or navigate to production.' } } }),
} satisfies E2EConfig;
