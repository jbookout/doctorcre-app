import type { E2EConfig } from 'e2e';
import { github } from '@e2e-dev/github';
import { chatgpt } from 'e2e/oauth/chatgpt';
import base from './e2e.config.ts';
import { stagingWeb } from './scripts/e2e-staging/engine.mjs';
import { STAGING_ORIGIN, readSessionSecretSync } from './scripts/e2e-staging/session.mjs';

// Signed-in end-to-end suite against the deployed DoctorCRE staging Worker.
// Pattern: the bug-bash config from `npx e2e guide bug-bash` (spread the base,
// point at a running app, declare no command). Staging is ours and disposable,
// so destructive controls are in scope; the engine guard aborts every request
// that leaves the staging origin, so nothing reaches production.

const shared: E2EConfig = base;
const ci = !['', '0', 'false'].includes(process.env.CI ?? '');
const model = chatgpt(process.env.E2E_AGENT_MODEL ?? 'gpt-6-luna');
const app = { url: STAGING_ORIGIN, environment: 'staging' as const, identity: 'doctorcre-staging' };

// Vocabulary the screens use, what staging cannot do, and the explorer's own blind spots.
const context = [
  'This is DoctorCRE, a healthcare commercial real estate workspace for two partners, Joe and Dell. The app persona is Dr. CRE (spoken nickname "Doc"); Quill is its dictation.',
  'You start signed in as the dedicated E2E Joe partner on the STAGING deployment. Never sign in, never navigate off the staging origin.',
  'Staging data is synthetic and disposable: delete, archive, park, send and undo are all allowed. Records named "E2E ..." are test fixtures.',
  'Staging has no microphone, no phone line, no outbound email and no local Call Mode service: a control that needs one may say so; that is not a bug unless it pretends to succeed.',
  'Other explorers share this one staging account at the same time: a record changing that you did not touch is not a bug. Never press Sign out (it would end the shared session).',
  'Not bugs: a link that opens a new tab leaves this one unchanged; accessible text splits around inline links, so judge copy by the rendered screen; lazy content loads when scrolled into view; a disabled control with a visible reason is intentional.',
].join(' ');

const persona = { model, maxSteps: 40, maxModelCalls: 40, judgmentTimeout: 60_000, context };

export default {
  ...shared,
  tests: ['tests/staging/**/*.e2e.ts'],
  timeout: 300_000,
  assertionTimeout: 15_000,
  retries: 0,
  workers: 1,
  // Local runs record verified agent.act steps; CI replays only.
  // E2E_CACHE_DIR lets one run record into a fresh store (cold vs warm demonstration, docs/cache.mdx).
  cache: { mode: ci ? 'read-only' : 'read-write', dir: process.env.E2E_CACHE_DIR || '.e2e/cache' },
  trace: 'retain-on-failure',
  video: 'retain-on-failure',
  reporters: ci ? ['list', 'junit', github({ key: 'staging' })] : ['list'],
  targets: [
    { name: 'staging', engine: stagingWeb({ browser: 'chromium', viewport: { width: 1440, height: 960 } }), app },
    { name: 'staging-phone', engine: stagingWeb({ browser: 'chromium', viewport: { width: 390, height: 844 } }), app },
  ],
  // The session-exchange bearer is a registered secret: any echo of it in a
  // report, trace text or model input is rewritten to <secret:staging-e2e-session>.
  // It is never filled into the page, so screenshots stay available.
  secrets: { 'staging-e2e-session': readSessionSecretSync() },
  agents: {
    default: persona,
    skeptic: { ...persona, system: 'Distrust every number, date, count, status and claim on screen; cross-check each against every other place it appears in the app.' },
    fuzzer: { ...persona, system: 'At every input, run the goal\'s input matrix (empty, a 300-character value, unicode, leading spaces, literal <>&") before anything else, judging each entry before the next. Never take the happy path.' },
    newcomer: { ...persona, maxInputTokens: 128_000, system: 'You are a first-time partner. Try to accomplish the goal from what the screen says alone; report anything confusing, unlabeled, dead or inconsistent.' },
    destroyer: { ...persona, system: 'Create, change, delete, archive and undo; reload and go back after each; report state that is lost, stale, duplicated or not undoable.' },
  },
} satisfies E2EConfig;
