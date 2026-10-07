import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

// The production journeys: read-only, signed out, against the live app. The
// carr-system release pipeline runs them after every release (ops/release-smoke.py)
// with --output under .e2e/ and copies the report, screenshots and traces into
// its evidence folder. Nothing is started and no model is configured.
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
