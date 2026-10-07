import type { E2EConfig } from 'e2e';
import { chatgpt } from 'e2e/oauth/chatgpt';
import base from './e2e.config.ts';

export default {
  ...base,
  tests: ['tests/journeys/**/*.e2e.ts', 'tests/agent/**/*.e2e.ts'],
  reporters: ['list', 'junit', 'markdown'],
  agents: {
    default: {
      model: chatgpt(process.env.E2E_AGENT_MODEL ?? 'gpt-6.1-sol'),
      providerOptions: { openai: { reasoningEffort: 'high' } },
    },
  },
} satisfies E2EConfig;
