import type { E2EConfig, StepExecutor } from 'e2e';
import { web } from '@e2e-dev/web';
import { chatgpt } from 'e2e/oauth/chatgpt';
import { createToolLoopExecutor } from 'e2e/agent';
import { tool } from 'ai';
import { z } from 'zod';
import { createQaTools } from './tests/qa/tools.ts';

process.env.E2E_TELEMETRY_DISABLED = '1';
process.env.DO_NOT_TRACK = '1';
const url = process.env.QA_APP_URL ?? 'http://127.0.0.1:18997';
const namespace = process.env.QA_NAMESPACE ?? 'round2';
const model = chatgpt('gpt-6.1-sol');
const context = 'DoctorCRE on this local origin contains synthetic fixtures only. Joe and Dell share team business access. Just Me scopes ownership. Live fixture pages require ?mode=live. App-local fixture mode on other pages is also synthetic. No real email, microphone, payments, external accounts or AI integrations are configured. Never navigate to production, start a login or connect an integration. Missing integration keys are environment limits; poor failure feedback can be a product issue. A link that opens another tab is not dead solely because this tab stays unchanged. Check rendered screenshots before judging copy, and scroll lazy content into view. The account avatar opens settings. The floating Doc button opens Dr. CRE. Fixture setup is isolated by QA namespace.';
const persona = {
  model, providerOptions: { openai: { reasoningEffort: 'high' } }, context,
  maxSteps: 40, maxModelCalls: 40, judgmentTimeout: 120_000,
  tools: createQaTools(url, namespace),
};
const scripted: StepExecutor = {
  name: 'visible-text-check', version: '1', cache: 'off',
  async runStep(ctx) {
    const prefix = 'the screen contains ';
    if (ctx.step.kind !== 'assert' || !ctx.step.instruction.startsWith(prefix)) {
      return { status: 'blocked', errorCode: 'AUTOMATION_UNSUPPORTED', summary: 'Only explicit visible-text assertions are supported.' };
    }
    const expected = ctx.step.instruction.slice(prefix.length);
    const observed = await ctx.observe();
    const holds = observed.text.includes(expected);
    return { status: holds ? 'passed' : 'failed', summary: holds ? `Observed ${expected}.` : `Did not observe ${expected}.` };
  },
};

export default {
  projectId: 'doctorcre-round2', tests: ['tests/**/*.e2e.ts'],
  workers: 1, retries: 0, timeout: 240_000, assertionTimeout: 5_000,
  output: process.env.QA_OUTPUT ?? '.e2e/round2',
  trace: 'on', video: 'retain-on-failure',
  cache: { mode: 'read-write', dir: '.e2e/round2-cache' },
  targets: [
    { name: 'app-desktop', engine: web({ viewport: { width: 1440, height: 960 }, locale: 'en-US', timezoneId: 'America/Chicago' }), app: { url, identity: 'doctorcre-round2-fixtures' } },
    { name: 'app-phone', engine: web({ viewport: { width: 390, height: 844 }, locale: 'en-US', timezoneId: 'America/Chicago' }), app: { url, identity: 'doctorcre-round2-fixtures' } },
    { name: 'webkit-phone', engine: web({ browser: 'webkit', viewport: { width: 390, height: 844 }, locale: 'en-US', timezoneId: 'America/Chicago' }), app: { url, identity: 'doctorcre-round2-fixtures' } },
    { name: 'firefox-phone', engine: web({ browser: 'firefox', viewport: { width: 390, height: 844 }, locale: 'en-US', timezoneId: 'America/Chicago' }), app: { url, identity: 'doctorcre-round2-fixtures' } },
  ],
  agents: {
    default: persona,
    joe: { ...persona, system: 'You are Joe reviewing your owned work and handing off to Dell. Verify the recorded outcome.' },
    dell: { ...persona, system: 'You are Dell picking up a team handoff. Verify ownership and recorded context.' },
    skeptic: { ...persona, system: 'Check counts, dates, totals and claims against every other place they appear.' },
    newcomer: { ...persona, system: 'Use this area as a first-time broker. Verify navigation, recovery and task completion.' },
    state: { ...persona, system: 'Check state across reloads, navigation, filters and undo. Report the exact state that is lost.' },
    phone: { ...persona, system: 'Use a phone between showings. Check reachability, clipping, keyboard and return to task.' },
    scripted: { executor: scripted },
    'limited-loop': {
      model, providerOptions: { openai: { reasoningEffort: 'high' } }, context,
      executor: createToolLoopExecutor({
        name: 'read-and-navigate', system: 'Read the screen and use only the requested local route. Confirm the visible result.',
        buildPrompt: ctx => ctx.step.instruction,
        tools: (ctx, { guard }) => ({
          read_screen: tool({ description: 'Read the current screen', inputSchema: z.object({}), execute: () => guard(async () => (await ctx.observe()).text) }),
          open_route: tool({ description: 'Open an app-relative route', inputSchema: z.object({ path: z.string().refine(path => {
            try { return path.startsWith('/') && new URL(path, url).origin === new URL(url).origin; }
            catch { return false; }
          }, 'Route must stay on the fixture origin') }), execute: ({ path }) => guard(async () => { await ctx.actions.navigate(path); return 'Route opened'; }) }),
        }),
      }),
    },
  },
  reporters: ['list', 'junit', 'markdown'],
} satisfies E2EConfig;
