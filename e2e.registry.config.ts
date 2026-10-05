import type { E2EConfig } from 'e2e';
process.env.E2E_TELEMETRY_DISABLED = '1';
export default {
  projectId: 'doctorcre-read-only-registry',
  tests: ['tests/qa/registry.e2e.ts'],
  targets: [{ name: 'registry', platform: 'api' }],
  reporters: ['list', 'junit', 'markdown'],
  output: '.e2e/round2-registry-no-browser',
} satisfies E2EConfig;
