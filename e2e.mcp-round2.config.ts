import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import base from './e2e.round2.config.ts';
import { seedFixture } from './tests/qa/support.ts';
const url = process.env.QA_APP_URL ?? 'http://127.0.0.1:18997';
const seeded = await seedFixture(url, 'mcp-root-proof', 'joe');
export default {
  ...base,
  targets: [
    { name: 'mcp-root', engine: web({ viewport: { width: 390, height: 844 }, initScripts: [`document.cookie = ${JSON.stringify(`${seeded.cookie.name}=${seeded.cookie.value};path=/`)};`] }), app: { url } },
    { name: 'mcp-desktop', engine: web({ viewport: { width: 1440, height: 960 }, initScripts: [`document.cookie = ${JSON.stringify(`${seeded.cookie.name}=${seeded.cookie.value};path=/`)};`] }), app: { url } },
  ],
} satisfies E2EConfig;
