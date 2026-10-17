import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

// Production journeys are read-only and signed out. carr-system release-smoke.py
// runs them and collects reports, screenshots and traces as release evidence.
process.env.E2E_TELEMETRY_DISABLED = '1';

export default {
  tests: ['smoke/production/**/*.e2e.ts'],
  workers: 1,
  retries: 0,
  trace: 'on',
  video: 'retain-on-failure',
  targets: [{
    name: 'chromium',
    engine: web({ browser: 'chromium', viewport: { width: 1440, height: 960 } }),
    app: { url: process.env.DOCTORCRE_SMOKE_URL ?? 'https://app.doctorcre.com' },
  }],
} satisfies E2EConfig;
