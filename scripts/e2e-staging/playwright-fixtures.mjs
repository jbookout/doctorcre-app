import { currentRun, requireSupervisedRun, RUN_LIMITS } from './run-limits.mjs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { test as base } from 'playwright/test';

import { SweepFailure } from './controls.mjs';
import { installStagingGuard } from './engine.mjs';
import { prepareCalendarRecord } from './calendar-coverage.mjs';
import { targets } from './screens.mjs';
import { stagingRelease, stagingSession, SessionPreflightFailure, STAGING_ORIGIN } from './session.mjs';

const sameRelease = (left, right) => left?.source_commit === right?.source_commit && left?.carr_source_commit === right?.carr_source_commit;

export function createFreshPageFactory({ browser, origin = STAGING_ORIGIN, installGuard = installStagingGuard, releaseProbe }) {
  const run = currentRun();
  const contexts = new Set();
  const guards = new Set();
  const freshPage = async ({ target, screen, release, fixtureGuard, path = screen.path, spec }) => {
    run?.check();
    let context, phase = 'session-preflight', code = 'session-preflight-failed';
    try {
      if (!sameRelease(await releaseProbe(), release)) throw new SweepFailure('session-preflight', 'source-pair-changed');
      phase = 'context'; code = 'context-creation-failed';
      context = await browser.newContext(target ? { viewport: target.viewport } : undefined);
      contexts.add(context);
      const removeStop = run?.onStop(() => context.close());
      context.on?.('close', () => removeStop?.());
      context.on?.('close', () => contexts.delete(context));
      code = 'guard-install-failed';
      await installGuard(context, fixtureGuard);
      if (fixtureGuard) guards.add(fixtureGuard);
      code = 'page-creation-failed';
      const page = await context.newPage();
      phase = 'navigation'; code = 'navigation-failed';
      const response = await page.goto(new URL(path, origin).href, { waitUntil: 'domcontentloaded', timeout: RUN_LIMITS.httpTimeoutMs });
      if (!response?.ok() || page.url().includes('/auth/') || new URL(page.url()).origin !== origin) throw new SweepFailure('navigation', 'screen-response-refused');
      phase = 'load'; code = 'network-idle-failed';
      await page.waitForLoadState('networkidle', { timeout: RUN_LIMITS.httpTimeoutMs });
      if (spec?.kind === 'calendar-record') await prepareCalendarRecord(page, spec);
      return page;
    } catch (error) {
      if (context) await context.close().catch(() => {});
      throw error instanceof SweepFailure ? error : new SweepFailure(phase, error instanceof SessionPreflightFailure ? error.code : code);
    }
  };
  return {
    freshPage,
    async dispose() {
      await Promise.all([...contexts].map(context => context.close().catch(() => {})));
      for (const guard of guards) await guard.assertCoverage();
    },
  };
}

const attachmentTypes = Object.freeze([
  ['controls.json', 'staging-controls', 'application/json'],
  ['coverage.md', 'staging-coverage', 'text/markdown'],
  ['findings.json', 'staging-findings', 'application/json'],
  ['sweep-verdict.json', 'staging-verdict', 'application/json'],
]);

export async function attachSweepArtifacts(testInfo, output) {
  for (const [file, name, contentType] of attachmentTypes) {
    const path = join(output, file);
    try { await access(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await testInfo.attach(name, { path, contentType });
  }
}

export const test = base.extend({
  stagingTarget: async ({}, use, testInfo) => {
    const target = targets.find(row => row.name === testInfo.project.metadata.stagingTarget);
    if (!target) throw new Error('Playwright staging project does not name a registered target');
    await use(target);
  },
  freshPage: async ({ browser, request }, use) => {
    const fixture = createFreshPageFactory({ browser, releaseProbe: () => stagingRelease(request) });
    try { await use(fixture.freshPage); }
    finally { await fixture.dispose(); }
  },
  stagingSession: async ({ request }, use) => {
    await use(origin => {
      const run = requireSupervisedRun();
      return stagingSession(origin, { requestContext: request, exchange: false, run });
    });
  },
});
