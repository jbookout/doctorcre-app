import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { chatgpt } from 'e2e/oauth/chatgpt';

// No usage telemetry from any run, local or CI. The CLI reads this when it
// flushes, after the config has loaded.
process.env.E2E_TELEMETRY_DISABLED = '1';

// Agent steps run only on a local machine signed in with `npx e2e login openai`.
// CI configures no model: the deterministic suite never needs one.
const ci = !['', '0', 'false'].includes(process.env.CI ?? '');

export default {
  workers: 1,
  retries: 0,
  trace: 'retain-on-failure',
  video: 'retain-on-failure',
  targets: [{
    name: 'chromium',
    engine: web({ browser: 'chromium', viewport: { width: 1440, height: 960 } }),
    app: {
      url: 'http://127.0.0.1:0',
      // The synthetic fixture server; on localhost the app boots fixture mode.
      command: { executable: 'npm', args: ['run', 'serve'], env: { PORT: '{port}', DOCTORCRE_FIXTURE_ROOT: process.env.BROWSER_PROOF_ROOT ?? '' }, log: '.e2e/logs/app.log' },
    },
  }],
  ...(ci ? {} : { agents: { default: { model: chatgpt(process.env.E2E_AGENT_MODEL ?? 'gpt-6-luna') } } }),
} satisfies E2EConfig;
