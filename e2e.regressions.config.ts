import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { modelRoomExplorationModel } from './scripts/e2e-staging/model-room.mjs';
import { modelCallsAllowed, RUN_LIMITS } from './scripts/e2e-staging/run-limits.mjs';

process.env.E2E_TELEMETRY_DISABLED = '1';
process.env.DO_NOT_TRACK = '1';

export default {
  tests: ['tests/regressions/**/*.e2e.ts'],
  workers: RUN_LIMITS.workers,
  retries: RUN_LIMITS.retries,
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
  ...(process.env.CI || !modelCallsAllowed() ? {} : { agents: { default: { model: modelRoomExplorationModel, context: 'Synthetic local DoctorCRE fixtures only. Never start a login or navigate to production.' } } }),
} satisfies E2EConfig;
