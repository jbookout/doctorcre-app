import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { decisionExecutor } from '@e2e-dev/decision';
import { createTypeSafeAi } from '@ai-sdk/typesafe-ai';

process.env.E2E_TELEMETRY_DISABLED = '1';

const typeSafeAi = createTypeSafeAi({ apiKey: process.env.TYPESAFE_API_KEY });

const app = {
  url: 'http://127.0.0.1:0',
  command: { executable: 'npm', args: ['run', 'serve'], env: { PORT: '{port}' }, log: '.e2e/logs/app.log' },
};

export default {
  tests: ['tests/journeys/*.e2e.ts'],
  // The two vision assertions read TYPESAFE_API_KEY; their tests skip without it.
  agents: { default: { executor: decisionExecutor({ model: typeSafeAi.decisionModel('jev-latest'), vision: true }) } },
  retries: 1,
  trace: 'retain-on-failure',
  video: 'retain-on-failure',
  targets: [
    { name: 'desktop', engine: web({ viewport: { width: 1440, height: 960 } }), app },
    { name: 'phone', engine: web({ viewport: { width: 390, height: 844 } }), app },
  ],
} satisfies E2EConfig;
