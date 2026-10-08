import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { stagingTargets } from './scripts/e2e-staging/screens.mjs';
import { modelRoomExplorationModel } from './scripts/e2e-staging/model-room.mjs';

// No usage telemetry from any run, local or CI. The CLI reads this when it
// flushes, after the config has loaded.
process.env.E2E_TELEMETRY_DISABLED = '1';

const staging = process.env.E2E_TARGET === 'staging-live';
const ci = !['', '0', 'false'].includes(process.env.CI ?? '');

export default {
  workers: 1,
  retries: 0,
  trace: 'retain-on-failure',
  video: 'retain-on-failure',
  ...(staging ? { tests: ['tests/staging-live/**/*.e2e.ts'], cache: 'off' as const } : {}),
  targets: staging ? stagingTargets() : [{
    name: 'chromium',
    engine: web({ browser: 'chromium', viewport: { width: 1440, height: 960 } }),
    app: {
      url: 'http://127.0.0.1:0',
      // The synthetic fixture server; on localhost the app boots fixture mode.
      command: { executable: 'npm', args: ['run', 'serve'], env: { PORT: '{port}', DOCTORCRE_FIXTURE_ROOT: process.env.BROWSER_PROOF_ROOT ?? '' }, log: '.e2e/logs/app.log' },
    },
  }],
  ...(ci && !staging ? {} : { agents: { default: { model: modelRoomExplorationModel },
    'bug-hunter': { model: modelRoomExplorationModel, maxSteps: 40, system: 'Inspect the entire assigned staging workspace. Exercise forms, menus, drawers, tabs, recovery and destructive controls. Report only observed defects with reproduction steps.' },
    'first-time-ux': { model: modelRoomExplorationModel, maxSteps: 40, system: 'Explore the assigned staging workspace as a first-time partner. Check discovery, copy, keyboard navigation and recovery. Record evidence for every finding.' },
    'phone-reviewer': { model: modelRoomExplorationModel, maxSteps: 40, system: 'Inspect the complete assigned workspace at phone width. Open collapsed drawers and menus. Check tap targets, clipping, scrolling, forms and every tab.' },
  } }),
} satisfies E2EConfig;
